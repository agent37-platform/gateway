import { statSync } from 'node:fs';
import { Router } from 'express';
import {
  REASONING_EFFORTS,
  RESPONSE_MODES,
  SUPPORTED_AGENTS,
} from '../../shared/types.js';
import { isRecord, optionalEnum, responseNotFound, validationError } from '../errors.js';
import { INSTANCE_DEFAULT_AGENT } from '../agent.js';
import { resolveHomeAwarePath } from '../paths.js';
import { initSSE, writeStreamEvent } from '../sse.js';
import { attach, hasRun } from '../live-runs.js';
import { getResponse, setResponseStatus } from '../response-store.js';
import {
  beginResponse,
  cancelResponse,
  driveResponse,
  synthesizeStreamEvents,
  type ResponseRequest,
} from '../responses.js';

export const responsesRouter = Router();

// A non-streaming turn only sends its response headers when the turn finishes, but every
// hop to the client caps how long it waits for headers (~100s at Cloudflare's edge) — which
// used to kill stream:false turns longer than that. So the route commits headers immediately
// and ticks a whitespace heartbeat while the turn runs: leading whitespace before a JSON
// document is still valid JSON (RFC 8259), so clients parse the body unchanged.
const NONSTREAM_HEARTBEAT_MS = Number(process.env.GATEWAY_NONSTREAM_HEARTBEAT_MS) || 25_000;

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${field} must be a non-empty string.`, field);
  }
  return value;
}

/** Validate `files` attachment paths: each must name an existing regular file
 *  on this instance. Returns resolved absolute paths. */
function parseFiles(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.trim())) {
    throw validationError('files must be an array of file paths.', 'files');
  }
  return value.map((p: string) => {
    const path = resolveHomeAwarePath(p);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw validationError(`files entry '${p}' does not exist on this instance.`, 'files', 'Upload it first via PUT /v1/files/content.');
    }
    if (!stats.isFile()) throw validationError(`files entry '${p}' is not a file.`, 'files');
    return path;
  });
}

/** Append attachment paths to the message the same way minions does — the
 *  agent reads them from disk (its cwd is the workspace). */
function withAttachedFiles(input: string, files: string[]): string {
  if (files.length === 0) return input;
  return `${input}\n\n[Attached files:\n${files.map((p) => `- ${p}`).join('\n')}]`;
}

function parseResponseBody(body: unknown): { request: ResponseRequest; stream: boolean } {
  const b = isRecord(body) ? body : {};

  const input = b.input;
  if (typeof input !== 'string' || !input.trim()) {
    throw validationError('input is required and must be a non-empty string.', 'input');
  }

  const files = parseFiles(b.files);

  let sessionId: string | undefined;
  if (b.session_id !== undefined && b.session_id !== null) {
    if (typeof b.session_id !== 'string' || !b.session_id) {
      throw validationError('session_id must be a string.', 'session_id');
    }
    sessionId = b.session_id;
  }

  const agent = optionalEnum(b.agent, 'agent', SUPPORTED_AGENTS, INSTANCE_DEFAULT_AGENT);

  const mode = optionalEnum(b.mode, 'mode', RESPONSE_MODES, 'chat');
  if (mode === 'goal') {
    throw validationError('goal mode is not yet supported on this gateway.', 'mode', 'Use mode "chat".');
  }

  const model = optionalString(b.model, 'model');
  const provider = optionalString(b.provider, 'provider');

  const reasoningEffort = optionalEnum(b.reasoning_effort, 'reasoning_effort', REASONING_EFFORTS, null);

  let metadata: Record<string, unknown> | null = null;
  if (b.metadata !== undefined && b.metadata !== null) {
    if (!isRecord(b.metadata)) throw validationError('metadata must be an object.', 'metadata');
    if (Object.keys(b.metadata).length > 16) {
      throw validationError('metadata supports at most 16 key/value pairs.', 'metadata');
    }
    if (JSON.stringify(b.metadata).length > 64 * 1024) {
      throw validationError('metadata is too large (max 64KB serialized).', 'metadata');
    }
    metadata = b.metadata;
  }

  // instance_id is accepted for client compatibility and ignored: routing to a
  // container is the Cloud layer's job; inside the container there is one gateway.

  return {
    request: {
      sessionId,
      input: withAttachedFiles(input, files),
      agent,
      model,
      provider,
      reasoningEffort,
      metadata,
    },
    stream: b.stream === true,
  };
}

// POST /v1/responses — run a turn (start a session or continue one).
responsesRouter.post('/', async (req, res, next) => {
  let begun;
  let request: ResponseRequest;
  let stream: boolean;
  try {
    const parsed = parseResponseBody(req.body);
    request = parsed.request;
    stream = parsed.stream;
    begun = beginResponse(request);
  } catch (error) {
    return next(error);
  }

  if (stream) {
    initSSE(res);
    attach(begun.responseId, res); // replays the buffered response.created, then goes live
    void driveResponse(begun, request.input).catch((error) => {
      console.error('driveResponse crashed:', error);
      try {
        res.end();
      } catch {
        // already closed
      }
    });
    return;
  }

  // Non-streaming: commit 200 before driving the turn — beginResponse has succeeded, and
  // from here on agent failures are encoded as status:"failed" in the body by contract.
  // Once headers are flushed, res.json() would throw and the app-level error handler can
  // only defer, so the body is written manually and errors are settled right here.
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(' ');
  }, NONSTREAM_HEARTBEAT_MS);
  heartbeat.unref();
  res.on('close', () => clearInterval(heartbeat));
  try {
    const response = await driveResponse(begun, request.input);
    if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify(response));
  } catch (error) {
    // driveResponse never rejects by contract (agent failures resolve as failed
    // responses); this is the same last resort the stream branch has.
    console.error('driveResponse crashed:', error);
    setResponseStatus(begun.responseId, 'failed');
    if (!res.writableEnded && !res.destroyed) {
      res.end(
        JSON.stringify({
          id: begun.responseId,
          session_id: begun.sessionId,
          status: 'failed',
          agent: begun.agent,
          model: begun.model,
          provider: begun.provider,
          output_text: '',
          usage: null,
          error: { code: 'internal_error', message: 'Something went wrong.' },
          metadata: null,
          created: Date.now(),
        }),
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
});

// GET /v1/responses/:id/stream — reconnect: replay a snapshot, then resume live.
responsesRouter.get('/:id/stream', (req, res, next) => {
  const id = req.params.id;

  if (!hasRun(id)) {
    const stored = getResponse(id);
    if (!stored) return next(responseNotFound(id));
    // The live run expired from memory; replay a snapshot from stored state.
    initSSE(res);
    for (const event of synthesizeStreamEvents(stored)) writeStreamEvent(res, event);
    res.end();
    return;
  }

  initSSE(res);
  if (attach(id, res) === 'finished') res.end();
});

// POST /v1/responses/:id/cancel — stop a running turn.
responsesRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const response = await cancelResponse(req.params.id);
    res.json(response);
  } catch (error) {
    next(error);
  }
});

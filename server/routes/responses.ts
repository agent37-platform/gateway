import { Router } from 'express';
import {
  DEFAULT_AGENT,
  REASONING_EFFORTS,
  RESPONSE_MODES,
  SUPPORTED_AGENTS,
} from '../../shared/types.js';
import { isRecord, responseNotFound, validationError } from '../errors.js';
import { initSSE, writeStreamEvent } from '../sse.js';
import { attach, hasRun } from '../live-runs.js';
import { getResponse, setResponseStatus } from '../db/queries.js';
import {
  beginResponse,
  cancelResponse,
  driveResponse,
  synthesizeStreamEvents,
  type ResponseRequest,
} from '../responses.js';

export const responsesRouter = Router();

// A non-streaming turn sends its response headers only when the turn finishes, and every
// hop to the client caps how long it will wait for headers (~100s at Cloudflare's edge,
// not configurable) — which used to kill stream:false turns longer than that. So the
// route commits its headers immediately and ticks a whitespace heartbeat while the turn
// runs: leading whitespace before a JSON document is valid JSON (RFC 8259), so clients
// parse the body unchanged. Env override exists so tests can tighten the cadence; the
// 50ms floor keeps a typo'd value from becoming a whitespace flood (Node clamps NaN/0
// intervals to 1ms).
const heartbeatEnv = parseInt(process.env.GATEWAY_NONSTREAM_HEARTBEAT_MS || '', 10);
const NONSTREAM_HEARTBEAT_MS = Number.isFinite(heartbeatEnv) && heartbeatEnv >= 50 ? heartbeatEnv : 25_000;

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${field} must be a non-empty string.`, field);
  }
  return value;
}

/** An optional field constrained to a fixed set: absent → `fallback`, present →
 *  validated against `allowed` (throws otherwise). */
function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T;
function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: null): T | null;
function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T | null,
): T | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationError(`${field} must be one of: ${allowed.join(', ')}.`, field);
  }
  return value as T;
}

function parseResponseBody(body: unknown): { request: ResponseRequest; stream: boolean } {
  const b = isRecord(body) ? body : {};

  const input = b.input;
  if (typeof input !== 'string' || !input.trim()) {
    throw validationError('input is required and must be a non-empty string.', 'input');
  }

  let sessionId: string | undefined;
  if (b.session_id !== undefined && b.session_id !== null) {
    if (typeof b.session_id !== 'string' || !b.session_id) {
      throw validationError('session_id must be a string.', 'session_id');
    }
    sessionId = b.session_id;
  }

  const agent = optionalEnum(b.agent, 'agent', SUPPORTED_AGENTS, DEFAULT_AGENT);

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
    request: { sessionId, input, agent, model, provider, reasoningEffort, metadata },
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
    // responses); this is the same last resort the stream branch has. Settle the stored
    // row too, so a later GET /v1/responses/:id agrees with the body written below.
    console.error('driveResponse crashed:', error);
    try {
      setResponseStatus(begun.responseId, 'failed');
    } catch {
      // the row may be unreachable for the same reason driveResponse crashed
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end(
        JSON.stringify({
          id: begun.responseId,
          session_id: begun.sessionId,
          status: 'failed',
          agent: request.agent,
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

// GET /v1/responses/:id — fetch a response by id.
responsesRouter.get('/:id', (req, res, next) => {
  const response = getResponse(req.params.id);
  if (!response) return next(responseNotFound(req.params.id));
  res.json(response);
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

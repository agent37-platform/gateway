// Turn orchestration: the glue between an incoming request, the agent adapter,
// the live SSE registry, and the in-memory response store.
//
//   beginResponse  — synchronously validate, register the response, register the
//                    live run, emit created. The harness owns the session id.
//   driveResponse  — async: consume the agent stream, emit documented SSE
//                    events, accumulate, then record the terminal state.

import type { AgentRunSettings, StreamEvent } from './adapters/types.js';
import type {
  AgentType,
  ApiError,
  ReasoningEffort,
  ResponseObject,
  ResponseStatus,
  ResponseStreamEvent,
  TurnUsage,
} from '../shared/types.js';
import { getAdapter } from './agent.js';
import {
  activeResponseForSession,
  createRun,
  emit,
  markFinished,
} from './live-runs.js';
import {
  finalizeResponse,
  getResponse,
  insertResponse,
} from './response-store.js';
import {
  apiErrorFromStreamEvent,
  apiErrorFromUnknown,
  responseNotFound,
  sessionBusy,
} from './errors.js';
import { newResponseId, newSessionId } from './ids.js';

export interface ResponseRequest {
  sessionId?: string;
  input: string;
  agent: AgentType;
  model: string | null;
  provider: string | null;
  reasoningEffort: ReasoningEffort | null;
  metadata: Record<string, unknown> | null;
}

export interface BegunResponse {
  responseId: string;
  sessionId: string;
  agent: AgentType;
  settings: AgentRunSettings;
  model: string | null;
  provider: string | null;
}

/**
 * Validate the request, register the in-memory response, and start the live
 * run. The session id is a stateless handle the harness owns (create-on-first-
 * use); the caller names the harness via `agent` on every turn, so there is no
 * gateway-side session index. Synchronous so the one-active-turn-per-session
 * check is atomic. Throws GatewayError.
 */
export function beginResponse(req: ResponseRequest): BegunResponse {
  const sessionId = req.sessionId ?? newSessionId();
  const agent = req.agent;

  if (activeResponseForSession(sessionId)) throw sessionBusy();

  const responseId = newResponseId();
  insertResponse({
    id: responseId,
    session_id: sessionId,
    agent,
    model: req.model,
    provider: req.provider,
    metadata: req.metadata,
  });

  createRun(responseId, sessionId);
  emit(responseId, { event: 'response.created', data: { id: responseId, session_id: sessionId } });

  const settings: AgentRunSettings = {
    model: req.model ?? undefined,
    provider: req.provider ?? undefined,
    reasoningEffort: req.reasoningEffort ?? undefined,
  };

  return { responseId, sessionId, agent, settings, model: req.model, provider: req.provider };
}

function emitToolProgress(responseId: string, event: StreamEvent): void {
  const tool = event.tool ?? 'tool';
  if (event.status === 'completed') {
    emit(responseId, { event: 'response.tool_call.completed', data: { tool, duration_ms: event.duration } });
  } else if (event.status === 'error') {
    emit(responseId, { event: 'response.tool_call.failed', data: { tool, error: event.label } });
  } else {
    emit(responseId, { event: 'response.tool_call.started', data: { tool, label: event.label } });
  }
}

/**
 * Run the turn to completion: stream from the agent, emit SSE events into the
 * live run, accumulate output/usage/error, persist the terminal state, and
 * resolve with the final response. Never rejects for agent/stream failures —
 * those become a `failed` response.
 */
export async function driveResponse(begun: BegunResponse, input: string): Promise<ResponseObject> {
  const { responseId, sessionId, agent, settings, model, provider } = begun;

  let outputText = '';
  let usage: TurnUsage | null = null;
  let apiError: ApiError | null = null;
  let status: ResponseStatus = 'completed';
  let sawTerminal = false;

  try {
    for await (const event of getAdapter(agent).chatStream(sessionId, input, { settings })) {
      switch (event.type) {
        case 'text_delta':
          if (event.content) {
            outputText += event.content;
            emit(responseId, { event: 'response.output_text.delta', data: { text: event.content } });
          }
          break;
        case 'thinking_delta':
          if (event.content) {
            emit(responseId, { event: 'response.reasoning.delta', data: { text: event.content } });
          }
          break;
        case 'tool_progress':
          emitToolProgress(responseId, event);
          break;
        case 'done':
          // The worker closes every turn with a trailing `done`, including
          // after an `error` event — a reported failure must stay failed.
          sawTerminal = true;
          if (status !== 'failed') {
            usage = event.usage ?? null;
            status = event.interrupted ? 'cancelled' : 'completed';
          }
          break;
        case 'error':
          sawTerminal = true;
          status = 'failed';
          apiError = apiErrorFromStreamEvent(event);
          break;
      }
    }
  } catch (error) {
    sawTerminal = true;
    status = 'failed';
    apiError = apiErrorFromUnknown(error, 'Agent chat stream failed', agent);
  }

  // A stream that ended without an explicit terminal event: treat what we have
  // as a completed turn rather than failing it.
  if (!sawTerminal) status = 'completed';

  if (status === 'failed' && apiError) {
    emit(responseId, { event: 'response.failed', data: { error: apiError } });
  } else {
    emit(responseId, { event: 'response.completed', data: { output_text: outputText, usage } });
  }

  // Record the terminal state, then release the session lock and end live
  // subscribers. The response store is an in-memory map, so neither call throws.
  finalizeResponse(responseId, { status, output_text: outputText, usage, error: apiError, model, provider });
  markFinished(responseId, status);

  return (
    getResponse(responseId) ?? {
      id: responseId,
      session_id: sessionId,
      status,
      agent,
      model,
      provider,
      output_text: outputText,
      usage,
      error: apiError,
      metadata: null,
      created: Date.now(),
    }
  );
}

/**
 * Request cancellation of a running turn. The interrupt is best-effort; the
 * running driveResponse unwinds and persists the terminal `cancelled` status.
 */
export async function cancelResponse(responseId: string): Promise<ResponseObject> {
  const response = getResponse(responseId);
  if (!response) throw responseNotFound(responseId);
  if (response.status === 'in_progress') {
    await getAdapter(response.agent).interruptChat(response.session_id);
  }
  return getResponse(responseId) ?? response;
}

/** Reconstruct a terminal response's stream from stored state, for reconnects
 *  after the live run has expired from memory. */
export function synthesizeStreamEvents(response: ResponseObject): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [
    { event: 'response.created', data: { id: response.id, session_id: response.session_id } },
  ];
  if (response.output_text) {
    events.push({ event: 'response.output_text.delta', data: { text: response.output_text } });
  }
  if (response.status === 'failed' && response.error) {
    events.push({ event: 'response.failed', data: { error: response.error } });
  } else {
    events.push({
      event: 'response.completed',
      data: { output_text: response.output_text, usage: response.usage },
    });
  }
  return events;
}

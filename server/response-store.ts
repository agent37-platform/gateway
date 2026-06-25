// In-memory store of response objects — the per-turn "receipt" (id, status,
// usage, error, echoed metadata) that the harness transcript doesn't carry.
//
// This replaces the old SQLite `responses` table. Instances are ephemeral and
// transcripts live in the harness, so a response only needs to be retrievable
// within this process's lifetime — for `/v1/responses/:id/stream` reconnect
// after the live buffer expires, and for cancel routing. Bounded by count and a
// TTL after the turn finishes so memory can't grow without limit; the only thing
// lost on restart is retrieval of an old response, which nothing depends on.

import type {
  AgentType,
  ApiError,
  ResponseObject,
  ResponseStatus,
  TurnUsage,
} from '../shared/types.js';

/** Hard cap on retained responses; oldest are evicted first. */
const MAX_RESPONSES = 1000;
/** How long a finished response stays retrievable after it settles. */
const RESPONSE_TTL_MS = 30 * 60_000;

const responses = new Map<string, ResponseObject>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearExpiry(id: string): void {
  const timer = expiryTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(id);
  }
}

/** Start the retention clock once a response reaches a terminal state. */
function scheduleExpiry(id: string): void {
  clearExpiry(id);
  const timer = setTimeout(() => {
    responses.delete(id);
    expiryTimers.delete(id);
  }, RESPONSE_TTL_MS);
  timer.unref();
  expiryTimers.set(id, timer);
}

export function insertResponse(input: {
  id: string;
  session_id: string;
  agent: AgentType;
  model?: string | null;
  provider?: string | null;
  metadata?: Record<string, unknown> | null;
}): void {
  // Map iteration is insertion-ordered, so the first key is the oldest entry.
  if (responses.size >= MAX_RESPONSES) {
    const oldest = responses.keys().next().value;
    if (oldest !== undefined) {
      responses.delete(oldest);
      clearExpiry(oldest);
    }
  }
  responses.set(input.id, {
    id: input.id,
    session_id: input.session_id,
    status: 'in_progress',
    agent: input.agent,
    model: input.model ?? null,
    provider: input.provider ?? null,
    output_text: '',
    usage: null,
    error: null,
    metadata: input.metadata ?? null,
    created: Date.now(),
  });
}

export function getResponse(id: string): ResponseObject | undefined {
  return responses.get(id);
}

export function finalizeResponse(
  id: string,
  fields: {
    status: ResponseStatus;
    output_text: string;
    usage: TurnUsage | null;
    error: ApiError | null;
    model: string | null;
    provider: string | null;
  },
): void {
  const response = responses.get(id);
  if (!response) return;
  response.status = fields.status;
  response.output_text = fields.output_text;
  response.usage = fields.usage;
  response.error = fields.error;
  response.model = fields.model;
  response.provider = fields.provider;
  scheduleExpiry(id);
}

export function setResponseStatus(id: string, status: ResponseStatus): void {
  const response = responses.get(id);
  if (!response) return;
  response.status = status;
  scheduleExpiry(id);
}

/** Clear timers for a clean process shutdown. */
export function shutdownResponseStore(): void {
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
  responses.clear();
}

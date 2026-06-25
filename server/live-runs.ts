import type { Response } from 'express';
import type { ResponseStatus, ResponseStreamEvent } from '../shared/types.js';
import { writeStreamEvent, writeComment } from './sse.js';

// In-memory registry of in-flight (and just-finished) responses. It buffers the
// ordered SSE events for each response so a dropped client can reconnect and
// replay everything so far, then resume live. Response metadata lives in the
// in-memory response-store; this is the ephemeral streaming layer.

interface LiveRun {
  responseId: string;
  sessionId: string;
  status: ResponseStatus;
  events: ResponseStreamEvent[];
  /** Set once the replay buffer hit its cap and stopped recording events. */
  truncated: boolean;
  finished: boolean;
  subscribers: Set<Response>;
  updatedAt: number;
}

/** Cap on buffered events per run, so a runaway agent can't exhaust the heap.
 *  Live subscribers still receive every event; only reconnect-replay is capped. */
const MAX_BUFFERED_EVENTS = 100_000;

const runs = new Map<string, LiveRun>();
/** sessionId -> responseId, only while that response is in_progress. */
const activeBySession = new Map<string, string>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const KEEPALIVE_INTERVAL_MS = 30_000;
/** How long a finished run lingers in memory so late clients can replay it. */
const FINISHED_TTL_MS = 60_000;

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    let anySubscribers = false;
    for (const run of runs.values()) {
      for (const subscriber of run.subscribers) {
        anySubscribers = true;
        if (!writeComment(subscriber, 'keepalive')) run.subscribers.delete(subscriber);
      }
    }
    if (!anySubscribers && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref();
}

function clearExpiry(responseId: string): void {
  const timer = expiryTimers.get(responseId);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(responseId);
  }
}

export function createRun(responseId: string, sessionId: string): void {
  clearExpiry(responseId);
  runs.set(responseId, {
    responseId,
    sessionId,
    status: 'in_progress',
    events: [],
    truncated: false,
    finished: false,
    subscribers: new Set(),
    updatedAt: Date.now(),
  });
  activeBySession.set(sessionId, responseId);
}

/** Append an event to the buffer and fan it out to live subscribers. */
export function emit(responseId: string, event: ResponseStreamEvent): void {
  const run = runs.get(responseId);
  if (!run) return;

  if (run.events.length < MAX_BUFFERED_EVENTS) {
    run.events.push(event);
  } else if (!run.truncated) {
    run.truncated = true;
    console.warn(
      `Live run ${responseId} exceeded ${MAX_BUFFERED_EVENTS} buffered events; reconnect replay will be partial.`,
    );
  }
  run.updatedAt = Date.now();

  for (const subscriber of run.subscribers) {
    if (!writeStreamEvent(subscriber, event)) run.subscribers.delete(subscriber);
  }
}

/** Mark a run terminal: end its live subscribers and schedule its removal. */
export function markFinished(responseId: string, status: ResponseStatus): void {
  const run = runs.get(responseId);
  if (!run) return;
  run.status = status;
  run.finished = true;
  run.updatedAt = Date.now();
  if (activeBySession.get(run.sessionId) === responseId) {
    activeBySession.delete(run.sessionId);
  }
  for (const subscriber of run.subscribers) {
    try {
      subscriber.end();
    } catch {
      // already closed
    }
  }
  run.subscribers.clear();

  clearExpiry(responseId);
  const timer = setTimeout(() => {
    runs.delete(responseId);
    expiryTimers.delete(responseId);
  }, FINISHED_TTL_MS);
  timer.unref();
  expiryTimers.set(responseId, timer);
}

export type AttachResult = 'attached' | 'finished' | 'missing';

/**
 * Replay the buffered events to a fresh SSE client, then either keep it
 * subscribed for live events or signal that the run already finished (the
 * caller should end the response).
 */
export function attach(responseId: string, res: Response): AttachResult {
  const run = runs.get(responseId);
  if (!run) return 'missing';

  for (const event of run.events) {
    writeStreamEvent(res, event);
  }

  if (run.finished) return 'finished';

  run.subscribers.add(res);
  res.on('close', () => {
    run.subscribers.delete(res);
  });
  startKeepalive();
  return 'attached';
}

/** The in_progress response on a session, if any. */
export function activeResponseForSession(sessionId: string): string | undefined {
  return activeBySession.get(sessionId);
}

export function hasRun(responseId: string): boolean {
  return runs.has(responseId);
}

export function getRunStatus(responseId: string): ResponseStatus | undefined {
  return runs.get(responseId)?.status;
}

/** Clear timers for a clean process shutdown. */
export function shutdownLiveRuns(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
}

import type { Response } from 'express';
import type { ResponseStreamEvent } from '../shared/types.js';

/** Set the headers that begin a Server-Sent Events stream. */
export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// These return TRUE when the subscriber is still usable and FALSE only when the
// connection is genuinely dead. A `false` return from `res.write()` signals
// backpressure (the buffer is full) — the data is still queued and delivered, so
// it is NOT a failure. Only a throw, or an already-ended/destroyed stream, means
// the subscriber should be dropped. (Full drain-based flow control is overkill
// for a localhost gateway; we cap the per-run event buffer instead.)

/** Write one named SSE frame (`event:` + `data:`), per docs/agents-api/streaming. */
export function writeStreamEvent(res: Response, event: ResponseStreamEvent): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Write an SSE comment line (used for keepalives). */
export function writeComment(res: Response, text = ''): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`:${text}\n\n`);
    return true;
  } catch {
    return false;
  }
}

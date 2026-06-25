import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  base: string;
  close: () => Promise<void>;
}

/**
 * Boot the real Express app on an ephemeral port against a throwaway state dir.
 * Sets the gateway home BEFORE importing the app, so uploads/logs/workspace
 * resolve under the throwaway state dir.
 */
export async function startTestServer(): Promise<TestServer> {
  process.env.AGENT37_GATEWAY_HOME = mkdtempSync(join(tmpdir(), 'a37gw-test-'));
  process.env.NODE_ENV = 'test';

  const { default: app } = await import('../server/app.js');
  const { adapter } = await import('../server/agent.js');
  const { shutdownLiveRuns } = await import('../server/live-runs.js');

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      shutdownLiveRuns();
      await adapter.stop?.();
    },
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** A pull-based reader over an SSE fetch Response body. */
export class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';
  private queue: SseEvent[] = [];
  private done = false;

  constructor(res: Response) {
    if (!res.body) throw new Error('response has no body');
    this.reader = res.body.getReader();
  }

  /** Resolve the next SSE event, or null when the stream ends. */
  async next(): Promise<SseEvent | null> {
    while (this.queue.length === 0 && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
      const frames = this.buffer.split('\n\n');
      this.buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        if (!event) continue; // skip comments / keepalives
        const dataLine = frame.match(/^data: (.+)$/m)?.[1];
        this.queue.push({ event, data: dataLine ? JSON.parse(dataLine) : {} });
      }
    }
    return this.queue.shift() ?? null;
  }

  /** Read until an event matches the predicate (inclusive). Returns all read so far. */
  async until(predicate: (e: SseEvent) => boolean): Promise<SseEvent[]> {
    const collected: SseEvent[] = [];
    for (;;) {
      const event = await this.next();
      if (!event) return collected;
      collected.push(event);
      if (predicate(event)) return collected;
    }
  }

  /** Drain the rest of the stream. */
  async drain(): Promise<SseEvent[]> {
    const rest: SseEvent[] = [];
    for (;;) {
      const event = await this.next();
      if (!event) return rest;
      rest.push(event);
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      // already closed
    }
  }
}

export async function postJson(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

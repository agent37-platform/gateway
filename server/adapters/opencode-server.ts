// A thin client for `opencode serve`: OpenCode's local HTTP API plus its one
// `GET /global/event` Server-Sent-Events stream. It spawns the process, waits
// for the "listening" line, opens the event stream, and fans each event out to
// subscribers (demultiplexed per session by the adapter). The OpenCodeAdapter
// builds the AgentAdapter seam on top of this; nothing here is Agent37-specific.
//
// Unlike Codex (one short-lived stdio process per burst), OpenCode is a resident
// server the IdleChild keeps warm and kills after ~10 idle minutes, so a regular
// user gets warm turns and a casual one costs zero RAM. Requests carry HTTP
// basic auth (`opencode:<per-spawn password>`); the shared SQLite store can be
// locked while another OpenCode process (a user's TUI) boots, so a spawn that
// hits `database is locked` is retried by the adapter's start closure.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { StartedChild } from './idle-child.js';

// --- Protocol shapes (the subset the adapter reads) --------------------------

export interface OpenCodeSession {
  id: string;
  directory?: string;
  parentID?: string | null;
  title?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  time?: { created?: number; updated?: number };
}

export interface OpenCodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpenCodeAssistantMessage {
  id: string;
  role: 'assistant';
  parentID?: string;
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  time?: { created?: number; completed?: number };
  error?: OpenCodeErrorInfo | null;
}

export interface OpenCodeUserMessage {
  id: string;
  role: 'user';
  time?: { created?: number };
}

export type OpenCodeMessage = OpenCodeUserMessage | OpenCodeAssistantMessage;

export interface OpenCodePart {
  id: string;
  type: string; // text | reasoning | tool | step-start | step-finish | ...
  text?: string;
  tool?: string;
  state?: OpenCodeToolState;
}

export interface OpenCodeToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  title?: string;
  error?: string;
  time?: { start?: number; end?: number };
}

/** A tagged `{ name, data }` failure from a `session.error` event or an
 *  assistant message's `error` field. */
export interface OpenCodeErrorInfo {
  name: string;
  data?: { message?: string; statusCode?: number; providerID?: string };
}

export interface OpenCodeModel {
  id: string;
  name?: string;
  limit?: { context?: number };
  variants?: Record<string, unknown>;
}

export interface OpenCodeProvider {
  id: string;
  name?: string;
  source?: string;
  models: Record<string, OpenCodeModel>;
}

export interface OpenCodeProviders {
  providers: OpenCodeProvider[];
  default: Record<string, string>;
}

export interface OpenCodeMessageRow {
  info: OpenCodeMessage;
  parts: OpenCodePart[];
}

export interface OpenCodePromptResult {
  info: OpenCodeAssistantMessage;
  parts: OpenCodePart[];
}

/** One `GET /global/event` frame's payload: `{ type, properties }`. Frames we
 *  don't model (sync, heartbeat, plugin.added, …) still parse; the adapter
 *  filters by `type` and `properties.sessionID`. */
export interface OpenCodeEvent {
  type: string;
  properties?: { sessionID?: string; [key: string]: unknown };
}

export class OpenCodeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenCodeError';
  }
}

/** Thrown by the spawn when OpenCode's shared SQLite is locked (another
 *  OpenCode process is booting); the adapter's start closure retries it. */
export class OpenCodeLockedError extends Error {
  constructor() {
    super('opencode database is locked');
    this.name = 'OpenCodeLockedError';
  }
}

const READY_TIMEOUT_MS = Number(process.env.OPENCODE_READY_TIMEOUT_MS) || 30_000;
const LISTENING_RE = /listening on https?:\/\/[^:]+:(\d+)/i;

/** An ephemeral loopback port. There is a small TOCTOU window between closing
 *  this and OpenCode binding it; a collision surfaces as a spawn failure the
 *  start closure retries. `--port 0` is avoided because OpenCode reads it as
 *  "try 4096 first", which a user's terminal `opencode serve` may already hold. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not pick a free port'))));
    });
  });
}

export class OpenCodeClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly subscribers = new Set<(event: OpenCodeEvent) => void>();
  private readonly sseAbort = new AbortController();
  private closed = false;
  readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    port: number,
    password: string,
  ) {
    this.base = `http://127.0.0.1:${port}`;
    this.authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        this.closed = true;
        this.sseAbort.abort();
        this.subscribers.clear();
        resolve();
      });
    });
    child.stderr.on('data', () => {}); // keep the pipe drained
  }

  // --- Event stream ----------------------------------------------------------

  /** Open the single `/global/event` SSE connection and demultiplex frames to
   *  subscribers. Runs for the child's lifetime; a read error while the child
   *  is alive ends the loop (a turn still completes via its sync prompt call,
   *  just without live deltas). */
  startEventStream(): void {
    void this.readEvents();
  }

  private async readEvents(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/global/event`, {
        headers: { Authorization: this.authHeader, Accept: 'text/event-stream' },
        signal: this.sseAbort.signal,
      });
    } catch {
      return;
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let parsed: { payload?: OpenCodeEvent };
          try {
            parsed = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          const payload = parsed.payload;
          if (payload && typeof payload.type === 'string') {
            for (const notify of this.subscribers) notify(payload);
          }
        }
      }
    } catch {
      // aborted (stop) or a mid-stream read error — nothing more to demux.
    }
  }

  onEvent(cb: (event: OpenCodeEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  // --- HTTP ------------------------------------------------------------------

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) throw new OpenCodeError('opencode server is not running');
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { Authorization: this.authHeader };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    if (!res.ok) {
      let message = `opencode ${method} ${path} -> ${res.status}`;
      try {
        const problem = (await res.json()) as { message?: string; error?: string; data?: { message?: string } };
        message = problem.data?.message || problem.message || problem.error || message;
      } catch {
        // non-JSON body
      }
      throw new OpenCodeError(message, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  createSession(directory: string): Promise<OpenCodeSession> {
    return this.request('POST', '/session', { query: { directory }, body: {} });
  }

  getSession(sessionId: string): Promise<OpenCodeSession> {
    return this.request('GET', `/session/${sessionId}`);
  }

  listSessions(): Promise<OpenCodeSession[]> {
    return this.request('GET', '/session');
  }

  getMessages(sessionId: string): Promise<OpenCodeMessageRow[]> {
    return this.request('GET', `/session/${sessionId}/message`);
  }

  deleteSession(sessionId: string, directory?: string): Promise<unknown> {
    return this.request('DELETE', `/session/${sessionId}`, { query: { directory } });
  }

  renameSession(sessionId: string, title: string, directory?: string): Promise<unknown> {
    return this.request('PATCH', `/session/${sessionId}`, { query: { directory }, body: { title } });
  }

  abort(sessionId: string, directory?: string): Promise<unknown> {
    return this.request('POST', `/session/${sessionId}/abort`, { query: { directory } });
  }

  prompt(
    sessionId: string,
    directory: string | undefined,
    body: {
      agent: string;
      parts: Array<{ type: 'text'; text: string }>;
      model?: { providerID: string; modelID: string };
      variant?: string;
      system?: string;
    },
    signal?: AbortSignal,
  ): Promise<OpenCodePromptResult> {
    return this.request('POST', `/session/${sessionId}/message`, { query: { directory }, body, signal });
  }

  getProviders(): Promise<OpenCodeProviders> {
    return this.request('GET', '/config/providers');
  }

  getConfig(): Promise<{ model?: string }> {
    return this.request('GET', '/config');
  }

  async health(): Promise<boolean> {
    try {
      const body = await this.request<{ healthy?: boolean }>('GET', '/global/health');
      return body?.healthy === true;
    } catch {
      return false;
    }
  }

  kill(): void {
    this.closed = true;
    this.sseAbort.abort();
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Spawn `opencode serve` on a fresh loopback port, wait for the listening
 *  line, open the event stream, and return a started child for the IdleChild
 *  pool. Throws (with `.code = 'ENOENT'`) when the binary is missing so the
 *  adapter can surface `503 agent_unavailable`, and `OpenCodeLockedError` when
 *  the store is locked so the start closure can retry. */
export async function spawnOpenCodeClient(bin: string, cwd: string): Promise<StartedChild<OpenCodeClient>> {
  const port = await freePort();
  const password = randomBytes(18).toString('hex');
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      // Inline config wins over files, so the managed/user config in
      // ~/.config/opencode still supplies providers, model, and MCP; this only
      // pins the sandbox posture (run tools unprompted; never block on a
      // question) to match the other harnesses.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { '*': 'allow', question: 'deny' },
        autoupdate: false,
        share: 'disabled',
      }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await waitForListening(child);
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    throw error;
  }

  const client = new OpenCodeClient(child, port, password);
  client.startEventStream();
  return { value: client, kill: () => client.kill(), exited: client.exited };
}

/** Resolve once OpenCode prints its "listening" line; reject on early exit
 *  (ENOENT for a missing binary, OpenCodeLockedError for a locked store) or the
 *  readiness timeout. */
function waitForListening(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderrTail = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const scan = (text: string): void => {
      if (LISTENING_RE.test(text)) finish();
    };
    const onStdout = (chunk: Buffer): void => scan(chunk.toString());
    const onStderr = (chunk: Buffer): void => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      scan(stderrTail);
      if (/database is locked/i.test(stderrTail)) finish(new OpenCodeLockedError());
    };
    const onExit = (): void => {
      if (/database is locked/i.test(stderrTail)) finish(new OpenCodeLockedError());
      else finish(new Error(`opencode serve exited before listening.${stderrTail.trim() ? ` ${stderrTail.trim()}` : ''}`));
    };
    const onError = (error: NodeJS.ErrnoException): void => finish(error);
    const timer = setTimeout(() => finish(new Error(`opencode serve did not start within ${READY_TIMEOUT_MS}ms`)), READY_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

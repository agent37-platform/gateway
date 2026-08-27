// A thin client for `codex app-server --listen stdio://`: newline-delimited
// JSON-RPC 2.0 over the child's stdin/stdout. It spawns the process, does the
// initialize handshake, correlates request/response by id, and fans server
// notifications out to subscribers. The CodexAdapter builds the AgentAdapter
// seam on top of this; nothing here is Agent37-specific.
//
// The app-server schema is versioned per Codex release and labelled
// experimental. Only the ~dozen shapes used below are typed; regenerate them
// with `codex app-server generate-json-schema` (v2) on every CODEX_VERSION bump
// and re-check.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { AsyncQueue, type StartedChild } from './idle-child.js';

// --- Protocol shapes (subset) -------------------------------------------------

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'externalSandbox'; networkAccess?: boolean }
  | { type: 'readOnly'; networkAccess?: boolean };

export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  turns?: CodexTurn[];
}

export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: CodexTurnError | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items?: CodexItem[];
}

export interface CodexTurnError {
  message: string;
  additionalDetails?: string | null;
  // A string enum ("unauthorized", "badRequest", …) or a tagged object
  // ({ responseStreamDisconnected: { httpStatusCode } }, …) or "other".
  codexErrorInfo?: unknown;
}

export interface CodexItem {
  type: string;
  id: string;
  // agentMessage
  text?: string;
  // userMessage
  content?: Array<{ type: string; text?: string }>;
  // reasoning
  summary?: string[];
  // commandExecution
  command?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  // fileChange
  changes?: Array<{ path?: string }>;
  // mcpToolCall
  server?: string;
  tool?: string;
  // webSearch
  query?: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort?: string;
}

export interface CodexAccount {
  type: 'apiKey' | 'chatgpt' | string;
  email?: string | null;
}

export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningOutputTokens?: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface Notification {
  method: string;
  params: Record<string, unknown> & { threadId?: string; turnId?: string };
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const CLIENT_INFO = { name: 'agent37-gateway', title: 'Agent37 Gateway', version: '1' };
// A control RPC (initialize, thread/*, model/list, account/read, turn/start's
// ack) must answer promptly; without a cap a child that stays alive but never
// replies would hang the HTTP response and hold the session lock open.
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_REQUEST_TIMEOUT_MS) || 60_000;
// A running turn streams notifications continuously (deltas, tool progress); if
// none arrives for this long the turn is treated as stalled and the stream ends
// so the session lock releases. Generous so a legitimately long silent tool run
// isn't cut off.
const TURN_IDLE_MS = Number(process.env.CODEX_TURN_IDLE_MS) || 300_000;

export class CodexError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = 'CodexError';
  }
}

export class CodexClient {
  private nextId = 1;
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>();
  private readonly subscribers = new Set<(n: Notification) => void>();
  // Threads this process has created or resumed. Tied to the client instance:
  // when the idle child is killed and respawned, a fresh (empty) set forces a
  // resume, so a continuing turn on a cold process reloads the rollout.
  private readonly loaded = new Set<string>();
  private readonly rl: Interface;
  private closed = false;
  readonly exited: Promise<void>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        this.closed = true;
        // Fail every awaiting request and close every open turn stream.
        for (const resolver of this.pending.values()) {
          resolver({ id: -1, error: { code: -1, message: 'codex app-server exited' } });
        }
        this.pending.clear();
        for (const notify of this.subscribers) {
          notify({ method: 'app-server/exit', params: {} });
        }
        this.subscribers.clear();
        resolve();
      });
    });
    // Draining stderr keeps the pipe from filling; the content is only useful
    // when debugging a spawn that never handshakes.
    child.stderr.on('data', () => {});
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcResponse & Partial<Notification>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const resolver = this.pending.get(message.id);
      if (resolver) {
        this.pending.delete(message.id);
        resolver(message as JsonRpcResponse);
      }
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      const notification: Notification = { method: message.method, params: (message.params ?? {}) as Notification['params'] };
      for (const notify of this.subscribers) notify(notification);
    }
    // Server-initiated requests (approvals) never arrive: approvalPolicy is
    // "never" and the sandbox is danger-full-access, so there is nothing to ask.
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new CodexError('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError(`codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        if (res.error) reject(new CodexError(res.error.message, res.error.code));
        else resolve(res.result as T);
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  onNotification(cb: (n: Notification) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** The handshake: initialize, then the `initialized` notification. */
  async handshake(): Promise<void> {
    await this.request('initialize', { clientInfo: CLIENT_INFO });
    this.notify('initialized');
  }

  // --- High-level calls (typed to the subset the adapter uses) ---------------

  async startThread(cwd: string): Promise<CodexThread> {
    const res = await this.request<{ thread: CodexThread }>('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    this.loaded.add(res.thread.id);
    return res.thread;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request('thread/resume', { threadId });
    this.loaded.add(threadId);
  }

  /** Load a thread's rollout into this process if it isn't already, so a turn,
   *  read, or rename can act on it. Throws CodexError when Codex has no rollout
   *  for the id. */
  async ensureLoaded(threadId: string): Promise<void> {
    if (this.loaded.has(threadId)) return;
    await this.resumeThread(threadId);
  }

  async listThreads(): Promise<CodexThread[]> {
    const res = await this.request<{ data: CodexThread[] }>('thread/list', {
      limit: 200,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
    });
    return res.data ?? [];
  }

  async readThread(threadId: string): Promise<CodexThread> {
    const res = await this.request<{ thread: CodexThread }>('thread/read', { threadId, includeTurns: true });
    return res.thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request('thread/delete', { threadId });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.request('thread/name/set', { threadId, name });
  }

  async listModels(): Promise<CodexModel[]> {
    const res = await this.request<{ data: CodexModel[] }>('model/list', { includeHidden: false });
    return res.data ?? [];
  }

  async readAccount(): Promise<CodexAccount | null> {
    const res = await this.request<{ account: CodexAccount | null }>('account/read', {});
    return res.account ?? null;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  /** Start a turn and stream this turn's notifications until it completes. The
   *  turn id is available via `onTurnId` once `turn/start` returns, so the
   *  adapter can interrupt it. */
  async *runTurn(
    threadId: string,
    input: string,
    opts: { effort?: string; model?: string; sandboxPolicy: SandboxPolicy },
    onTurnId: (turnId: string) => void,
  ): AsyncIterable<Notification> {
    const queue = new AsyncQueue<Notification>();
    // Watchdog: a turn that goes silent (no notification) for too long is
    // treated as stalled and the stream is ended, releasing the session lock.
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => queue.end(), TURN_IDLE_MS);
      idleTimer.unref();
    };
    const unsubscribe = this.onNotification((n) => {
      if (n.method === 'app-server/exit') {
        queue.end();
        return;
      }
      if (n.params.threadId === threadId) {
        resetIdle();
        queue.push(n);
      }
    });
    resetIdle();
    try {
      const res = await this.request<{ turn: CodexTurn }>('turn/start', {
        threadId,
        input: [{ type: 'text', text: input }],
        approvalPolicy: 'never',
        sandboxPolicy: opts.sandboxPolicy,
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });
      const turnId = res.turn.id;
      onTurnId(turnId);
      for await (const n of queue) {
        // Only this turn's notifications (a shared thread can interleave).
        if (n.params.turnId && n.params.turnId !== turnId) continue;
        yield n;
        if (n.method === 'turn/completed' && (n.params.turn as CodexTurn | undefined)?.id === turnId) break;
      }
    } finally {
      clearTimeout(idleTimer);
      unsubscribe();
    }
  }

  kill(): void {
    this.closed = true;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Spawn `codex app-server`, complete the handshake, and return a started child
 *  for the IdleChild pool. Throws (with `.code = 'ENOENT'`) when the binary is
 *  missing, so the adapter can surface `503 agent_unavailable`. */
export async function spawnCodexClient(bin: string, cwd: string): Promise<StartedChild<CodexClient>> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw error;
  }
  const spawnError = new Promise<never>((_, reject) => {
    child.once('error', reject);
  });
  const client = new CodexClient(child);
  try {
    await Promise.race([client.handshake(), spawnError]);
  } catch (error) {
    client.kill();
    throw error;
  }
  return { value: client, kill: () => client.kill(), exited: client.exited };
}

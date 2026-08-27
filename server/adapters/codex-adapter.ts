import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import type {
  AgentDefaults,
  AgentModelsResponse,
  HermesMessage,
  ReasoningEffort,
  SessionMetadata,
  SessionSummary,
  TurnUsage,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, ContextUsage, StreamEvent } from './types.js';
import { epochMillis } from './types.js';
import { resolveWorkspaceDir } from '../paths.js';
import { validationError } from '../errors.js';
import { IdleChild } from './idle-child.js';
import {
  CodexClient,
  CodexError,
  spawnCodexClient,
  type CodexItem,
  type CodexModel,
  type CodexThread,
  type CodexTurn,
  type CodexTurnError,
  type ThreadTokenUsage,
} from './codex-app-server.js';

// The adapter drives Codex through `codex app-server` (JSON-RPC over stdio),
// one process per burst of calls that lingers a few seconds so a UI burst
// (list + read + turn) reuses it, then falls to zero RAM. A gateway session id
// IS a Codex thread id: the harness store owns the id, so the responses route
// calls `resolveSession` before a response begins (create-on-first-turn, or
// verify an existing thread). Threads, history, rename, and delete all go
// through Codex's own store — the gateway keeps no index. Credentials are
// Codex's own (`codex login` on the box, or the image's boot script writing
// auth from OPENAI_API_KEY); the gateway never reads them.

const HEALTHY_TTL_MS = 60_000;
const UNHEALTHY_TTL_MS = 10_000;
// After turn/interrupt, how long Codex gets to close the turn before the child
// is killed outright (interrupt is fast in practice; this is the backstop).
const INTERRUPT_GRACE_MS = 5_000;
// How long the app-server lingers after the last call before it is killed.
const IDLE_MS = Number(process.env.CODEX_IDLE_MS) || 30_000;
const LOGIN_HINT =
  'Run `codex login --device-auth` in the instance terminal, or set OPENAI_API_KEY in the environment.';

// Our public effort ladder → Codex's `turn/start.effort`. Codex advertises
// low/medium/high/xhigh (plus max/ultra on its top models) and has no
// none/minimal, so both floor to `low`; `ultra` is Codex's multi-agent mode
// (our harness Ultra). The nominal value is clamped at call time to the target
// model's advertised list (clampEffort) so a weaker model never rejects a turn.
const EFFORT_MAP: Record<ReasoningEffort, string> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
};

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** The Codex effort one reasoning level maps to (before per-model clamping).
 *  Exported for the mapping tests. */
export function codexEffort(effort: ReasoningEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  return EFFORT_MAP[effort];
}

/** Clamp a nominal effort to a model's advertised set: the value itself if
 *  listed, else the highest listed value below it, else the model's lowest. */
function clampEffort(nominal: string | undefined, supported: string[] | undefined): string | undefined {
  if (!nominal || !supported || supported.length === 0) return nominal;
  if (supported.includes(nominal)) return nominal;
  const idx = EFFORT_LADDER.indexOf(nominal);
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
  }
  for (const level of EFFORT_LADDER) if (supported.includes(level)) return level;
  return nominal;
}

// The Codex thread-item types we surface as tool progress, mapped to a short
// tool name and a one-line label. Everything else (reasoning, sub-agent
// activity, plan updates) is handled elsewhere or ignored.
function toolProgressOf(item: CodexItem): { tool: string; label?: string } | null {
  const trim = (s?: string | null): string | undefined =>
    s && s.trim() ? (s.length > 120 ? `${s.slice(0, 117)}...` : s) : undefined;
  switch (item.type) {
    case 'commandExecution':
      return { tool: 'shell', label: trim(item.command) };
    case 'fileChange':
      return { tool: 'edit', label: trim(item.changes?.[0]?.path) };
    case 'mcpToolCall':
      return { tool: item.tool ? `${item.server ?? 'mcp'}.${item.tool}` : 'mcp', label: trim(item.tool) };
    case 'webSearch':
      return { tool: 'web_search', label: trim(item.query) };
    default:
      return null;
  }
}

/** Map a failed turn's typed error to a worker error code + message. */
function turnErrorEvent(error: CodexTurnError | null | undefined): StreamEvent {
  const info = error?.codexErrorInfo;
  const message = error?.message || 'Codex ended the turn on an error.';
  const httpStatus =
    info && typeof info === 'object'
      ? Number(
          (Object.values(info)[0] as { httpStatusCode?: number } | undefined)?.httpStatusCode ?? NaN,
        )
      : NaN;
  const kind = typeof info === 'string' ? info : '';
  const text = `${kind} ${message}`;

  let code = 'agent_error';
  if (kind === 'unauthorized' || httpStatus === 401 || /\b401\b|unauthor|not logged in|\blogin\b/i.test(text)) {
    code = 'auth_error';
  } else if (kind === 'usageLimitExceeded' || kind === 'sessionBudgetExceeded') {
    code = 'quota_exhausted';
  } else if (kind === 'serverOverloaded' || httpStatus === 429 || /\b429\b|rate.?limit/i.test(text)) {
    code = 'rate_limit';
  } else if (/\bmodel\b/i.test(text) && /not found|unknown|unsupported/i.test(text)) {
    code = 'model_error';
  }
  return {
    type: 'error',
    code,
    error: message,
    ...(code === 'auth_error' ? { hint: LOGIN_HINT } : {}),
  };
}

let pathBin: string | null = null;

/** The `codex` binary: CODEX_BIN, else the one on PATH. Throws ENOENT when
 *  neither exists — the gateway renders that as 503 agent_unavailable. */
function requireCodexBin(): string {
  let bin = process.env.CODEX_BIN?.trim();
  if (!bin) {
    if (!pathBin) {
      try {
        pathBin = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim() || null;
      } catch {
        pathBin = null;
      }
    }
    bin = pathBin ?? undefined;
  }
  if (!bin || !existsSync(bin)) {
    const error: NodeJS.ErrnoException = new Error(
      `Codex binary not found${bin ? ` at ${bin}` : ' on PATH'}. Install Codex or set CODEX_BIN.`,
    );
    error.code = 'ENOENT';
    throw error;
  }
  return bin;
}

function workspaceCwd(): string {
  const dir = resolveWorkspaceDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when Codex has an account configured (`codex login`, or auth written
 *  from an API key). Cheap subprocess, mirroring the Claude Code health probe. */
function loggedIn(): Promise<boolean> {
  let bin: string;
  try {
    bin = requireCodexBin();
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(bin, ['login', 'status'], { timeout: 15_000 }, (error) => resolve(!error));
  });
}

interface ActiveTurn {
  client: CodexClient;
  turnId?: string;
  killTimer?: NodeJS.Timeout;
}

export class CodexAdapter implements AgentAdapter {
  private readonly child = new IdleChild<CodexClient>({
    idleMs: IDLE_MS,
    start: () => spawnCodexClient(requireCodexBin(), workspaceCwd()),
  });
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private health: { at: number; ok: boolean } | null = null;
  // model id → advertised reasoning efforts, refreshed by getModels; used to
  // clamp a turn's effort without an extra model/list call.
  private modelEfforts = new Map<string, string[]>();

  // The responses route calls this before a response begins: create a thread
  // (no id) or verify one (with id). The thread id becomes the session id.
  async resolveSession(sessionId?: string): Promise<string> {
    const client = await this.child.acquire();
    try {
      if (!sessionId) {
        const thread = await client.startThread(workspaceCwd());
        return thread.id;
      }
      try {
        await client.ensureLoaded(sessionId);
      } catch (error) {
        if (error instanceof CodexError) {
          throw validationError(`No Codex session with id '${sessionId}'.`, 'session_id');
        }
        throw error;
      }
      return sessionId;
    } finally {
      this.child.release();
    }
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    requireCodexBin();
    const client = await this.child.acquire();
    const turn: ActiveTurn = { client };
    this.activeTurns.set(sessionId, turn);

    const tools = new Map<string, { tool: string; startedAt: number }>();
    let usageInput = 0;
    let usageOutput = 0;
    let lastBreakdown: ThreadTokenUsage['last'] | undefined;
    let contextWindow: number | null | undefined;
    let finalTurn: CodexTurn | undefined;

    try {
      // A logged-out turn would otherwise spend ~15s retrying a 401; a cheap
      // account check turns that into an immediate, documented auth_error.
      const account = await client.readAccount();
      if (!account) {
        yield { type: 'error', code: 'auth_error', error: 'Codex has no account configured on this instance.', hint: LOGIN_HINT };
        return;
      }

      await client.ensureLoaded(sessionId);

      const settings = options?.settings;
      const model = settings?.model ?? undefined;
      const nominal = codexEffort(settings?.reasoningEffort);
      const effort = clampEffort(nominal, model ? this.modelEfforts.get(model) : undefined);

      for await (const n of client.runTurn(
        sessionId,
        message,
        { effort, model, sandboxPolicy: { type: 'dangerFullAccess' } },
        (turnId) => {
          turn.turnId = turnId;
        },
      )) {
        const params = n.params as Record<string, unknown>;
        switch (n.method) {
          case 'item/agentMessage/delta': {
            const delta = params.delta as string;
            if (delta) yield { type: 'text_delta', content: delta };
            break;
          }
          case 'item/reasoning/summaryTextDelta':
          case 'item/reasoning/textDelta': {
            const delta = params.delta as string;
            if (delta) yield { type: 'thinking_delta', content: delta };
            break;
          }
          case 'item/started': {
            const item = params.item as CodexItem;
            const progress = toolProgressOf(item);
            if (progress) {
              tools.set(item.id, { tool: progress.tool, startedAt: Number(params.startedAtMs) || Date.now() });
              yield { type: 'tool_progress', tool: progress.tool, status: 'running', label: progress.label };
            }
            break;
          }
          case 'item/completed': {
            const item = params.item as CodexItem;
            const started = tools.get(item.id);
            if (!started) break;
            tools.delete(item.id);
            const failed = item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0;
            const duration = item.durationMs ?? (Number(params.completedAtMs) || Date.now()) - started.startedAt;
            yield failed
              ? { type: 'tool_progress', tool: started.tool, status: 'error' }
              : { type: 'tool_progress', tool: started.tool, status: 'completed', duration };
            break;
          }
          case 'thread/tokenUsage/updated': {
            const usage = params.tokenUsage as ThreadTokenUsage;
            if (usage?.last) {
              usageInput += usage.last.inputTokens ?? 0;
              usageOutput += usage.last.outputTokens ?? 0;
              lastBreakdown = usage.last;
              contextWindow = usage.modelContextWindow;
            }
            break;
          }
          case 'turn/completed':
            finalTurn = params.turn as CodexTurn;
            break;
        }
      }
    } catch (error) {
      // A dead child or an RPC failure mid-turn: fall through to the terminal
      // handling below rather than throwing (driveResponse expects a stream).
      if (!finalTurn) {
        yield { type: 'error', code: 'agent_error', error: error instanceof Error ? error.message : 'Codex turn failed.' };
        return;
      }
    } finally {
      clearTimeout(turn.killTimer);
      this.activeTurns.delete(sessionId);
      this.child.release();
    }

    const usage: TurnUsage = { input_tokens: usageInput, output_tokens: usageOutput, cost_usd: null };
    const context: ContextUsage | null =
      lastBreakdown && contextWindow
        ? { used_tokens: lastBreakdown.inputTokens + lastBreakdown.outputTokens, window_tokens: contextWindow }
        : null;

    if (!finalTurn) {
      yield { type: 'error', code: 'agent_error', error: 'Codex ended the turn before it completed.' };
    } else if (finalTurn.status === 'interrupted') {
      yield { type: 'done', sessionId, usage: null, interrupted: true };
    } else if (finalTurn.status === 'completed') {
      yield { type: 'done', sessionId, usage, context, interrupted: false };
    } else {
      yield turnErrorEvent(finalTurn.error);
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn || !turn.turnId) return false;
    // Backstop: if the graceful interrupt doesn't close the turn, kill the child.
    turn.killTimer = setTimeout(() => void this.child.stop(), INTERRUPT_GRACE_MS);
    try {
      await turn.client.interruptTurn(sessionId, turn.turnId);
    } catch {
      await this.child.stop();
    }
    return true;
  }

  async healthCheck(): Promise<boolean> {
    if (this.health && Date.now() - this.health.at < (this.health.ok ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS)) {
      return this.health.ok;
    }
    const ok = await loggedIn();
    this.health = { at: Date.now(), ok };
    return ok;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const client = await this.child.acquire();
    try {
      const threads = await client.listThreads();
      return threads.map((thread: CodexThread) => ({
        id: thread.id,
        title: thread.name ?? null,
        last_active: epochMillis(thread.updatedAt),
        message_count: null,
        preview: thread.preview?.trim() || null,
      }));
    } finally {
      this.child.release();
    }
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    const client = await this.child.acquire();
    let thread: CodexThread;
    try {
      await client.ensureLoaded(sessionId);
      thread = await client.readThread(sessionId);
    } catch (error) {
      // The harness owns existence: an unknown/deleted thread projects to [].
      if (error instanceof CodexError) return [];
      throw error;
    } finally {
      this.child.release();
    }

    const out: HermesMessage[] = [];
    let pendingThinking = '';
    for (const codexTurn of thread.turns ?? []) {
      const created = epochMillis(codexTurn.startedAt) ?? 0;
      for (const item of codexTurn.items ?? []) {
        if (item.type === 'reasoning') {
          const text = (item.summary ?? []).join('\n').trim();
          if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n\n${text}` : text;
          continue;
        }
        if (item.type === 'userMessage') {
          const text = (item.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
          if (!text.trim()) continue;
          out.push({ id: item.id, task_id: sessionId, role: 'user', content: text, created_at: created });
          pendingThinking = '';
        } else if (item.type === 'agentMessage') {
          const text = item.text ?? '';
          if (!text.trim()) continue;
          const previous = out.at(-1);
          if (previous?.role === 'assistant') {
            previous.content += `\n\n${text}`;
            if (pendingThinking) previous.thinking = previous.thinking ? `${previous.thinking}\n\n${pendingThinking}` : pendingThinking;
          } else {
            out.push({
              id: item.id,
              task_id: sessionId,
              role: 'assistant',
              content: text,
              thinking: pendingThinking || undefined,
              created_at: created,
            });
          }
          pendingThinking = '';
        }
      }
    }
    return out;
  }

  async getSessionMetadata(): Promise<SessionMetadata | null> {
    // No route reads this today; Codex history carries no per-session cost.
    return null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const client = await this.child.acquire();
    try {
      await client.deleteThread(sessionId);
      return true;
    } catch (error) {
      if (error instanceof CodexError) return false;
      throw error;
    } finally {
      this.child.release();
    }
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const client = await this.child.acquire();
    try {
      await client.renameThread(sessionId, title);
      return true;
    } catch (error) {
      if (error instanceof CodexError) return false;
      throw error;
    } finally {
      this.child.release();
    }
  }

  async getModels(): Promise<AgentModelsResponse> {
    const client = await this.child.acquire();
    let models: CodexModel[];
    try {
      models = await client.listModels();
    } finally {
      this.child.release();
    }
    this.modelEfforts.clear();
    let defaultModel: string | null = null;
    for (const model of models) {
      const efforts = (model.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
      if (efforts.length) this.modelEfforts.set(model.id, efforts);
      if (model.isDefault) defaultModel = model.id;
    }
    return {
      defaultModel,
      activeProvider: 'openai',
      groups: [
        {
          provider: 'openai',
          models: models.map((model) => ({
            id: model.id,
            label: model.displayName || model.id,
            source: 'catalog',
            provider: 'openai',
            isCurrentDefault: model.isDefault,
          })),
        },
      ],
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: 'openai', model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: true };
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) clearTimeout(turn.killTimer);
    this.activeTurns.clear();
    await this.child.stop();
  }
}

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSession as deleteClaudeSession,
  getSessionMessages,
  listSessions as listClaudeSessions,
  query,
  renameSession as renameClaudeSession,
  type ModelInfo as SDKModelInfo,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKAssistantMessageError,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
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

// The adapter drives Claude Code through the Claude Agent SDK: one `query()`
// (one `claude` child process) per turn, resumed by session id. Transcripts
// live where Claude Code keeps them (`~/.claude/projects/<cwd>/<uuid>.jsonl`),
// and the session list, history, rename and delete all go through the SDK's
// session helpers over that store — the gateway keeps no index. Credentials
// are Claude Code's own (`claude auth login` on the box, or ANTHROPIC_API_KEY /
// CLAUDE_CODE_OAUTH_TOKEN in the environment); the gateway never touches them.

const HEALTHY_TTL_MS = 60_000;
// A not-logged-in probe is re-run sooner so a fresh `claude auth login` shows up.
const UNHEALTHY_TTL_MS = 10_000;
// After `interrupt()`, how long Claude Code gets to close the turn with its own
// `result` before the process is killed outright.
const INTERRUPT_GRACE_MS = 5_000;
const LOGIN_HINT =
  'Run `claude auth login` in the instance terminal, or set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment.';

// Claude Code's effort ladder (low…max) has no none/minimal: `none` turns
// thinking off outright, `minimal` rounds up to its floor of low.
const EFFORT_MAP: Record<Exclude<ReasoningEffort, 'none' | 'ultra'>, 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** The query() options one reasoning effort turns into. `ultra` is ultracode —
 *  Claude Code's own Ultra mode: xhigh effort plus standing multi-agent
 *  workflow orchestration, session-scoped, so per-turn here (one query() per
 *  turn). Exported for the mapping tests. */
export function effortOptions(effort: ReasoningEffort | null | undefined): Pick<Options, 'effort' | 'thinking' | 'settings'> {
  if (!effort) return {};
  if (effort === 'none') return { thinking: { type: 'disabled' } };
  if (effort === 'ultra') return { effort: 'xhigh', settings: { ultracode: true } };
  return { effort: EFFORT_MAP[effort] };
}

// Claude Code has no catalog command; its own /model picker is the SDK's
// supportedModels() control request, which needs a live query. The answer is
// the customer's own list — it names the versions each alias resolves to and
// tracks their plan and CLI release — and every ask spawns a `claude`, so it is
// cached for a few minutes.
const CATALOG_TTL_MS = 300_000;
// The catalog's own "whatever Claude Code picks" row.
const DEFAULT_MODEL_ID = 'default';

// Claude Code's typed failure signal (SDKAssistantMessage.error) → the worker
// codes server/errors.ts already knows how to render.
const ERROR_CODE_MAP: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed: 'auth_error',
  oauth_org_not_allowed: 'auth_error',
  account_on_hold: 'auth_error',
  billing_error: 'quota_exhausted',
  rate_limit: 'rate_limit',
  overloaded: 'rate_limit',
  model_not_found: 'model_error',
};

let pathBin: string | null = null;

/** The `claude` binary a turn spawns: CLAUDE_CODE_BIN, else the one on PATH.
 *  Throws ENOENT when neither exists — the gateway renders that as
 *  `503 agent_unavailable`, like any other unprovisioned harness. */
function requireClaudeBin(): string {
  let bin = process.env.CLAUDE_CODE_BIN?.trim();
  if (!bin) {
    if (!pathBin) {
      try {
        pathBin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null;
      } catch {
        pathBin = null;
      }
    }
    bin = pathBin ?? undefined;
  }
  if (!bin || !existsSync(bin)) {
    const error: NodeJS.ErrnoException = new Error(
      `Claude Code binary not found${bin ? ` at ${bin}` : ' on PATH'}. Install Claude Code or set CLAUDE_CODE_BIN.`,
    );
    error.code = 'ENOENT';
    throw error;
  }
  return bin;
}

// Claude Code names the transcript directory after the cwd it was given, so
// hand it the canonical path (macOS /var → /private/var) and look for the
// transcript under the same spelling. The directory must exist to be spawned in.
function workspaceCwd(): string {
  const dir = resolveWorkspaceDir();
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function transcriptPath(uuid: string, cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${uuid}.jsonl`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function dashed(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/** Claude Code requires a UUID session id. Gateway-minted ids are a UUID with
 *  the dashes removed, so they re-dash losslessly (and a listed session's UUID
 *  strips back to the id the client used). Any other client-supplied id maps
 *  to a stable name-based UUID. */
export function claudeSessionUuid(sessionId: string): string {
  const lower = sessionId.toLowerCase();
  if (/^[0-9a-f]{32}$/.test(lower) && UUID_RE.test(dashed(lower))) return dashed(lower);
  if (UUID_RE.test(lower)) return lower;
  const digest = createHash('sha1').update('agent37-gateway:claude-code:').update(sessionId).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return dashed(digest.subarray(0, 16).toString('hex'));
}

// Messages API content, trimmed to the block fields we read.
type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
};

type ApiUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

function blocksOf(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Block => typeof b === 'object' && b !== null && typeof (b as Block).type === 'string');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function thinkingOf(content: unknown): string {
  return blocksOf(content)
    .filter((b) => b.type === 'thinking')
    .map((b) => b.thinking ?? '')
    .join('');
}

// A one-line label for a tool call: the command, path, pattern or URL it acts on.
function toolLabel(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  return undefined;
}

// Prompt-side tokens of one API call: fresh input plus what the cache served.
function inputTokens(usage: ApiUsage | undefined): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
}

function turnUsage(result: SDKResultMessage): TurnUsage {
  return {
    input_tokens: inputTokens(result.usage),
    output_tokens: result.usage.output_tokens ?? 0,
    cost_usd: result.total_cost_usd,
  };
}

// The tokens occupying the window after the turn are the last API call's
// prompt plus its output; the window size rides on the result's per-model
// usage. Null when Claude Code reported neither. The prompt side comes from
// the last assistant message; its output_tokens is a placeholder while
// streaming, so the output side comes from the last message_delta event.
function contextOf(
  last: SDKAssistantMessage | undefined,
  lastOutputTokens: number,
  result: SDKResultMessage,
): ContextUsage | null {
  if (last?.context_usage) {
    return { used_tokens: last.context_usage.total_tokens, window_tokens: last.context_usage.raw_max_tokens };
  }
  const usage = last?.message.usage as ApiUsage | undefined;
  const used = inputTokens(usage) + lastOutputTokens;
  const model = last?.message.model;
  const window =
    (model ? result.modelUsage[model]?.contextWindow : undefined) || Object.values(result.modelUsage)[0]?.contextWindow;
  if (used <= 0 || !window) return null;
  return { used_tokens: used, window_tokens: window };
}

function failureEvent(signal: SDKAssistantMessageError | undefined, text: string): StreamEvent {
  const code =
    (signal && ERROR_CODE_MAP[signal]) ||
    // Fallback for CLIs that report the failure only as text.
    (/not logged in|invalid api key|please run \/login/i.test(text) ? 'auth_error' : 'agent_error');
  return {
    type: 'error',
    code,
    error: text || 'Claude Code ended the turn on an error.',
    ...(code === 'auth_error' ? { hint: LOGIN_HINT } : {}),
  };
}

function loggedIn(): Promise<boolean> {
  let bin: string;
  try {
    bin = requireClaudeBin();
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      try {
        resolve((JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true);
      } catch {
        resolve(false);
      }
    });
  });
}

// One query whose prompt never yields: enough of a session for the control
// request, torn down as soon as it answers.
async function modelCatalog(bin: string): Promise<SDKModelInfo[]> {
  const abort = new AbortController();
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  const q = query({
    prompt: idle(),
    options: {
      cwd: workspaceCwd(),
      pathToClaudeCodeExecutable: bin,
      settingSources: ['user'],
      abortController: abort,
    },
  });
  try {
    return await q.supportedModels();
  } finally {
    abort.abort();
  }
}

interface ActiveTurn {
  query: Query;
  abort: AbortController;
  interrupted: boolean;
  killTimer?: NodeJS.Timeout;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private health: { at: number; ok: boolean } | null = null;
  private catalog: { at: number; models: SDKModelInfo[] } | null = null;

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    const bin = requireClaudeBin();
    const cwd = workspaceCwd();
    const uuid = claudeSessionUuid(sessionId);
    // An id with a transcript resumes it; any other id starts a fresh thread
    // (the documented contract for client-supplied ids).
    const resume = existsSync(transcriptPath(uuid, cwd));
    const settings = options?.settings;

    // Streaming-input mode (the prompt as an async iterable) is the only mode
    // where interrupt() works. Keep stdin open until the turn has settled so
    // the interrupt control request always has a channel.
    let release = (): void => {};
    const inputDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, session_id: uuid };
      await inputDone;
    }

    // Claude Code's stderr, size-bounded, for the rare exit with no result.
    let stderrTail = '';
    const abort = new AbortController();
    const q = query({
      prompt: input(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: bin,
        ...(resume ? { resume: uuid } : { sessionId: uuid }),
        // Sandbox parity with the other harnesses (HERMES_YOLO_MODE): the
        // instance is the customer's own box, so tools run unprompted.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        // Only ~/.claude/settings.json: a .claude/ or CLAUDE.md inside the
        // workspace must not reconfigure server turns.
        settingSources: ['user'],
        ...(settings?.model ? { model: settings.model } : {}),
        ...effortOptions(settings?.reasoningEffort),
        abortController: abort,
        stderr: (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-4096);
        },
      },
    });
    const turn: ActiveTurn = { query: q, abort, interrupted: false };
    this.activeTurns.set(sessionId, turn);

    const tools = new Map<string, { name: string; startedAt: number }>();
    let signal: SDKAssistantMessageError | undefined;
    let lastAssistant: SDKAssistantMessage | undefined;
    let lastOutputTokens = 0;
    let result: SDKResultMessage | undefined;
    try {
      for await (const msg of q) {
        // Subagent (Task) traffic carries parent_tool_use_id; only the main
        // loop streams to the client.
        if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) continue;

        if (msg.type === 'stream_event') {
          const event = msg.event as unknown as {
            type: string;
            delta?: { type: string; text?: string; thinking?: string };
            usage?: { output_tokens?: number };
          };
          if (event.type === 'message_delta' && typeof event.usage?.output_tokens === 'number') {
            lastOutputTokens = event.usage.output_tokens;
          }
          if (event.type !== 'content_block_delta' || !event.delta) continue;
          if (event.delta.type === 'text_delta' && event.delta.text) {
            yield { type: 'text_delta', content: event.delta.text };
          } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            yield { type: 'thinking_delta', content: event.delta.thinking };
          }
        } else if (msg.type === 'assistant') {
          if (msg.error) signal = msg.error;
          lastAssistant = msg;
          for (const block of blocksOf(msg.message.content)) {
            if (block.type !== 'tool_use' || !block.id || !block.name) continue;
            tools.set(block.id, { name: block.name, startedAt: Date.now() });
            yield { type: 'tool_progress', tool: block.name, status: 'running', label: toolLabel(block.input) };
          }
        } else if (msg.type === 'user') {
          for (const block of blocksOf(msg.message.content)) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            const started = tools.get(block.tool_use_id);
            if (!started) continue;
            tools.delete(block.tool_use_id);
            yield block.is_error
              ? { type: 'tool_progress', tool: started.name, status: 'error', label: textOf(block.content).slice(0, 200) || undefined }
              : { type: 'tool_progress', tool: started.name, status: 'completed', duration: Date.now() - started.startedAt };
          }
        } else if (msg.type === 'result') {
          result = msg;
          break;
        }
      }
    } catch (error) {
      // The SDK throws after an error result (already terminal) and on abort
      // (the interrupt backstop); anything else is a real failure, and the
      // SDK's own message already carries a stderr tail.
      if (!result && !turn.interrupted) throw error;
    } finally {
      release();
      clearTimeout(turn.killTimer);
      this.activeTurns.delete(sessionId);
    }

    if (turn.interrupted) {
      // An interrupted result carries zeroed usage, not the partial turn's.
      yield { type: 'done', sessionId, usage: null, interrupted: true };
    } else if (!result) {
      const detail = stderrTail.trim();
      yield { type: 'error', code: 'agent_error', error: `Claude Code exited before finishing the turn.${detail ? ` ${detail}` : ''}` };
    } else if (result.subtype !== 'success') {
      yield failureEvent(signal, result.errors.join(' ') || `Claude Code stopped: ${result.subtype}.`);
    } else if (result.is_error) {
      yield failureEvent(signal, result.result);
    } else {
      yield {
        type: 'done',
        sessionId,
        usage: turnUsage(result),
        context: contextOf(lastAssistant, lastOutputTokens, result),
        interrupted: false,
      };
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return false;
    turn.interrupted = true;
    // Claude Code answers an interrupt with its own `result`, which ends the
    // stream above; if none lands within the grace period, kill the process.
    turn.killTimer = setTimeout(() => turn.abort.abort(), INTERRUPT_GRACE_MS);
    try {
      await turn.query.interrupt();
    } catch {
      turn.abort.abort();
    }
    return true;
  }

  // Healthy means the binary is there and Claude Code reports a login (or an
  // API key in the environment). `false` until the customer logs in.
  async healthCheck(): Promise<boolean> {
    if (this.health && Date.now() - this.health.at < (this.health.ok ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS)) {
      return this.health.ok;
    }
    const ok = await loggedIn();
    this.health = { at: Date.now(), ok };
    return ok;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const rows = await listClaudeSessions({ dir: workspaceCwd(), includeWorktrees: false });
    // `summary` is Claude Code's own display title: the custom title (what
    // rename writes) when set, else its auto summary or the first prompt.
    return rows.map((row) => ({
      id: row.sessionId.replace(/-/g, ''),
      title: row.summary?.trim() || null,
      last_active: row.lastModified ?? null,
      message_count: null,
      preview: row.firstPrompt?.trim() || null,
    }));
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    const rows = await getSessionMessages(claudeSessionUuid(sessionId), { dir: workspaceCwd() });
    // Keep user/assistant turns with visible text; tool plumbing (tool_use
    // and tool_result blocks) is dropped. Claude Code writes one row per
    // content block, so a reply's text and thinking blocks are folded back
    // into one assistant message.
    const out: HermesMessage[] = [];
    let pendingThinking = '';
    for (const row of rows) {
      if (row.parent_tool_use_id || (row.type !== 'user' && row.type !== 'assistant')) continue;
      const content = (row.message as { content?: unknown }).content;
      const text = textOf(content);
      const thinking = thinkingOf(content);
      if (row.type === 'assistant' && thinking) pendingThinking = pendingThinking ? `${pendingThinking}\n\n${thinking}` : thinking;
      if (!text.trim()) continue;
      if (row.type === 'user' && text.startsWith('[Request interrupted')) continue;
      const previous = out.at(-1);
      if (row.type === 'assistant' && previous?.role === 'assistant') {
        previous.content += `\n\n${text}`;
        if (pendingThinking) previous.thinking = previous.thinking ? `${previous.thinking}\n\n${pendingThinking}` : pendingThinking;
      } else {
        out.push({
          id: row.uuid,
          task_id: sessionId,
          role: row.type,
          content: text,
          thinking: row.type === 'assistant' && pendingThinking ? pendingThinking : undefined,
          created_at: epochMillis((row as { timestamp?: string }).timestamp) ?? 0,
        });
      }
      pendingThinking = '';
    }
    return out;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const rows = await getSessionMessages(claudeSessionUuid(sessionId), { dir: workspaceCwd() });
    if (rows.length === 0) return null;
    const meta: SessionMetadata = {
      id: sessionId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      estimated_cost_usd: null,
      cost_status: null,
      model: null,
    };
    // Usage rides on every per-block row of an API message; count each message once.
    // Anthropic bills thinking inside output_tokens and the transcript keeps only
    // the thinking text, so reasoning_tokens is the usual chars/4 estimate.
    const seen = new Set<string>();
    let thinkingChars = 0;
    for (const row of rows) {
      if (row.type !== 'assistant' || row.parent_tool_use_id) continue;
      thinkingChars += thinkingOf((row.message as { content?: unknown }).content).length;
      const message = row.message as { id?: string; model?: string; usage?: ApiUsage };
      if (!message.usage || !message.id || seen.has(message.id)) continue;
      seen.add(message.id);
      meta.input_tokens += message.usage.input_tokens ?? 0;
      meta.output_tokens += message.usage.output_tokens ?? 0;
      meta.cache_read_tokens += message.usage.cache_read_input_tokens ?? 0;
      meta.cache_write_tokens += message.usage.cache_creation_input_tokens ?? 0;
      if (message.model && !message.model.startsWith('<')) meta.model = message.model;
    }
    meta.reasoning_tokens = Math.round(thinkingChars / 4);
    return meta;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const cwd = workspaceCwd();
    const uuid = claudeSessionUuid(sessionId);
    if (!existsSync(transcriptPath(uuid, cwd))) return false;
    await deleteClaudeSession(uuid, { dir: cwd });
    return true;
  }

  // Claude Code's own /rename: appends a custom-title entry to the transcript,
  // which the session list reads back as `summary`.
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cwd = workspaceCwd();
    const uuid = claudeSessionUuid(sessionId);
    if (!existsSync(transcriptPath(uuid, cwd))) return false;
    await renameClaudeSession(uuid, title, { dir: cwd });
    return true;
  }

  async getModels(): Promise<AgentModelsResponse> {
    const bin = requireClaudeBin();
    const now = Date.now();
    if (!this.catalog || now - this.catalog.at > CATALOG_TTL_MS) {
      this.catalog = { at: now, models: await modelCatalog(bin) };
    }
    const models = this.catalog.models;
    return {
      defaultModel: models.some((model) => model.value === DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : null,
      activeProvider: 'anthropic',
      groups: [
        {
          provider: 'anthropic',
          models: models.map((model) => ({
            id: model.value,
            label: model.displayName || model.value,
            description: model.description || null,
            source: 'catalog',
            provider: 'anthropic',
            isCurrentDefault: model.value === DEFAULT_MODEL_ID,
          })),
        },
      ],
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: 'anthropic', model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: true };
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) turn.abort.abort();
    this.activeTurns.clear();
  }
}

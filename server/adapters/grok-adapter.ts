import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AgentDefaults,
  AgentModelsResponse,
  HermesMessage,
  ReasoningEffort,
  SessionMetadata,
  SessionSummary,
  TurnUsage,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';
import { epochMillis } from './types.js';
import { resolveWorkspaceDir } from '../paths.js';
import { validationError } from '../errors.js';

// The adapter drives Grok Build (`grok`) headless: one `grok -p` process per
// turn, streaming NDJSON (`--output-format streaming-json`), exiting when the
// turn ends — so at-rest RAM is zero and there is no resident server to manage.
// Session ids are UUIDs living in grok's own store
// (`~/.grok/sessions/<url-encoded-cwd>/<uuid>/`): the gateway mints the UUID in
// `resolveSession` and hands it to grok with `-s` on the session's first turn
// (grok accepts a caller-supplied UUID for a NEW session only), then resumes
// with `-r`; a client cannot invent an id (400 validation_error). Credentials
// are grok's own (`XAI_API_KEY` in the instance env, or `grok login` on the
// box); the gateway never reads the key's value.

const INTERRUPT_GRACE_MS = 5_000;
const LOGIN_HINT =
  'Set XAI_API_KEY in the instance environment, or run `grok login --device-code` in the instance terminal.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Our public effort ladder → grok's `--reasoning-effort`. Grok advertises
// none/minimal/low/medium/high/xhigh/max and has no ultra (its multi-agent
// mode is a model, not an effort), so `ultra` maps to `max`. Grok ignores the
// flag on non-reasoning models, so no per-model clamping is needed.
const EFFORT_MAP: Record<ReasoningEffort, string> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
};

/** The grok effort one reasoning level maps to. Exported for the mapping tests. */
export function grokEffort(effort: ReasoningEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  return EFFORT_MAP[effort];
}

let pathBin: string | null = null;

/** The `grok` binary: GROK_BIN, else the one on PATH. Throws ENOENT when
 *  neither exists — the gateway renders that as 503 agent_unavailable. */
function requireGrokBin(): string {
  let bin = process.env.GROK_BIN?.trim();
  if (!bin) {
    if (!pathBin) {
      try {
        pathBin = execFileSync('which', ['grok'], { encoding: 'utf8' }).trim() || null;
      } catch {
        pathBin = null;
      }
    }
    bin = pathBin ?? undefined;
  }
  if (!bin || !existsSync(bin)) {
    const error: NodeJS.ErrnoException = new Error(
      `Grok binary not found${bin ? ` at ${bin}` : ' on PATH'}. Install Grok Build or set GROK_BIN.`,
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

function grokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured || join(homedir(), '.grok');
}

/** Grok keys its session store by URL-encoded realpath of the cwd. */
function sessionsDir(): string {
  let cwd = workspaceCwd();
  try {
    cwd = execFileSync('pwd', ['-P'], { cwd, encoding: 'utf8' }).trim() || cwd;
  } catch {
    // keep the unresolved path
  }
  return join(grokHome(), 'sessions', encodeURIComponent(cwd));
}

function sessionDir(sessionId: string): string {
  return join(sessionsDir(), sessionId);
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GROK_DISABLE_AUTOUPDATER: '1', GROK_SANDBOX: 'off' };
}

interface GrokSummary {
  session_summary?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  num_chat_messages?: number;
}

function readSummary(dir: string): GrokSummary | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as GrokSummary;
  } catch {
    return null;
  }
}

/** Map a grok stream error message to a worker error code + message. */
function errorEventOf(message: string): StreamEvent {
  let code = 'agent_error';
  if (/not signed in|not authenticated|unauthor|\b401\b|api key/i.test(message)) {
    code = 'auth_error';
  } else if (/\b429\b|rate.?limit|too many requests/i.test(message)) {
    code = 'rate_limit';
  } else if (/quota|credits?\b|billing|insufficient funds/i.test(message)) {
    code = 'quota_exhausted';
  } else if (/couldn't set model|unknown model id|model.*(not found|unavailable)/i.test(message)) {
    code = 'model_error';
  }
  return { type: 'error', code, error: message, ...(code === 'auth_error' ? { hint: LOGIN_HINT } : {}) };
}

// Grok's tool names, mapped to the short names the UI knows, with a one-line
// label from the tool input. Anything unrecognized passes through by name.
function toolProgressOf(toolName: string, input: Record<string, unknown> | undefined): { tool: string; label?: string } {
  const trim = (value: unknown): string | undefined => {
    const s = typeof value === 'string' ? value.trim() : '';
    return s ? (s.length > 120 ? `${s.slice(0, 117)}...` : s) : undefined;
  };
  switch (toolName) {
    case 'run_terminal_command':
      return { tool: 'shell', label: trim(input?.command) };
    case 'write':
    case 'search_replace':
      return { tool: 'edit', label: trim(input?.path ?? input?.file_path) };
    case 'web_search':
      return { tool: 'web_search', label: trim(input?.query) };
    case 'use_tool':
      return { tool: 'mcp', label: trim(input?.tool_name) };
    default:
      return { tool: toolName, label: undefined };
  }
}

interface GrokEndEvent {
  stopReason?: string;
  sessionId?: string;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  total_cost_usd?: number;
}

interface ActiveTurn {
  child: ChildProcessWithoutNullStreams;
  interrupted: boolean;
  killTimer?: NodeJS.Timeout;
}

export class GrokAdapter implements AgentAdapter {
  private readonly activeTurns = new Map<string, ActiveTurn>();

  // The responses route calls this before a response begins: mint a UUID for a
  // new session (grok creates it on the first turn via `-s`), or verify an
  // existing one against grok's own store.
  async resolveSession(sessionId?: string): Promise<string> {
    requireGrokBin();
    if (!sessionId) return randomUUID();
    if (!UUID_RE.test(sessionId) || !existsSync(sessionDir(sessionId))) {
      throw validationError(`No Grok session with id '${sessionId}'.`, 'session_id');
    }
    return sessionId;
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    const bin = requireGrokBin();
    const settings = options?.settings;
    const isNew = !existsSync(sessionDir(sessionId));
    const args = [
      '-p',
      message,
      isNew ? '-s' : '-r',
      sessionId,
      '--output-format',
      'streaming-json',
      '--always-approve',
    ];
    if (settings?.model) args.push('-m', settings.model);
    const effort = grokEffort(settings?.reasoningEffort);
    if (effort) args.push('--reasoning-effort', effort);

    const child = spawn(bin, args, { cwd: workspaceCwd(), env: childEnv() });
    const turn: ActiveTurn = { child, interrupted: false };
    this.activeTurns.set(sessionId, turn);

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });

    const tools = new Map<string, { tool: string; startedAt: number }>();
    let end: GrokEndEvent | undefined;
    let errorEvent: StreamEvent | undefined;

    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (event.type) {
          case 'text': {
            const delta = event.data as string;
            if (delta) yield { type: 'text_delta', content: delta };
            break;
          }
          case 'thought': {
            const delta = event.data as string;
            if (delta) yield { type: 'thinking_delta', content: delta };
            break;
          }
          case 'tool_call': {
            const id = event.toolCallId as string;
            const progress = toolProgressOf(String(event.toolName ?? ''), event.rawInput as Record<string, unknown>);
            tools.set(id, { tool: progress.tool, startedAt: Date.now() });
            yield { type: 'tool_progress', tool: progress.tool, status: 'running', label: progress.label };
            break;
          }
          case 'tool_call_update': {
            const started = tools.get(event.toolCallId as string);
            const status = event.status as string | null;
            if (!started || (status !== 'completed' && status !== 'failed')) break;
            tools.delete(event.toolCallId as string);
            const rawOutput = event.rawOutput as { exit_code?: number } | null;
            const failed = status === 'failed' || (typeof rawOutput?.exit_code === 'number' && rawOutput.exit_code !== 0);
            yield failed
              ? { type: 'tool_progress', tool: started.tool, status: 'error' }
              : { type: 'tool_progress', tool: started.tool, status: 'completed', duration: Date.now() - started.startedAt };
            break;
          }
          case 'end':
            end = event as GrokEndEvent;
            break;
          case 'error':
            errorEvent = errorEventOf(String(event.message ?? 'Grok ended the turn on an error.'));
            break;
        }
      }
    } finally {
      await exited;
      clearTimeout(turn.killTimer);
      this.activeTurns.delete(sessionId);
    }

    if (turn.interrupted) {
      yield { type: 'done', sessionId, usage: null, interrupted: true };
    } else if (errorEvent) {
      yield errorEvent;
    } else if (end) {
      const totals = end.usage ?? {};
      const output = totals.output_tokens ?? 0;
      const usage: TurnUsage = {
        input_tokens: Math.max(0, (totals.total_tokens ?? 0) - output),
        output_tokens: output,
        cost_usd: end.total_cost_usd ?? null,
      };
      yield { type: 'done', sessionId, usage, context: null, interrupted: false };
    } else {
      const detail = stderrTail.trim().split('\n').at(-1);
      yield { type: 'error', code: 'agent_error', error: detail || 'Grok ended the turn before it completed.' };
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return false;
    turn.interrupted = true;
    turn.child.kill('SIGINT');
    // Backstop: if grok doesn't wind down after SIGINT, kill it outright.
    turn.killTimer = setTimeout(() => turn.child.kill('SIGKILL'), INTERRUPT_GRACE_MS);
    return true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      requireGrokBin();
    } catch {
      return false;
    }
    const keyed = Boolean(process.env.XAI_API_KEY?.trim() || process.env.GROK_CODE_XAI_API_KEY?.trim());
    return keyed || existsSync(join(grokHome(), 'auth.json'));
  }

  async listSessions(): Promise<SessionSummary[]> {
    const dir = sessionsDir();
    if (!existsSync(dir)) return [];
    const rows: SessionSummary[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const summary = readSummary(join(dir, entry.name));
      rows.push({
        id: entry.name,
        title: summary?.session_summary?.trim() || null,
        last_active: epochMillis(summary?.last_active_at ?? summary?.updated_at),
        message_count: summary?.num_chat_messages ?? null,
        preview: null,
      });
    }
    return rows.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    // The route passes the raw path param; only UUID-shaped ids may touch the
    // store path (a traversal-shaped id must not resolve outside it).
    if (!UUID_RE.test(sessionId)) return [];
    const dir = sessionDir(sessionId);
    let raw: string;
    try {
      raw = readFileSync(join(dir, 'chat_history.jsonl'), 'utf8');
    } catch {
      // The harness owns existence: an unknown/deleted session projects to [].
      return [];
    }
    const created = epochMillis(readSummary(dir)?.created_at) ?? 0;

    const out: HermesMessage[] = [];
    let index = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: { type?: string; content?: unknown; prompt_index?: number };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue;
      }
      index += 1;
      if (entry.type === 'user' && typeof entry.prompt_index === 'number') {
        // Real prompts carry prompt_index; grok wraps them in <user_query>.
        const text = (Array.isArray(entry.content) ? entry.content : [])
          .filter((c): c is { type: string; text?: string } => (c as { type?: string }).type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        const inner = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(text)?.[1] ?? text;
        if (!inner.trim()) continue;
        out.push({ id: `${sessionId}-${index}`, task_id: sessionId, role: 'user', content: inner, created_at: created });
      } else if (entry.type === 'assistant' && typeof entry.content === 'string' && entry.content.trim()) {
        const previous = out.at(-1);
        if (previous?.role === 'assistant') previous.content += `\n\n${entry.content}`;
        else out.push({ id: `${sessionId}-${index}`, task_id: sessionId, role: 'assistant', content: entry.content, created_at: created });
      }
    }
    return out;
  }

  async getSessionMetadata(): Promise<SessionMetadata | null> {
    // No route reads this today; per-session cost stays in grok's store.
    return null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const bin = requireGrokBin();
    if (!UUID_RE.test(sessionId)) return false;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(bin, ['sessions', 'delete', sessionId], { cwd: workspaceCwd(), env: childEnv(), timeout: 30_000 }, (error, out) => {
        if (error && !out) reject(error);
        else resolve(out);
      });
    });
    // `grok sessions delete` exits 0 either way; stdout says which happened.
    return /deleted session/i.test(stdout);
  }

  async getModels(): Promise<AgentModelsResponse> {
    const bin = requireGrokBin();
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(bin, ['models'], { cwd: workspaceCwd(), env: childEnv(), timeout: 30_000 }, (error, out) => {
        if (error && !out) reject(error);
        else resolve(out);
      });
    });
    // Unkeyed, grok prints a static fallback catalog behind "You are not
    // authenticated." — an unkeyed instance gets an empty list, never an error.
    if (/not authenticated/i.test(stdout)) {
      return { defaultModel: null, activeProvider: 'xai', groups: [{ provider: 'xai', models: [] }] };
    }
    const defaultModel = /^Default model:\s+(\S+)/m.exec(stdout)?.[1] ?? null;
    const ids = [...stdout.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => m[1]);
    return {
      defaultModel,
      activeProvider: 'xai',
      groups: [
        {
          provider: 'xai',
          models: ids.map((id) => ({
            id,
            label: id,
            source: 'catalog',
            provider: 'xai',
            isCurrentDefault: id === defaultModel,
          })),
        },
      ],
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: 'xai', model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: true };
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.killTimer);
      turn.child.kill('SIGKILL');
    }
    this.activeTurns.clear();
  }
}

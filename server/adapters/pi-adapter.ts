import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
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

// The adapter drives Pi (pi.dev) headless: one `pi --mode json` process per turn,
// reading the prompt on stdin and exiting when the turn ends — so at-rest RAM is
// zero and there is no resident server to manage. Session ids are UUIDs the
// gateway mints in `resolveSession` and hands to pi with `--session-id` (which
// creates the session when it is absent and resumes it when it is not); sessions,
// transcripts, and delete all work on pi's own JSONL store. Credentials are pi's
// own: a provider key in the instance environment, `pi /login` on the box, or the
// managed `agent37` provider our image writes into pi's `models.json`. The
// gateway never reads a key's value.

const INTERRUPT_GRACE_MS = 5_000;
const MODELS_CACHE_MS = 30_000;
const LOGIN_HINT =
  'Set a provider API key in the instance environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), or run `pi` in the instance terminal and sign in with /login.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Our public effort ladder → pi's `--thinking`. Pi advertises
// off/minimal/low/medium/high/xhigh/max and has no ultra, so `ultra` maps to
// `max`; pi clamps the level to the model's capabilities, so no per-model
// clamping is needed here.
const THINKING_MAP: Record<ReasoningEffort, string> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
};

/** The pi thinking level one reasoning level maps to. Exported for the mapping tests. */
export function piThinking(effort: ReasoningEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  return THINKING_MAP[effort];
}

let pathBin: string | null = null;

/** The `pi` binary: PI_BIN, else the one on PATH. Throws ENOENT when neither
 *  exists — the gateway renders that as 503 agent_unavailable. */
function requirePiBin(): string {
  let bin = process.env.PI_BIN?.trim();
  if (!bin) {
    if (!pathBin) {
      try {
        pathBin = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim() || null;
      } catch {
        pathBin = null;
      }
    }
    bin = pathBin ?? undefined;
  }
  if (!bin || !existsSync(bin)) {
    const error: NodeJS.ErrnoException = new Error(
      `Pi binary not found${bin ? ` at ${bin}` : ' on PATH'}. Install @earendil-works/pi-coding-agent or set PI_BIN.`,
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

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), '.pi', 'agent');
}

/** Where pi keeps this workspace's sessions. PI_CODING_AGENT_SESSION_DIR (which
 *  our image sets, so the terminal and the API share one store) is a flat
 *  directory; pi's own default groups them per working directory under a label
 *  that strips the leading separator and replaces `/`, `\` and `:` with `-`. */
function sessionsDir(): string {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (override) return override;
  let cwd = workspaceCwd();
  try {
    cwd = execFileSync('pwd', ['-P'], { cwd, encoding: 'utf8' }).trim() || cwd;
  } catch {
    // keep the unresolved path
  }
  return join(piAgentDir(), 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

/** Pi names a session file `<timestamp>_<session-id>.jsonl`. */
function sessionFile(sessionId: string): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const dir = sessionsDir();
  const suffix = `_${sessionId}.jsonl`;
  try {
    const match = readdirSync(dir).find((name) => name.endsWith(suffix));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PI_OFFLINE: '1' };
}

/** Pi's JSONL framing is LF-only: Unicode line separators are valid inside its
 *  strings, so readline (which splits on them too) would corrupt records. */
async function* jsonlLines(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk as string;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) yield line;
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) yield buffer;
}

/** Map a pi error message to a worker error code + message. */
function errorEventOf(message: string): StreamEvent {
  let code = 'agent_error';
  if (/not signed in|not authenticated|unauthor|\b401\b|\b403\b|api key|no credentials/i.test(message)) {
    code = 'auth_error';
  } else if (/\b429\b|rate.?limit|too many requests/i.test(message)) {
    code = 'rate_limit';
  } else if (/quota|credits?\b|billing|insufficient funds/i.test(message)) {
    code = 'quota_exhausted';
  } else if (/model .*(not found|unavailable)|unknown model|no model/i.test(message)) {
    code = 'model_error';
  }
  return { type: 'error', code, error: message, ...(code === 'auth_error' ? { hint: LOGIN_HINT } : {}) };
}

// Pi's built-in tools, mapped to the short names the UI knows, with a one-line
// label from the tool arguments. Extension tools pass through by name.
function toolProgressOf(toolName: string, args: Record<string, unknown> | undefined): { tool: string; label?: string } {
  const trim = (value: unknown): string | undefined => {
    const s = typeof value === 'string' ? value.trim() : '';
    return s ? (s.length > 120 ? `${s.slice(0, 117)}...` : s) : undefined;
  };
  const label = trim(args?.command ?? args?.path ?? args?.pattern ?? args?.query);
  switch (toolName) {
    case 'bash':
    case 'powershell':
      return { tool: 'shell', label };
    case 'write':
    case 'edit':
      return { tool: 'edit', label };
    default:
      return { tool: toolName, label };
  }
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiEntry {
  type?: string;
  name?: string | null;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string | null;
    errorMessage?: string | null;
    usage?: PiUsage;
    timestamp?: number;
  };
}

/** The text of a pi message: its content blocks joined, or a bare string. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text?: string } => (block as { type?: string }).type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** A pi session file: one JSON entry per line. A partially written last line is skipped. */
function parseEntries(raw: string): PiEntry[] {
  const entries: PiEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PiEntry);
    } catch {
      // a partially written last line — skip it
    }
  }
  return entries;
}

interface ActiveTurn {
  child: ChildProcessWithoutNullStreams;
  interrupted: boolean;
  killTimer?: NodeJS.Timeout;
}

export class PiAdapter implements AgentAdapter {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private modelRows: { rows: Array<{ provider: string; model: string }>; at: number } | null = null;

  // The responses route calls this before a response begins: mint a UUID for a
  // new session (pi creates it on the first turn via --session-id), or verify an
  // existing one against pi's own store.
  async resolveSession(sessionId?: string): Promise<string> {
    requirePiBin();
    if (!sessionId) return randomUUID();
    if (!sessionFile(sessionId)) {
      throw validationError(`No Pi session with id '${sessionId}'.`, 'session_id');
    }
    return sessionId;
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    const bin = requirePiBin();
    const settings = options?.settings;
    // The prompt rides stdin, which pi prepends to the first message: as an argv
    // value it would be size-bound and `@path` in the text would attach a file.
    const args = ['--mode', 'json', '--session-id', sessionId, '--approve'];
    if (settings?.provider) args.push('--provider', settings.provider);
    if (settings?.model) args.push('--model', settings.model);
    const thinking = piThinking(settings?.reasoningEffort);
    if (thinking) args.push('--thinking', thinking);

    const child = spawn(bin, args, { cwd: workspaceCwd(), env: childEnv() });
    const turn: ActiveTurn = { child, interrupted: false };
    this.activeTurns.set(sessionId, turn);
    // A child that dies before reading its stdin (a bin that cannot exec, an argument
    // pi rejects) makes this write EPIPE; unhandled, that error takes the gateway down
    // instead of this one turn, which the stderr path below reports.
    child.stdin.on('error', () => {});
    child.stdin.end(message);

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });

    const tools = new Map<string, { tool: string; startedAt: number }>();
    // Pi runs one prompt as several assistant responses (a turn per tool round),
    // each reporting its own usage; the response bills their sum.
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let settled = false;
    let errorEvent: StreamEvent | undefined;

    try {
      for await (const line of jsonlLines(child.stdout)) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (event.type) {
          case 'message_update': {
            const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
            const delta = inner?.delta;
            if (!delta) break;
            if (inner?.type === 'text_delta') yield { type: 'text_delta', content: delta };
            else if (inner?.type === 'thinking_delta') yield { type: 'thinking_delta', content: delta };
            break;
          }
          case 'tool_execution_start': {
            const id = event.toolCallId as string;
            const progress = toolProgressOf(String(event.toolName ?? ''), event.args as Record<string, unknown>);
            tools.set(id, { tool: progress.tool, startedAt: Date.now() });
            yield { type: 'tool_progress', tool: progress.tool, status: 'running', label: progress.label };
            break;
          }
          case 'tool_execution_end': {
            const started = tools.get(event.toolCallId as string);
            if (!started) break;
            tools.delete(event.toolCallId as string);
            yield event.isError === true
              ? { type: 'tool_progress', tool: started.tool, status: 'error' }
              : { type: 'tool_progress', tool: started.tool, status: 'completed', duration: Date.now() - started.startedAt };
            break;
          }
          case 'turn_end': {
            const message = (event as PiEntry).message;
            const usage = message?.usage ?? {};
            outputTokens += usage.output ?? 0;
            inputTokens += Math.max(0, (usage.totalTokens ?? 0) - (usage.output ?? 0));
            costUsd += usage.cost?.total ?? 0;
            // A failed provider call ends the turn with stopReason "error". Pi retries
            // some of those itself (auto_retry_*, overflow compaction), and a run is
            // several responses anyway, so only the latest outcome counts: a recovered
            // turn must not report the error it recovered from.
            errorEvent =
              message?.stopReason === 'error'
                ? errorEventOf(message.errorMessage?.trim() || 'Pi ended the turn on an error.')
                : undefined;
            break;
          }
          case 'agent_settled':
            // Pi has no automatic work left for this run (retries and compaction
            // included), so the response is done.
            settled = true;
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
    } else if (settled) {
      const usage: TurnUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd > 0 ? costUsd : null,
      };
      yield { type: 'done', sessionId, usage, context: null, interrupted: false };
    } else {
      // Pi refuses an unresolvable model, and a model it has no key for, before
      // the stream opens: the reason is the first real line of stderr (the
      // session-created notice is a Warning, and a hint block follows the error).
      const detail = stderrTail
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('Warning:'));
      yield errorEventOf(detail || 'Pi ended the turn before it completed.');
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return false;
    turn.interrupted = true;
    turn.child.kill('SIGINT');
    // Backstop: if pi doesn't wind down after SIGINT, kill it outright.
    turn.killTimer = setTimeout(() => turn.child.kill('SIGKILL'), INTERRUPT_GRACE_MS);
    return true;
  }

  /** `pi --list-models` is pi's own answer to "what can this box run": it lists
   *  a provider's models only once that provider's credentials resolve. Cached
   *  briefly so the health probe doesn't spawn a process per request. */
  private async listModelRows(): Promise<Array<{ provider: string; model: string }>> {
    const cached = this.modelRows;
    if (cached && Date.now() - cached.at < MODELS_CACHE_MS) return cached.rows;
    const bin = requirePiBin();
    const stdout = await new Promise<string>((resolve) => {
      execFile(bin, ['--list-models'], { cwd: workspaceCwd(), env: childEnv(), timeout: 30_000, maxBuffer: 4 << 20 }, (error, out) => {
        resolve(error && !out ? '' : out);
      });
    });
    const rows = stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns.length >= 2 && columns[0] !== 'provider')
      .map(([provider, model]) => ({ provider, model }));
    this.modelRows = { rows, at: Date.now() };
    return rows;
  }

  async healthCheck(): Promise<boolean> {
    try {
      requirePiBin();
    } catch {
      return false;
    }
    // Pi is only ready when some provider's credentials resolve; without any,
    // every turn would fail on the provider call.
    return (await this.listModelRows()).length > 0;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const dir = sessionsDir();
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return [];
    }
    // A transcript is pi's whole session file. The reads are async so a list request
    // never holds the event loop for the length of every conversation on the box, and
    // sequential so it never holds more than one of them in memory at a time.
    const rows: SessionSummary[] = [];
    for (const name of names) {
      const id = /_([0-9a-f-]{36})\.jsonl$/i.exec(name)?.[1];
      if (!id) continue;
      const path = join(dir, name);
      let title: string | null = null;
      let messages = 0;
      for (const entry of parseEntries(await readFile(path, 'utf8').catch(() => ''))) {
        if (entry.type === 'session_info') title = entry.name?.trim() || null;
        else if (entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant')) messages += 1;
      }
      let lastActive: number | null = null;
      try {
        lastActive = Math.round(statSync(path).mtimeMs);
      } catch {
        // the file went away mid-list
      }
      rows.push({ id, title, last_active: lastActive, message_count: messages, preview: null });
    }
    return rows.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    // The route passes the raw path param; only UUID-shaped ids may touch the
    // store path (a traversal-shaped id must not resolve outside it).
    const path = sessionFile(sessionId);
    // The harness owns existence: an unknown/deleted session projects to [].
    if (!path) return [];

    const out: HermesMessage[] = [];
    let index = 0;
    for (const entry of parseEntries(await readFile(path, 'utf8').catch(() => ''))) {
      index += 1;
      const message = entry.message;
      if (entry.type !== 'message' || (message?.role !== 'user' && message?.role !== 'assistant')) continue;
      const content = messageText(message.content);
      if (!content.trim()) continue;
      out.push({
        id: `${sessionId}-${index}`,
        task_id: sessionId,
        role: message.role,
        content,
        created_at: epochMillis(message.timestamp) ?? 0,
      });
    }
    return out;
  }

  async getSessionMetadata(): Promise<SessionMetadata | null> {
    // No route reads this today; per-session cost stays in pi's store.
    return null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const path = sessionFile(sessionId);
    if (!path) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<AgentModelsResponse> {
    const rows = await this.listModelRows();
    const defaults = await this.getDefaults();
    const defaultModel = defaults.model;
    const groups = new Map<string, AgentModelsResponse['groups'][number]>();
    for (const { provider, model } of rows) {
      const group = groups.get(provider) ?? { provider, models: [] };
      group.models.push({
        id: model,
        label: model,
        source: 'catalog',
        provider,
        isCurrentDefault: model === defaultModel && provider === defaults.provider,
      });
      groups.set(provider, group);
    }
    return { defaultModel, activeProvider: defaults.provider, groups: [...groups.values()] };
  }

  async getDefaults(): Promise<AgentDefaults> {
    // Pi's startup provider/model live in its own settings file; our image points
    // them at the managed model, and a customer can repoint them.
    let settings: { defaultProvider?: unknown; defaultModel?: unknown } = {};
    try {
      settings = JSON.parse(readFileSync(join(piAgentDir(), 'settings.json'), 'utf8')) as typeof settings;
    } catch {
      // no settings file — pi picks a model from whatever is authenticated
    }
    return {
      provider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null,
      model: typeof settings.defaultModel === 'string' ? settings.defaultModel : null,
      baseUrl: null,
      apiMode: null,
      reasoningEffort: null,
      showReasoning: true,
    };
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.killTimer);
      turn.child.kill('SIGKILL');
    }
    this.activeTurns.clear();
  }
}

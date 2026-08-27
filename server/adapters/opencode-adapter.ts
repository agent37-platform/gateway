import { execFileSync } from 'node:child_process';
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
import { AsyncQueue, IdleChild } from './idle-child.js';
import { resolveWorkspaceDir } from '../paths.js';
import { validationError } from '../errors.js';
import {
  OpenCodeClient,
  OpenCodeError,
  spawnOpenCodeClient,
  type OpenCodeAssistantMessage,
  type OpenCodeErrorInfo,
  type OpenCodeEvent,
  type OpenCodePart,
  type OpenCodeProviders,
  type OpenCodeSession,
} from './opencode-server.js';

// The adapter drives OpenCode through a resident `opencode serve` (its local
// HTTP API plus one `/global/event` SSE stream), kept warm by the IdleChild and
// killed after ~10 idle minutes so a casual user costs zero RAM. A gateway
// session id IS an OpenCode session id: the harness store owns the id, so the
// responses route calls `resolveSession` before a response begins
// (create-on-first-turn, or verify an existing session). Sessions, history,
// rename and delete all go through OpenCode's own store — the gateway keeps no
// index. The managed Agent37 model rides in via the image's config
// (`provider.agent37`); BYO keys register their own providers from the instance
// env. The gateway never reads credentials.

const HEALTHY_TTL_MS = 60_000;
const UNHEALTHY_TTL_MS = 10_000;
// How long the resident server lingers after the last call before it is killed.
const IDLE_MS = Number(process.env.OPENCODE_IDLE_MS) || 600_000;
// After abort(), how long OpenCode gets to close the turn before the child is
// killed outright.
const INTERRUPT_GRACE_MS = 5_000;
// A turn that streams no event for this long is treated as stalled: the backend
// turn is aborted and the stream ends so the session lock releases.
const TURN_IDLE_MS = Number(process.env.OPENCODE_TURN_IDLE_MS) || 300_000;
const AUTH_HINT = 'Set the provider API key in the instance environment (e.g. OPENAI_API_KEY), or use the managed Agent37 model.';

// Our public effort ladder → OpenCode's prompt `variant`. OpenCode has no
// none/max/ultra of its own: `none` omits the variant, `max`/`ultra` map to
// `max` (its top reasoning), and each value is clamped at call time to the
// target model's advertised `variants` (a weaker model never rejects a turn).
const VARIANT_MAP: Record<ReasoningEffort, string | undefined> = {
  none: undefined,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
};

const VARIANT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The OpenCode variant one reasoning level maps to (before per-model clamping).
 *  Exported for the mapping tests. */
export function opencodeVariant(effort: ReasoningEffort | null | undefined): string | undefined {
  if (!effort) return undefined;
  return VARIANT_MAP[effort];
}

/** Clamp a nominal variant to a model's advertised set: the value itself if
 *  listed, else the highest listed value below it, else the lowest. A model
 *  that lists no variants gets none (undefined) — sending one it doesn't know
 *  would error. */
function clampVariant(nominal: string | undefined, listed: string[] | undefined): string | undefined {
  if (!nominal) return undefined;
  if (!listed || listed.length === 0) return undefined;
  if (listed.includes(nominal)) return nominal;
  const idx = VARIANT_LADDER.indexOf(nominal);
  for (let i = idx - 1; i >= 0; i--) {
    if (listed.includes(VARIANT_LADDER[i])) return VARIANT_LADDER[i];
  }
  for (const level of VARIANT_LADDER) if (listed.includes(level)) return level;
  return undefined;
}

/** Split a "providerID/modelID" model id (OpenClaw uses the same composite
 *  form). Returns null when the client passed no model or a bare id, so the
 *  turn falls back to OpenCode's configured default. */
function splitModel(model: string | null | undefined): { providerID: string; modelID: string } | null {
  if (!model) return null;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

const trim = (s?: string | null): string | undefined =>
  s && s.trim() ? (s.length > 120 ? `${s.slice(0, 117)}...` : s) : undefined;

/** Sum the prompt-side tokens of an assistant message: fresh input plus what
 *  the cache served. OpenCode's `input` is already cache-adjusted downward, so
 *  adding the cache counts is the true prompt size. */
function inputTokens(message: OpenCodeAssistantMessage): number {
  const t = message.tokens ?? {};
  return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
}

/** Map a tagged OpenCode error (`session.error` payload or an assistant
 *  message's `error`) to a worker error code + message. */
function errorEvent(info: OpenCodeErrorInfo): StreamEvent {
  const name = info.name;
  const message = info.data?.message || name || 'OpenCode ended the turn on an error.';
  const status = info.data?.statusCode;
  let code = 'agent_error';
  if (name === 'ProviderAuthError' || status === 401) code = 'auth_error';
  else if (status === 402) code = 'quota_exhausted';
  else if (status === 429) code = 'rate_limit';
  else if (name === 'ContextOverflowError' || name === 'MessageOutputLengthError' || name === 'ContentFilterError') {
    code = 'agent_error';
  }
  return {
    type: 'error',
    code,
    error: name && name !== 'APIError' && name !== 'UnknownError' ? `${name}: ${message}` : message,
    ...(code === 'auth_error' ? { hint: AUTH_HINT } : {}),
  };
}

let pathBin: string | null = null;

/** The `opencode` binary: OPENCODE_BIN, else the one on PATH. Throws ENOENT
 *  when neither exists — the gateway renders that as 503 agent_unavailable. */
function requireOpenCodeBin(): string {
  let bin = process.env.OPENCODE_BIN?.trim();
  if (!bin) {
    if (!pathBin) {
      try {
        pathBin = execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim() || null;
      } catch {
        pathBin = null;
      }
    }
    bin = pathBin ?? undefined;
  }
  if (!bin || !existsSync(bin)) {
    const error: NodeJS.ErrnoException = new Error(
      `OpenCode binary not found${bin ? ` at ${bin}` : ' on PATH'}. Install OpenCode or set OPENCODE_BIN.`,
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

interface ActiveTurn {
  client: OpenCodeClient;
  directory?: string;
  interrupted: boolean;
  fetchAbort: AbortController;
  killTimer?: NodeJS.Timeout;
}

interface ProvidersCache {
  at: number;
  windows: Map<string, number>; // "providerID/modelID" → context window
  variants: Map<string, string[]>; // "providerID/modelID" → advertised variants
  providers: OpenCodeProviders;
}

export class OpenCodeAdapter implements AgentAdapter {
  private readonly child = new IdleChild<OpenCodeClient>({
    idleMs: IDLE_MS,
    start: () => this.spawnWithRetry(),
  });
  private readonly activeTurns = new Map<string, ActiveTurn>();
  // OpenCode session id → its own working directory, cached from
  // create/resolve so a turn on a session created elsewhere (a terminal in a
  // different folder) runs its tools in the right place.
  private readonly sessionDir = new Map<string, string>();
  private health: { at: number; ok: boolean } | null = null;
  private providersCache: ProvidersCache | null = null;

  // OpenCode's shared SQLite can be locked while another OpenCode process (a
  // user's TUI) boots; retry the spawn a few times before giving up.
  private async spawnWithRetry(): ReturnType<typeof spawnOpenCodeClient> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await spawnOpenCodeClient(requireOpenCodeBin(), workspaceCwd());
      } catch (error) {
        lastError = error;
        if ((error as { name?: string }).name !== 'OpenCodeLockedError') throw error;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async loadProviders(client: OpenCodeClient): Promise<ProvidersCache> {
    if (this.providersCache && Date.now() - this.providersCache.at < HEALTHY_TTL_MS) {
      return this.providersCache;
    }
    const providers = await client.getProviders();
    const windows = new Map<string, number>();
    const variants = new Map<string, string[]>();
    for (const provider of providers.providers ?? []) {
      for (const model of Object.values(provider.models ?? {})) {
        const key = `${provider.id}/${model.id}`;
        if (model.limit?.context) windows.set(key, model.limit.context);
        const names = model.variants ? Object.keys(model.variants) : [];
        if (names.length) variants.set(key, names);
      }
    }
    this.providersCache = { at: Date.now(), windows, variants, providers };
    return this.providersCache;
  }

  // The responses route calls this before a response begins: create a session
  // (no id) or verify one (with id). The session id becomes the gateway session id.
  async resolveSession(sessionId?: string): Promise<string> {
    const client = await this.child.acquire();
    try {
      if (!sessionId) {
        const session = await client.createSession(workspaceCwd());
        if (session.directory) this.sessionDir.set(session.id, session.directory);
        return session.id;
      }
      let session: OpenCodeSession;
      try {
        session = await client.getSession(sessionId);
      } catch (error) {
        if (error instanceof OpenCodeError && error.status === 404) {
          throw validationError(`No OpenCode session with id '${sessionId}'.`, 'session_id');
        }
        throw error;
      }
      if (session.directory) this.sessionDir.set(sessionId, session.directory);
      return sessionId;
    } finally {
      this.child.release();
    }
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    requireOpenCodeBin();
    // The gateway already serializes turns it starts per session; this guards
    // against a turn OpenCode is running for another client (a terminal) on the
    // same session — OpenCode's prompt route never 409s, it silently joins.
    if (this.activeTurns.has(sessionId)) {
      yield { type: 'error', code: 'task_busy', error: 'A turn is already running on this session.' };
      return;
    }

    // A model must be one of OpenCode's own "provider/model" ids (as listed by
    // GET /v1/models?agent=opencode). Reject a bare or malformed id rather than
    // silently dropping it and running the default while the response mislabels
    // it as the requested model.
    const settings = options?.settings;
    const model = splitModel(settings?.model);
    if (settings?.model && !model) {
      yield {
        type: 'error',
        code: 'model_error',
        error: `model '${settings.model}' must be in "provider/model" form (see GET /v1/models?agent=opencode).`,
      };
      return;
    }

    const client = await this.child.acquire();
    const turn: ActiveTurn = {
      client,
      directory: this.sessionDir.get(sessionId),
      interrupted: false,
      fetchAbort: new AbortController(),
    };
    this.activeTurns.set(sessionId, turn);

    const queue = new AsyncQueue<OpenCodeEvent>();
    const partTypes = new Map<string, string>(); // partID → part type
    const toolsRunning = new Set<string>(); // partIDs that have emitted `running`
    const assistantMsgs = new Map<string, OpenCodeAssistantMessage>(); // id → latest
    let streamError: OpenCodeErrorInfo | undefined;
    // The text streamed via deltas so far, reconciled against the prompt
    // result's final parts at the end so a dropped SSE can't truncate output.
    let streamedText = '';

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void client.abort(sessionId, turn.directory).catch(() => {});
        // Cut the prompt fetch too, so the terminal `await promptDone` can't
        // hang if the abort doesn't settle the request.
        turn.fetchAbort.abort();
        queue.end();
      }, TURN_IDLE_MS);
      idleTimer.unref();
    };
    const unsubscribe = client.onEvent((event) => {
      if (event.properties?.sessionID !== sessionId) return;
      resetIdle();
      queue.push(event);
    });
    resetIdle();

    // Effort resolution needs the model's advertised variants, so refresh the
    // providers cache before firing (cheap and cached 60s).
    let variant: string | undefined;
    try {
      const providers = await this.loadProviders(client);
      const modelKey = model
        ? `${model.providerID}/${model.modelID}`
        : (await client.getConfig().catch(() => ({ model: undefined }))).model;
      variant = clampVariant(opencodeVariant(settings?.reasoningEffort), modelKey ? providers.variants.get(modelKey) : undefined);
    } catch {
      // A provider fetch failure is not fatal to the turn; run without a variant.
      variant = undefined;
    }

    // Fire the prompt (do not await): it resolves with the final { info, parts }
    // once the turn completes. Deltas arrive concurrently on the event stream.
    let settled: TurnSettled | undefined;
    const promptDone = client
      .prompt(
        sessionId,
        turn.directory,
        {
          agent: 'build',
          parts: [{ type: 'text', text: message }],
          ...(model ? { model } : {}),
          ...(variant ? { variant } : {}),
        },
        turn.fetchAbort.signal,
      )
      .then(
        (result) => {
          settled = { ok: true, result };
        },
        (error) => {
          settled = { ok: false, error };
        },
      )
      .finally(() => queue.end());

    try {
      for await (const event of queue) {
        const props = event.properties ?? {};
        switch (event.type) {
          case 'message.part.updated': {
            const part = props.part as OpenCodePart | undefined;
            if (!part) break;
            partTypes.set(part.id, part.type);
            if (part.type === 'tool') {
              const status = part.state?.status;
              if (status === 'running' && !toolsRunning.has(part.id)) {
                toolsRunning.add(part.id);
                yield { type: 'tool_progress', tool: part.tool || 'tool', status: 'running', label: trim(part.state?.title) };
              } else if (status === 'completed' && toolsRunning.delete(part.id)) {
                const start = part.state?.time?.start ?? 0;
                const end = part.state?.time?.end ?? Date.now();
                yield { type: 'tool_progress', tool: part.tool || 'tool', status: 'completed', duration: start ? end - start : undefined };
              } else if (status === 'error' && toolsRunning.delete(part.id)) {
                yield { type: 'tool_progress', tool: part.tool || 'tool', status: 'error', label: trim(part.state?.error) };
              }
            }
            break;
          }
          case 'message.part.delta': {
            const delta = props.delta as string | undefined;
            if (!delta) break;
            // Reasoning and text parts both stream as field "text"; classify by
            // the part type registered from message.part.updated.
            const type = partTypes.get(props.partID as string);
            if (type === 'reasoning') yield { type: 'thinking_delta', content: delta };
            else if (type === 'text') {
              streamedText += delta;
              yield { type: 'text_delta', content: delta };
            }
            break;
          }
          case 'message.updated': {
            const info = props.info as OpenCodeMessageInfo | undefined;
            if (info && info.role === 'assistant') assistantMsgs.set(info.id, info);
            break;
          }
          case 'session.error': {
            const err = props.error as OpenCodeErrorInfo | undefined;
            if (err) streamError = err;
            break;
          }
        }
      }
    } catch (error) {
      if (!settled) settled = { ok: false, error };
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(turn.killTimer);
      unsubscribe();
      this.activeTurns.delete(sessionId);
      this.child.release();
    }

    if (!settled) await promptDone;
    if (!settled) settled = { ok: false, error: new Error('OpenCode turn did not settle.') };

    if (turn.interrupted) {
      yield { type: 'done', sessionId, usage: null, interrupted: true };
      return;
    }
    if (!settled.ok) {
      const error = settled.error;
      const message = error instanceof Error ? error.message : 'OpenCode turn failed.';
      const code = error instanceof OpenCodeError && error.status === 401 ? 'auth_error' : 'agent_error';
      yield { type: 'error', code, error: message, ...(code === 'auth_error' ? { hint: AUTH_HINT } : {}) };
      return;
    }

    const info = settled.result.info;
    const failure = info.error ?? streamError;
    if (failure) {
      if (failure.name === 'MessageAbortedError') {
        yield { type: 'done', sessionId, usage: null, interrupted: true };
        return;
      }
      yield errorEvent(failure);
      return;
    }

    // The prompt result carries the turn's final text in its `text` parts. If
    // the event stream dropped mid-turn, the streamed deltas are a prefix of it
    // (or empty); emit the missing tail so `output_text` is never truncated. In
    // the normal case the two match and nothing extra is sent.
    const finalText = (settled.result.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
    if (finalText.length > streamedText.length && finalText.startsWith(streamedText)) {
      yield { type: 'text_delta', content: finalText.slice(streamedText.length) };
    }

    // Usage sums every assistant message of this turn (multi-step tool loops
    // emit several); each fires message.updated repeatedly, so dedupe by id and
    // match the turn by parentID = our user message.
    assistantMsgs.set(info.id, info);
    const parentId = info.parentID;
    const messages = [...assistantMsgs.values()].filter((m) => (parentId ? m.parentID === parentId : m.id === info.id));
    let inputTotal = 0;
    let outputTotal = 0;
    let costTotal = 0;
    for (const m of messages) {
      inputTotal += inputTokens(m);
      outputTotal += m.tokens?.output ?? 0;
      costTotal += m.cost ?? 0;
    }
    const usage: TurnUsage = { input_tokens: inputTotal, output_tokens: outputTotal, cost_usd: costTotal };

    // Context occupancy = the final message's prompt plus its output, against
    // the model's advertised window.
    const used = inputTokens(info) + (info.tokens?.output ?? 0);
    const window = info.providerID && info.modelID ? this.providersCache?.windows.get(`${info.providerID}/${info.modelID}`) : undefined;
    const context: ContextUsage | null = window && used > 0 ? { used_tokens: used, window_tokens: window } : null;

    yield { type: 'done', sessionId, usage, context, interrupted: false };
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return false;
    turn.interrupted = true;
    // Backstop: if the abort doesn't close the turn, cut the prompt fetch.
    turn.killTimer = setTimeout(() => turn.fetchAbort.abort(), INTERRUPT_GRACE_MS);
    try {
      await turn.client.abort(sessionId, turn.directory);
    } catch {
      turn.fetchAbort.abort();
    }
    return true;
  }

  async healthCheck(): Promise<boolean> {
    if (this.health && Date.now() - this.health.at < (this.health.ok ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS)) {
      return this.health.ok;
    }
    let ok: boolean;
    try {
      requireOpenCodeBin();
      // OpenCode is ready to chat as soon as the binary is present (the managed
      // model always answers). If the server is already warm, confirm it is
      // live; don't spawn a resident server just to answer a health probe.
      if (this.child.running) {
        const client = await this.child.acquire();
        try {
          ok = await client.health();
        } finally {
          this.child.release();
        }
      } else {
        ok = true;
      }
    } catch {
      ok = false;
    }
    this.health = { at: Date.now(), ok };
    return ok;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const client = await this.child.acquire();
    let sessions: OpenCodeSession[];
    try {
      sessions = await client.listSessions();
    } finally {
      this.child.release();
    }
    return (sessions ?? [])
      .filter((session) => !session.parentID) // top-level sessions only
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || null,
        last_active: session.time?.updated ?? session.time?.created ?? null,
        message_count: null,
        preview: null,
      }));
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    const client = await this.child.acquire();
    let rows: Awaited<ReturnType<OpenCodeClient['getMessages']>>;
    try {
      rows = await client.getMessages(sessionId);
    } catch (error) {
      // The harness owns existence: an unknown/deleted session projects to [].
      if (error instanceof OpenCodeError && error.status === 404) return [];
      throw error;
    } finally {
      this.child.release();
    }

    const out: HermesMessage[] = [];
    for (const row of rows ?? []) {
      const role = row.info.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = (row.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
      const thinking = (row.parts ?? [])
        .filter((p) => p.type === 'reasoning')
        .map((p) => p.text ?? '')
        .join('\n\n')
        .trim();
      if (!text.trim()) continue;
      out.push({
        id: row.info.id,
        task_id: sessionId,
        role,
        content: text,
        thinking: role === 'assistant' && thinking ? thinking : undefined,
        created_at: row.info.time?.created ?? 0,
      });
    }
    return out;
  }

  async getSessionMetadata(): Promise<SessionMetadata | null> {
    // No route reads this today.
    return null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const client = await this.child.acquire();
    try {
      await client.deleteSession(sessionId, this.sessionDir.get(sessionId));
      this.sessionDir.delete(sessionId);
      return true;
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) return false;
      throw error;
    } finally {
      this.child.release();
    }
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const client = await this.child.acquire();
    try {
      await client.renameSession(sessionId, title, this.sessionDir.get(sessionId));
      return true;
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) return false;
      throw error;
    } finally {
      this.child.release();
    }
  }

  async getModels(): Promise<AgentModelsResponse> {
    const client = await this.child.acquire();
    let providers: OpenCodeProviders;
    let defaultModel: string | null;
    try {
      // Force a fresh read so a newly-added BYO key shows up.
      this.providersCache = null;
      providers = (await this.loadProviders(client)).providers;
      defaultModel = (await client.getConfig().catch(() => ({ model: undefined }))).model ?? null;
    } finally {
      this.child.release();
    }
    const groups = (providers.providers ?? []).map((provider) => ({
      provider: provider.id,
      models: Object.values(provider.models ?? {}).map((model) => {
        const id = `${provider.id}/${model.id}`;
        return {
          id,
          label: model.name || model.id,
          source: 'catalog' as const,
          provider: provider.id,
          isCurrentDefault: id === defaultModel,
        };
      }),
    }));
    return {
      defaultModel,
      activeProvider: defaultModel ? defaultModel.split('/')[0] : (providers.providers?.[0]?.id ?? null),
      groups,
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: null, model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: true };
  }

  async stop(): Promise<void> {
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.killTimer);
      turn.fetchAbort.abort();
    }
    this.activeTurns.clear();
    await this.child.stop();
  }
}

// message.updated carries a full Message (user or assistant); we only read the
// assistant shape's usage fields.
type OpenCodeMessageInfo = OpenCodeAssistantMessage & { role: 'user' | 'assistant' };

// The outcome of the sync prompt call, captured off the event loop so the
// stream can drain first.
type TurnSettled =
  | { ok: true; result: Awaited<ReturnType<OpenCodeClient['prompt']>> }
  | { ok: false; error: unknown };

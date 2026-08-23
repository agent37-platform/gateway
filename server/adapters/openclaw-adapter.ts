import { randomUUID } from 'node:crypto';
import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentModelOption,
  HermesMessage,
  SessionMetadata,
  SessionSummary,
  TurnUsage,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, ContextUsage, StreamEvent } from './types.js';
import { epochMillis } from './types.js';
import { OpenClawSocket, type OpenClawEvent } from './openclaw-ws.js';

// The adapter speaks OpenClaw's WebSocket gateway RPC for everything: chat
// (`chat.send` + the broadcast `chat`/`agent` event streams), session
// management (`sessions.list/get/patch/delete`), and the model catalog
// (`models.list`). OpenClaw's HTTP surface is not used — it exposes none of
// the management API, cannot cancel a turn, and its `/v1/models` lists agent
// targets rather than LLMs.
export const DEFAULT_BASE_URL = 'http://localhost:18789';

// OpenClaw keys each gateway session as `openresponses-user:{gateway session
// id}` under its default agent (canonically `agent:main:openresponses-user:…`).
// The WS session RPCs resolve the partial key exactly like the HTTP routes
// did, so we keep addressing sessions by the short form.
const SESSION_KEY_PREFIX = 'openresponses-user:';

// How long one models.list result serves context-window lookups.
const MODEL_CATALOG_TTL_MS = 60_000;

// Our reasoning efforts map 1:1 onto OpenClaw thinking levels ('none' → 'off');
// OpenClaw additionally knows max/ultra/adaptive, which we never send.
const THINKING_MAP: Record<string, string> = {
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

function baseUrl(): string {
  return process.env.OPENCLAW_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
}

function wsUrl(): string {
  const url = new URL(baseUrl().replace(/^http/, 'ws'));
  const loopback = ['localhost', '::1', '[::1]'].includes(url.hostname) || url.hostname.startsWith('127.');
  if (url.protocol === 'ws:' && !loopback) {
    // Mirrors OpenClaw's own client policy: the shared token never rides
    // plaintext off the local machine.
    throw new Error(`OPENCLAW_BASE_URL must be https:// for remote hosts — refusing to send the OpenClaw token in cleartext to ${url.hostname}`);
  }
  return url.toString();
}

function sessionKeyFor(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

// Transcript message shape (sessions.get / chat.history). `content` is
// polymorphic: a bare string, or an array of typed blocks (text / thinking /
// toolCall). Assistant turns carry per-turn `usage` and the resolved `model`.
type OpenClawBlock = { type: string; text?: string; thinking?: string };
interface OpenClawMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  content: string | OpenClawBlock[];
  timestamp: number;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
}

// Flatten block content (or a bare string) to plain text of one kind.
function blockText(content: string | OpenClawBlock[], kind: 'text' | 'thinking'): string {
  if (typeof content === 'string') return kind === 'text' ? content : '';
  return content
    .filter((b) => b.type === kind)
    .map((b) => (kind === 'text' ? b.text : b.thinking) ?? '')
    .join('');
}

// `chat` event payloads (state union) and `agent` event payloads, trimmed to
// the fields we consume.
interface ChatEventPayload {
  runId?: string;
  state?: 'delta' | 'final' | 'aborted' | 'error';
  deltaText?: string;
  replace?: boolean;
  message?: OpenClawMessage;
  usage?: { input?: number; output?: number };
  errorMessage?: string;
  errorKind?: string;
}

interface AgentEventPayload {
  runId?: string;
  stream?: string;
  data?: { text?: string; delta?: string; name?: string; phase?: string };
}

interface ModelChoice {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
}

function usageFrom(message: OpenClawMessage | undefined, fallback?: { input?: number; output?: number }): TurnUsage | null {
  const usage = message?.usage ?? fallback;
  if (!usage) return null;
  return {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cost_usd: (usage as OpenClawMessage['usage'])?.cost?.total ?? null,
  };
}

// The model catalog values round-trip as `provider/model` (what sessions.patch
// expects); some catalog ids already carry the provider prefix.
function modelRef(provider: string, id: string): string {
  return id.toLowerCase().startsWith(`${provider.toLowerCase()}/`) ? id : `${provider}/${id}`;
}

// Transcript `model` values and catalog ids disagree on the provider prefix;
// compare on the bare model id.
function bareModelId(ref: string): string {
  const slash = ref.indexOf('/');
  return (slash >= 0 ? ref.slice(slash + 1) : ref).toLowerCase();
}

export class OpenClawAdapter implements AgentAdapter {
  private readonly socket = new OpenClawSocket(wsUrl, () => process.env.OPENCLAW_TOKEN?.trim() || undefined);
  private readonly activeRuns = new Map<string, string>();
  private modelCatalog: { at: number; models: ModelChoice[] } | null = null;

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    const { settings } = options ?? {};
    const sessionKey = sessionKeyFor(sessionId);
    const runId = randomUUID();

    // A model pick has no per-turn channel in OpenClaw, so it is applied as
    // session state — deliberately only when the turn names one, never cleared
    // here, so a model set through OpenClaw's own surfaces (channels, its UI)
    // is not clobbered by turns that don't choose.
    if (settings?.model) {
      await this.patchSession({ key: sessionKey, model: settings.model });
    }

    // Reasoning IS per-turn: chat.send's `thinking` overrides the session
    // level for this run only.
    const thinking = settings?.reasoningEffort ? THINKING_MAP[settings.reasoningEffort] : undefined;

    // Buffer events from subscription time so nothing lands between the
    // chat.send ack and the first read.
    const queue: OpenClawEvent[] = [];
    let wake: (() => void) | null = null;
    let dropped: Error | null = null;
    const unsubscribeEvents = this.socket.onEvent((event) => {
      if (event.event !== 'chat' && event.event !== 'agent') return;
      if ((event.payload as ChatEventPayload).runId !== runId) return;
      queue.push(event);
      wake?.();
    });
    const unsubscribeClose = this.socket.onClose(() => {
      dropped = new Error('OpenClaw gateway connection dropped mid-turn');
      (dropped as NodeJS.ErrnoException).code = 'ECONNRESET';
      wake?.();
    });

    this.activeRuns.set(sessionId, runId);
    try {
      const ack = await this.socket.request<{ status?: string }>('chat.send', {
        sessionKey,
        message,
        idempotencyKey: runId,
        ...(thinking ? { thinking } : {}),
      });
      // OpenClaw can ack ok WITHOUT starting a run — its plain-text stop
      // commands ("stop", "exit", …) and restart/admission races — and then
      // no event ever carries this runId. Anything but a fresh start is
      // terminal here, or the stream would wait forever and wedge the
      // session behind session_busy.
      if (ack.status !== 'started') {
        yield { type: 'done', sessionId, usage: null, interrupted: true };
        return;
      }

      // Text and thinking arrive both as increments and as cumulative
      // refreshes (`replace` deltas / cumulative agent text); emitted-length
      // counters keep the output append-only either way.
      let sentText = 0;
      let sentThinking = 0;

      while (true) {
        if (queue.length === 0) {
          if (dropped) throw dropped;
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (dropped) resolve();
          });
          wake = null;
          continue;
        }
        const { event, payload } = queue.shift()!;

        if (event === 'agent') {
          const agent = payload as AgentEventPayload;
          if (agent.stream === 'thinking') {
            const cumulative = agent.data?.text;
            let delta = agent.data?.delta ?? '';
            if (!delta && typeof cumulative === 'string' && cumulative.length > sentThinking) {
              delta = cumulative.slice(sentThinking);
            }
            if (delta) {
              sentThinking += delta.length;
              yield { type: 'thinking_delta', content: delta };
            }
          } else if (agent.stream === 'tool' && agent.data?.name) {
            const phase = agent.data.phase;
            if (phase === 'start' || phase === 'result') {
              yield {
                type: 'tool_progress',
                tool: agent.data.name,
                status: phase === 'start' ? 'running' : 'completed',
              };
            }
          }
          continue;
        }

        const chat = payload as ChatEventPayload;
        switch (chat.state) {
          case 'delta': {
            if (chat.replace) {
              const full = blockText(chat.message?.content ?? chat.deltaText ?? '', 'text');
              if (full.length > sentText) {
                yield { type: 'text_delta', content: full.slice(sentText) };
                sentText = full.length;
              }
            } else if (chat.deltaText) {
              sentText += chat.deltaText.length;
              yield { type: 'text_delta', content: chat.deltaText };
            }
            break;
          }
          case 'final': {
            const full = chat.message ? blockText(chat.message.content, 'text') : '';
            if (full.length > sentText) {
              yield { type: 'text_delta', content: full.slice(sentText) };
            }
            // The live final event usually omits usage; the transcript's last
            // assistant message carries the authoritative numbers.
            let message = chat.message;
            if (!message?.usage) message = (await this.lastAssistantMessage(sessionId)) ?? message;
            const usage = usageFrom(message, chat.usage);
            yield { type: 'done', sessionId, usage, context: await this.contextUsage(message), interrupted: false };
            return;
          }
          case 'aborted':
            yield { type: 'done', sessionId, usage: usageFrom(chat.message, chat.usage), interrupted: true };
            return;
          case 'error':
            yield {
              type: 'error',
              error: chat.errorMessage ?? 'OpenClaw error',
              code: chat.errorKind,
            };
            return;
        }
      }
    } finally {
      unsubscribeEvents();
      unsubscribeClose();
      this.activeRuns.delete(sessionId);
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const runId = this.activeRuns.get(sessionId);
    if (!runId) return false;
    // The run then terminates through its own `state:'aborted'` chat event,
    // which ends the stream above.
    const result = await this.socket.request<{ aborted?: boolean }>('chat.abort', {
      sessionKey: sessionKeyFor(sessionId),
      runId,
    });
    return result.aborted === true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.socket.ensureConnected();
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.socket.request<{ sessions?: Record<string, unknown>[] }>('sessions.list', {
      limit: 1000,
    });
    // Keep the sessions this gateway created and surface the `{user}` part as
    // `id`, so each entry round-trips to `GET /v1/sessions/:id`. OpenClaw's
    // `label` (what rename writes) and `updatedAt` become the contract's
    // `title`/`last_active`; it tracks no message count or preview.
    return (result.sessions ?? [])
      .filter((s): s is Record<string, unknown> & { key: string } =>
        typeof s.key === 'string' && s.key.includes(SESSION_KEY_PREFIX))
      .map((s) => ({
        id: s.key.slice(s.key.indexOf(SESSION_KEY_PREFIX) + SESSION_KEY_PREFIX.length),
        title: typeof s.label === 'string' && s.label.trim() ? s.label : null,
        last_active: epochMillis(s.updatedAt),
        message_count: null,
        preview: null,
      }));
  }

  private async lastAssistantMessage(sessionId: string): Promise<OpenClawMessage | null> {
    try {
      const result = await this.socket.request<{ messages?: OpenClawMessage[] }>('sessions.get', {
        key: sessionKeyFor(sessionId),
        limit: 10,
      });
      return [...(result.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.usage) ?? null;
    } catch {
      return null;
    }
  }

  // OpenClaw reports no context measurement on the wire, so derive it: the
  // assistant message's usage totals are the tokens occupying the window after
  // the turn, and the model's catalog entry carries the window size.
  private async contextUsage(message: OpenClawMessage | undefined): Promise<ContextUsage | null> {
    const usage = message?.usage;
    const model = message?.model;
    if (!usage || !model) return null;
    const used =
      usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (used <= 0) return null;
    try {
      const entry = (await this.cachedModels()).find(
        (m) => m.available !== false && bareModelId(m.id) === bareModelId(model),
      );
      return entry?.contextWindow && entry.contextWindow > 0
        ? { used_tokens: used, window_tokens: entry.contextWindow }
        : null;
    } catch {
      return null;
    }
  }

  private async cachedModels(): Promise<ModelChoice[]> {
    if (this.modelCatalog && Date.now() - this.modelCatalog.at < MODEL_CATALOG_TTL_MS) {
      return this.modelCatalog.models;
    }
    return await this.fetchModels();
  }

  private async fetchModels(): Promise<ModelChoice[]> {
    const result = await this.socket.request<{ models?: ModelChoice[] }>('models.list', { view: 'configured' });
    const models = result.models ?? [];
    if (models.length > 0) this.modelCatalog = { at: Date.now(), models };
    return models;
  }

  private async fetchHistory(sessionId: string): Promise<OpenClawMessage[]> {
    const result = await this.socket.request<{ messages?: OpenClawMessage[] }>('sessions.get', {
      key: sessionKeyFor(sessionId),
      limit: 500,
    });
    return result.messages ?? [];
  }

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    const messages = await this.fetchHistory(sessionId);
    // Keep user/assistant turns with visible text; tool plumbing (toolResult,
    // tool-call-only turns) is dropped. Reasoning rides along when present.
    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: blockText(m.content, 'text'),
        thinking: blockText(m.content, 'thinking') || undefined,
        created_at: m.timestamp,
      }))
      .filter((m) => m.content.length > 0)
      .map((m, i) => ({ id: `openclaw:${sessionId}:${i}`, task_id: sessionId, ...m }));
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const messages = await this.fetchHistory(sessionId);
    if (messages.length === 0) return null;
    // Aggregate the per-turn usage that rides on assistant messages.
    const meta: SessionMetadata = {
      id: sessionId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      estimated_cost_usd: 0,
      cost_status: null,
      model: null,
    };
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.usage) continue;
      meta.input_tokens += m.usage.input ?? 0;
      meta.output_tokens += m.usage.output ?? 0;
      meta.cache_read_tokens += m.usage.cacheRead ?? 0;
      meta.cache_write_tokens += m.usage.cacheWrite ?? 0;
      meta.estimated_cost_usd = (meta.estimated_cost_usd ?? 0) + (m.usage.cost?.total ?? 0);
      if (m.model) meta.model = m.model;
    }
    return meta;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    // Removes the session entry and archives its transcript off the active
    // path. An unknown key reports deleted:false rather than an error.
    const result = await this.socket.request<{ deleted?: boolean }>('sessions.delete', {
      key: sessionKeyFor(sessionId),
      deleteTranscript: true,
    });
    return result.deleted === true;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    try {
      await this.patchSession({ key: sessionKeyFor(sessionId), label: title });
    } catch (error) {
      // OpenClaw session labels are unique; surface a clash as the documented
      // 409, matching the Hermes title semantics.
      if (error instanceof Error && error.message.includes('label already in use')) {
        (error as NodeJS.ErrnoException).code = 'title_conflict';
      }
      throw error;
    }
    return true;
  }

  // sessions.patch compare-and-sets against the session entry, and a patch
  // landing right after a turn can lose to the run's own bookkeeping write.
  // OpenClaw's conflict error literally instructs "Retry." — one retry is the
  // protocol, not defensiveness.
  private async patchSession(params: Record<string, unknown>): Promise<void> {
    try {
      await this.socket.request('sessions.patch', params);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('changed before')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await this.socket.request('sessions.patch', params);
    }
  }

  async getModels(): Promise<AgentModelsResponse> {
    const models = await this.fetchModels();
    const byProvider = new Map<string, AgentModelOption[]>();
    for (const model of models) {
      if (model.available === false) continue;
      const options = byProvider.get(model.provider) ?? [];
      options.push({
        id: modelRef(model.provider, model.id),
        label: model.alias ?? model.name,
        source: 'catalog',
        provider: model.provider,
        isCurrentDefault: false,
      });
      byProvider.set(model.provider, options);
    }
    return {
      defaultModel: null,
      activeProvider: 'openclaw',
      groups: [...byProvider.entries()].map(([provider, models]) => ({ provider, models })),
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: null, model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: false };
  }

  async stop(): Promise<void> {
    this.socket.close();
  }
}

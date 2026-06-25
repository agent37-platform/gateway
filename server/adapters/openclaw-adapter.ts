import type {
  AgentDefaults,
  AgentModelsResponse,
  HermesMessage,
  SessionMetadata,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// OpenClaw's gateway serves an OpenResponses-compatible `POST /v1/responses`
// (must be enabled via `gateway.http.endpoints.responses.enabled` in
// openclaw.json) plus `GET /v1/models` and `/health`. Session history reads
// through `GET /sessions/{key}/history`, where the key is
// `openresponses-user:{user}` — OpenClaw stores each turn we send under the
// `user` we pass and resolves that partial key to the full session. There is
// no HTTP route to list sessions or delete a transcript, nor to cancel a turn;
// `listSessions` therefore shells out to the `openclaw` CLI.
export const DEFAULT_BASE_URL = 'http://localhost:18789';

// OpenClaw keys each gateway session as `openresponses-user:{gateway session id}`.
// We build that key when reading history and strip it back off when listing.
const SESSION_KEY_PREFIX = 'openresponses-user:';

function baseUrl(): string {
  return process.env.OPENCLAW_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
}

function authHeaders(): Record<string, string> {
  const token = process.env.OPENCLAW_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// OpenClaw serves its web UI as a catch-all, so an unknown route (e.g. an older
// OpenClaw without the /sessions/{key}/history route) answers 200 text/html
// rather than 404. Treat any non-JSON body as "endpoint absent" so we degrade
// to empty history instead of choking on `<!doctype …>` in res.json().
function isJson(res: Response): boolean {
  return res.headers.get('content-type')?.includes('application/json') ?? false;
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let currentEvent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:') && currentEvent) {
          yield { event: currentEvent, data: line.slice(5).trim() };
          currentEvent = '';
        } else if (line === '') {
          currentEvent = '';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface OpenResponsesEnvelope {
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { code?: string; message?: string };
  };
  delta?: string;
}

// `GET /sessions/{key}/history` message shape. `content` is polymorphic: a bare
// string, or an array of typed blocks (text / thinking / toolCall). Assistant
// turns also carry per-turn `usage` and the resolved `model`.
type OpenClawBlock = { type: string; text?: string; thinking?: string };
interface OpenClawMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  content: string | OpenClawBlock[];
  timestamp: number;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

// Flatten block content (or a bare string) to plain text of one kind.
function blockText(content: string | OpenClawBlock[], kind: 'text' | 'thinking'): string {
  if (typeof content === 'string') return kind === 'text' ? content : '';
  return content
    .filter((b) => b.type === kind)
    .map((b) => (kind === 'text' ? b.text : b.thinking) ?? '')
    .join('');
}

// The gateway accepts none..xhigh; OpenClaw only low|medium|high. 'none' is intentionally
// left unmapped (undefined) so no reasoning param is sent.
const EFFORT_MAP: Record<string, 'low' | 'medium' | 'high'> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
};

export class OpenClawAdapter implements AgentAdapter {
  private activeRuns = new Map<string, AbortController>();

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    const { settings } = options ?? {};
    const effort = settings?.reasoningEffort ? EFFORT_MAP[settings.reasoningEffort] : undefined;

    const controller = new AbortController();
    this.activeRuns.set(sessionId, controller);

    try {
      // The request schema is strict: unknown fields are rejected, `model` is
      // required, and `user` is what keys the conversation to a session.
      const res = await fetch(`${baseUrl()}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders() },
        signal: controller.signal,
        body: JSON.stringify({
          // OpenClaw rejects requests without `model`. When the turn doesn't
          // set one, bare "openclaw" routes to its default agent; the
          // session's model stays null gateway-side.
          model: settings?.model || 'openclaw',
          input: message,
          user: sessionId,
          stream: true,
          reasoning: effort ? { effort } : undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenClaw POST /v1/responses → ${res.status}: ${body}`);
      }

      if (!res.body) throw new Error('OpenClaw response has no body');

      for await (const { event, data } of parseSSE(res.body)) {
        let payload: OpenResponsesEnvelope;
        try {
          payload = JSON.parse(data) as OpenResponsesEnvelope;
        } catch {
          continue;
        }

        switch (event) {
          case 'response.output_text.delta':
            yield { type: 'text_delta', content: payload.delta ?? '' };
            break;
          case 'response.completed': {
            const usage = payload.response?.usage;
            yield {
              type: 'done',
              sessionId,
              usage: usage
                ? {
                    input_tokens: usage.input_tokens ?? 0,
                    output_tokens: usage.output_tokens ?? 0,
                    cost_usd: null,
                  }
                : null,
              interrupted: false,
            };
            break;
          }
          case 'response.failed': {
            const err = payload.response?.error;
            yield {
              type: 'error',
              error: err?.message ?? 'OpenClaw error',
              code: err?.code,
            };
            break;
          }
        }
      }
    } catch (error) {
      // OpenClaw has no cancel API; an interrupt aborts our stream and the
      // turn ends as cancelled. OpenClaw may keep working server-side.
      if (controller.signal.aborted) {
        yield { type: 'done', sessionId, usage: null, interrupted: true };
        return;
      }
      throw error;
    } finally {
      this.activeRuns.delete(sessionId);
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const controller = this.activeRuns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl()}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  // Raw transcript for a session, read through OpenClaw's history endpoint. The
  // `user` we send on each turn keys the session as `openresponses-user:{user}`,
  // which OpenClaw resolves from this partial key.
  private async fetchHistory(sessionId: string): Promise<OpenClawMessage[]> {
    const key = `${SESSION_KEY_PREFIX}${sessionId}`;
    const res = await fetch(
      `${baseUrl()}/sessions/${encodeURIComponent(key)}/history?limit=500`,
      { headers: authHeaders() },
    );
    if (res.status === 404 || !isJson(res)) return []; // unknown session / no history API
    if (!res.ok) throw new Error(`OpenClaw GET /sessions/{key}/history → ${res.status}`);
    const { messages } = await res.json() as { messages?: OpenClawMessage[] };
    return messages ?? [];
  }

  async listSessions(): Promise<Record<string, unknown>[]> {
    // OpenClaw's session list (`sessions.list`) is a gateway RPC, never exposed on
    // the HTTP surface (only `/sessions/{key}/history` is). The supported machine
    // path is the `openclaw` CLI, which reads the on-disk session store directly.
    // We keep the sessions the gateway created — keyed `openresponses-user:{user}`
    // under the default agent — and surface that `{user}` as `id`, so each entry
    // round-trips to `GET /v1/sessions/:id` (which reads `openresponses-user:{id}`).
    const { stdout } = await execFileAsync(
      'openclaw',
      ['sessions', 'list', '--json', '--limit', 'all'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const { sessions } = JSON.parse(stdout) as { sessions?: Record<string, unknown>[] };
    return (sessions ?? [])
      .filter((s): s is Record<string, unknown> & { key: string } =>
        typeof s.key === 'string' && s.key.includes(SESSION_KEY_PREFIX))
      .map((s) => ({ ...s, id: s.key.slice(s.key.indexOf(SESSION_KEY_PREFIX) + SESSION_KEY_PREFIX.length) }));
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
    // OpenClaw has no HTTP session-meta route; aggregate the per-turn usage that
    // rides on assistant messages instead.
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

  async deleteSession(): Promise<boolean> {
    // OpenClaw 2026.6.5 exposes no HTTP route to delete a stored transcript
    // (only `/sessions/{key}/kill`, which aborts an active run). The gateway
    // keeps no records of its own, so a delete is a no-op here.
    return false;
  }

  async getModels(): Promise<AgentModelsResponse> {
    const res = await fetch(`${baseUrl()}/v1/models`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`OpenClaw GET /v1/models → ${res.status}`);
    const data = await res.json() as { data: { id: string }[] };
    return {
      defaultModel: null,
      activeProvider: 'openclaw',
      groups: [{
        provider: 'openclaw',
        models: data.data.map((m) => ({
          id: m.id,
          label: m.id,
          source: 'catalog',
          provider: 'openclaw',
          isCurrentDefault: false,
        })),
      }],
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: null, model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: false };
  }
}

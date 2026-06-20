import type {
  AgentDefaults,
  AgentModelsResponse,
  HermesMessage,
  SessionMetadata,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';

// OpenClaw's gateway serves an OpenResponses-compatible `POST /v1/responses`
// (must be enabled via `gateway.http.endpoints.responses.enabled` in
// openclaw.json) plus `GET /v1/models` and `/health`. Session history and
// deletion read through to `/v1/conversations/{user}` (keyed by the `user` we
// send on each turn); there is still no API for cancelling a turn.
export const DEFAULT_BASE_URL = 'http://localhost:18789';

function baseUrl(): string {
  return process.env.OPENCLAW_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
}

function authHeaders(): Record<string, string> {
  const token = process.env.OPENCLAW_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
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

// `/v1/conversations/{user}` projections. Keyed by the `user` value we send on
// each turn (the gateway session id), mirroring Hermes' session.* shapes.
interface OpenClawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
  reasoning?: string | null;
}

interface OpenClawConversationMeta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number | null;
  model?: string | null;
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

  async getMessages(sessionId: string): Promise<HermesMessage[]> {
    const res = await fetch(
      `${baseUrl()}/v1/conversations/${encodeURIComponent(sessionId)}/messages`,
      { headers: authHeaders() },
    );
    if (res.status === 404) return []; // unknown conversation, not an error
    if (!res.ok) throw new Error(`OpenClaw GET /v1/conversations → ${res.status}`);
    const { data } = await res.json() as { data: OpenClawMessage[] };
    return data.map((m, i) => ({
      id: `openclaw:${sessionId}:${i}`,
      task_id: sessionId,
      role: m.role,
      content: m.content,
      thinking: m.reasoning ?? undefined,
      created_at: m.created_at,
    }));
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const res = await fetch(
      `${baseUrl()}/v1/conversations/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OpenClaw GET /v1/conversations → ${res.status}`);
    const m = await res.json() as OpenClawConversationMeta;
    return {
      id: sessionId,
      input_tokens: m.input_tokens ?? 0,
      output_tokens: m.output_tokens ?? 0,
      cache_read_tokens: m.cache_read_tokens ?? 0,
      cache_write_tokens: m.cache_write_tokens ?? 0,
      reasoning_tokens: m.reasoning_tokens ?? 0,
      estimated_cost_usd: m.estimated_cost_usd ?? null,
      cost_status: null,
      model: m.model ?? null,
    };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await fetch(
      `${baseUrl()}/v1/conversations/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    return res.ok;
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

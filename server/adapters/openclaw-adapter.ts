import type {
  AgentDefaults,
  AgentModelsResponse,
  HermesMessage,
  ModelsListResponse,
  SessionMetadata,
  SessionWithHistory,
  TurnUsage,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:3738';

function baseUrl(): string {
  return process.env.OPENCLAW_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
}

async function ocFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenClaw ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res;
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

export class OpenClawAdapter implements AgentAdapter {
  private activeResponses = new Map<string, string>();

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    const { settings } = options ?? {};

    const res = await fetch(`${baseUrl()}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        input: message,
        session_id: sessionId,
        stream: true,
        agent: 'openclaw',
        model: settings?.model ?? undefined,
        provider: settings?.provider ?? undefined,
        reasoning_effort: settings?.reasoningEffort ?? undefined,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenClaw POST /v1/responses → ${res.status}: ${body}`);
    }

    if (!res.body) throw new Error('OpenClaw response has no body');

    try {
      for await (const { event, data } of parseSSE(res.body)) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (event) {
          case 'response.created':
            if (typeof payload.id === 'string') {
              this.activeResponses.set(sessionId, payload.id);
            }
            break;
          case 'response.output_text.delta':
            yield { type: 'text_delta', content: (payload.text as string) ?? '' };
            break;
          case 'response.reasoning.delta':
            yield { type: 'thinking_delta', content: (payload.text as string) ?? '' };
            break;
          case 'response.tool_call.started':
            yield {
              type: 'tool_progress',
              tool: (payload.tool as string) ?? 'tool',
              status: 'running',
              label: payload.label as string | undefined,
            };
            break;
          case 'response.tool_call.completed':
            yield {
              type: 'tool_progress',
              tool: (payload.tool as string) ?? 'tool',
              status: 'completed',
              duration: payload.duration_ms as number | undefined,
            };
            break;
          case 'response.tool_call.failed':
            yield {
              type: 'tool_progress',
              tool: (payload.tool as string) ?? 'tool',
              status: 'error',
              label: payload.error as string | undefined,
            };
            break;
          case 'response.completed':
            yield {
              type: 'done',
              sessionId,
              usage: (payload.usage as TurnUsage) ?? null,
              interrupted: false,
            };
            break;
          case 'response.failed': {
            const err = payload.error as { code?: string; message?: string; hint?: string } | undefined;
            yield {
              type: 'error',
              error: err?.message ?? 'OpenClaw error',
              code: err?.code,
              hint: err?.hint,
            };
            break;
          }
        }
      }
    } finally {
      this.activeResponses.delete(sessionId);
    }
  }

  async interruptChat(sessionId: string): Promise<boolean> {
    const responseId = this.activeResponses.get(sessionId);
    if (!responseId) return false;
    try {
      await ocFetch(`/v1/responses/${encodeURIComponent(responseId)}/cancel`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
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
    const res = await ocFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    const data = await res.json() as SessionWithHistory;
    return data.history.map((m) => ({
      id: m.id,
      task_id: sessionId,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      created_at: m.created_at,
    }));
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    try {
      const res = await ocFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`);
      const data = await res.json() as SessionWithHistory;
      return {
        id: data.id,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: null,
        cost_status: null,
        model: data.model,
      };
    } catch {
      return null;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const res = await ocFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      const data = await res.json() as { deleted: boolean };
      return data.deleted;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<AgentModelsResponse> {
    const res = await ocFetch('/v1/models');
    const data = await res.json() as ModelsListResponse;
    const groupMap = new Map<string, AgentModelsResponse['groups'][0]>();
    for (const model of data.data) {
      const provider = model.provider ?? 'unknown';
      if (!groupMap.has(provider)) groupMap.set(provider, { provider, models: [] });
      groupMap.get(provider)!.models.push({
        id: model.id,
        label: model.label,
        source: 'catalog',
        provider: model.provider,
        isCurrentDefault: model.is_default,
      });
    }
    return {
      defaultModel: data.default_model,
      activeProvider: data.default_provider,
      groups: [...groupMap.values()],
    };
  }

  async getDefaults(): Promise<AgentDefaults> {
    return { provider: null, model: null, baseUrl: null, apiMode: null, reasoningEffort: null, showReasoning: false };
  }
}

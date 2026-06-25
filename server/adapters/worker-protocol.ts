import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentRunSettings,
  ContextUsage,
  GoalDecision,
  GoalStateSnapshot,
  HermesMessage,
  SessionMetadata,
  TurnUsage,
} from '../../shared/types.js';

export type WorkerRequest =
  | { id: string; type: 'health' }
  | { id: string; type: 'settings.get' }
  | { id: string; type: 'settings.set'; provider?: string | null; model?: string | null; reasoningEffort?: string | null }
  | { id: string; type: 'models.list' }
  | { id: string; type: 'sessions.list' }
  | { id: string; type: 'session.messages.get'; sessionId: string; taskId?: string }
  | { id: string; type: 'session.get'; sessionId: string }
  | { id: string; type: 'session.delete'; sessionId: string }
  | { id: string; type: 'session.set_title'; sessionId: string; title: string }
  | { id: string; type: 'goal.status'; sessionId: string }
  | { id: string; type: 'goal.set'; sessionId: string; goal: string; maxTurns?: number | null }
  | { id: string; type: 'goal.pause'; sessionId: string; reason?: string }
  | { id: string; type: 'goal.resume'; sessionId: string }
  | { id: string; type: 'goal.clear'; sessionId: string }
  | { id: string; type: 'goal.evaluate'; sessionId: string; responseText: string }
  | { id: string; type: 'chat.interrupt'; sessionId: string; taskId?: string; reason?: string }
  | {
      id: string;
      type: 'chat';
      sessionId: string;
      message: string;
      systemMessage?: string;
      settings: AgentRunSettings;
      taskId?: string;
      taskTitle?: string | null;
    };

export interface WorkerErrorPayload {
  message: string;
  code?: string;
  hint?: string;
}

export type WorkerResult =
  | { ok: boolean; agentDir?: string | null; python?: string | null }
  | AgentDefaults
  | AgentModelsResponse
  | { sessions: Record<string, unknown>[] }
  | { messages: HermesMessage[] }
  | { session: SessionMetadata | null }
  | { deleted: boolean }
  | { renamed: boolean }
  | { goal: GoalStateSnapshot | null }
  | { cleared: boolean }
  | { interrupted: boolean }
  | GoalDecision;

export type WorkerEvent =
  | { id: string; type: 'result'; data: WorkerResult }
  | { id: string; type: 'text_delta'; content?: string }
  | { id: string; type: 'thinking_delta'; content?: string }
  | {
      id: string;
      type: 'tool_progress';
      tool?: string;
      status?: 'running' | 'completed' | 'error';
      duration?: number;
      label?: string | null;
    }
  | {
      id: string;
      type: 'done';
      sessionId?: string;
      context?: ContextUsage | null;
      usage?: TurnUsage | null;
      interrupted?: boolean;
    }
  | { id: string; type: 'error'; error: string | WorkerErrorPayload };

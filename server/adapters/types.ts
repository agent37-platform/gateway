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

export type { AgentRunSettings, ContextUsage };

export interface AgentRunOptions {
  /** Optional system prompt. The gateway is a thin passthrough and normally
   *  leaves this unset, so the caller's input reaches the agent verbatim. */
  systemMessage?: string;
  settings?: AgentRunSettings;
}

/** A normalized streaming event from an agent turn. */
export interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_progress' | 'done' | 'error';
  content?: string;
  error?: string;
  code?: string;
  hint?: string;
  sessionId?: string;
  tool?: string;
  status?: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
  context?: ContextUsage | null;
  usage?: TurnUsage | null;
  interrupted?: boolean;
}

/**
 * The seam every harness backend implements. The registry (server/agent.ts) wires
 * up multiple adapters — HermesWorkerAdapter and OpenClawAdapter today, Claude Code
 * next — and a request routes to one via `agent`. (A given container only reaches
 * the backend(s) it was provisioned with.)
 */
export interface AgentAdapter {
  /** Stream a single turn. The async iterable ends after a `done` or `error`. */
  chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent>;

  /** Stop a running turn for a session. Returns whether anything was stopped. */
  interruptChat(sessionId: string, reason?: string): Promise<boolean>;

  /** True when the backend is reachable and ready. */
  healthCheck(): Promise<boolean>;

  /** The backend's own session list, native fields passed through untouched.
   *  Backends without a list API return []. */
  listSessions(): Promise<Record<string, unknown>[]>;

  /** Projected transcript for a session, from the backend's own store. */
  getMessages(sessionId: string): Promise<HermesMessage[]>;

  /** Token/cost metadata for a session. */
  getSessionMetadata(sessionId: string): Promise<SessionMetadata | null>;

  /** Best-effort delete of the backend's transcript for a session. */
  deleteSession(sessionId: string): Promise<boolean>;

  /** Rename a session (set its title) in the backend's own store. Optional: a
   *  backend implements it only when it natively stores an editable, round-
   *  trippable title; the route answers 405 for harnesses that don't. Returns
   *  whether a session was renamed (false when no session matched the id). */
  renameSession?(sessionId: string, title: string): Promise<boolean>;

  /** Models the backend can run. */
  getModels(): Promise<AgentModelsResponse>;

  /** The backend's current default model/provider/reasoning. */
  getDefaults(): Promise<AgentDefaults>;
}

/** Goal-mode primitives, implemented by the worker and reserved for the
 *  goal-mode fast-follow. Not part of the v1 request path. */
export interface GoalCapableAdapter {
  getGoalStatus(sessionId: string): Promise<GoalStateSnapshot | null>;
  setGoal(sessionId: string, goal: string, options?: { maxTurns?: number | null }): Promise<GoalStateSnapshot>;
  pauseGoal(sessionId: string, reason?: string): Promise<GoalStateSnapshot | null>;
  resumeGoal(sessionId: string): Promise<GoalStateSnapshot | null>;
  clearGoal(sessionId: string): Promise<boolean>;
  evaluateGoal(sessionId: string, responseText: string): Promise<GoalDecision>;
}

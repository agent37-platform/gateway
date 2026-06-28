// Types shared by the gateway server and (eventually) any TypeScript client.
//
// Two families live here:
//   1. The public API surface — Response / Session objects, streaming events,
//      and the error body — modelled on docs/agents-api.
//   2. The worker DTOs — the shapes the Hermes worker returns over JSONL, used
//      by the adapter layer.

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Response modes. `chat` runs one turn; `goal` is reserved for a fast-follow. */
export const RESPONSE_MODES = ['chat', 'goal'] as const;

export const SUPPORTED_AGENTS = ['hermes', 'openclaw'] as const;
export type AgentType = (typeof SUPPORTED_AGENTS)[number];
export const DEFAULT_AGENT: AgentType = 'hermes';

/** The DEFAULT harness a request routes to when it omits `agent`.
 *  GATEWAY_DEFAULT_AGENT names it (the OpenClaw image sets it to "openclaw"); a
 *  request can still target any supported harness via `agent`. Unset or unknown
 *  falls back to DEFAULT_AGENT, preserving Hermes-image behavior. This is the
 *  default only, not a one-backend-per-instance limit. */
export function resolveConfiguredDefaultAgent(raw: string | undefined | null): AgentType {
  const value = (raw ?? '').trim();
  return (SUPPORTED_AGENTS as readonly string[]).includes(value) ? (value as AgentType) : DEFAULT_AGENT;
}

/** Safety cap for goal mode. Keep in sync with GOAL_MAX_TURNS in hermes_worker.py. */
export const GOAL_MAX_TURNS = 20;

export interface AppVersion {
  name: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Public API: errors
// ---------------------------------------------------------------------------

/** The stable, machine-readable error body. Branch on `code`, show `message`. */
export interface ApiError {
  code: string;
  message: string;
  param?: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Public API: usage
// ---------------------------------------------------------------------------

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  /** Null when the provider/model did not report a cost for the turn. */
  cost_usd?: number | null;
}

// ---------------------------------------------------------------------------
// Public API: responses
// ---------------------------------------------------------------------------

export const RESPONSE_STATUSES = ['in_progress', 'completed', 'failed', 'cancelled'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/** One agentic turn: the input, the agent's work, and its reply. */
export interface ResponseObject {
  id: string;
  session_id: string;
  status: ResponseStatus;
  agent: AgentType;
  model: string | null;
  provider: string | null;
  output_text: string;
  usage: TurnUsage | null;
  error: ApiError | null;
  metadata: Record<string, unknown> | null;
  created: number;
}

// ---------------------------------------------------------------------------
// Public API: sessions
// ---------------------------------------------------------------------------

// Listing a harness's sessions (`GET /v1/sessions?agent=`) passes the backend's
// own session objects through untouched, so there is no gateway-owned session
// type — each harness (Hermes SessionDB, ...) defines its own fields.

/** A message in a session's history, projected from the session's harness backend (Hermes SessionDB, OpenClaw history, ...). */
export interface SessionMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Public API: files
// ---------------------------------------------------------------------------

/** One entry in the agent's filesystem. `path` (resolved, absolute) is the
 *  identity used by every other /v1/files call. Returned by the directory
 *  listing and echoed back by every write (PUT/PATCH/mkdir). */
export interface FileEntry {
  /** Basename. */
  name: string;
  /** Resolved absolute path — the identity for all other /v1/files calls. */
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  /** Bytes; null for directories. */
  size: number | null;
  /** mtimeMs — epoch milliseconds. */
  modified: number;
  /** Name starts with ".". */
  hidden: boolean;
}

/** The result of GET /v1/files: one directory level. */
export interface FileListResponse {
  /** The resolved absolute directory that was listed. */
  path: string;
  /** The parent directory, or null at the filesystem root. */
  parentPath: string | null;
  entries: FileEntry[];
  /** True when the directory held more than the cap and the list was clipped. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Public API: streaming events (Server-Sent Events)
// ---------------------------------------------------------------------------

export type ResponseStreamEvent =
  | { event: 'response.created'; data: { id: string; session_id: string } }
  | { event: 'response.reasoning.delta'; data: { text: string } }
  | { event: 'response.output_text.delta'; data: { text: string } }
  | { event: 'response.tool_call.started'; data: { tool: string; label?: string } }
  | { event: 'response.tool_call.completed'; data: { tool: string; duration_ms?: number } }
  | { event: 'response.tool_call.failed'; data: { tool: string; error?: string } }
  | { event: 'response.completed'; data: { output_text: string; usage: TurnUsage | null } }
  | { event: 'response.failed'; data: { error: ApiError } };

export type ResponseStreamEventName = ResponseStreamEvent['event'];

// ---------------------------------------------------------------------------
// Worker DTOs (returned by the Hermes worker over JSONL)
// ---------------------------------------------------------------------------

/** Per-turn run dials passed through to the Hermes worker. */
export interface AgentRunSettings {
  model?: string | null;
  provider?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface ContextUsage {
  used_tokens: number;
  window_tokens: number;
}

/** A raw message row projected by the worker's `session.messages.get`. */
export interface HermesMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at: number;
}

/** The worker's `session.get` projection. */
export interface SessionMetadata {
  id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: string | null;
  model: string | null;
}

export interface AgentDefaults {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiMode: string | null;
  reasoningEffort: ReasoningEffort | null;
  showReasoning: boolean;
}

export interface AgentModelOption {
  id: string;
  label: string;
  source: 'current' | 'catalog' | 'custom' | 'alias';
  provider?: string | null;
  isCurrentDefault?: boolean;
}

export interface AgentModelGroup {
  provider: string;
  models: AgentModelOption[];
}

export interface AgentModelsResponse {
  defaultModel: string | null;
  activeProvider: string | null;
  groups: AgentModelGroup[];
}

// ---------------------------------------------------------------------------
// Goal primitives (reserved for the goal-mode fast-follow)
// ---------------------------------------------------------------------------

export interface GoalStateSnapshot {
  goal: string;
  status: 'active' | 'paused' | 'done' | 'cleared';
  turnsUsed: number;
  maxTurns: number;
  lastReason?: string | null;
  pausedReason?: string | null;
}

export interface GoalDecision {
  status: GoalStateSnapshot['status'] | null;
  shouldContinue: boolean;
  continuationPrompt?: string | null;
  verdict: 'done' | 'continue' | 'skipped' | 'inactive';
  reason: string;
  message: string;
  state?: GoalStateSnapshot | null;
}

// ---------------------------------------------------------------------------
// Public API: GET /v1/models response
// ---------------------------------------------------------------------------

// OpenAI-compatible model object: the four standard fields (id/object/created/
// owned_by) plus additive extensions a UI can group and label on. `owned_by`
// carries the upstream provider (OpenAI's native slot, e.g. "nous").
export interface ModelInfo {
  id: string;
  object: 'model';
  /** Unix seconds. We don't track per-model creation time, so this is a stable
   *  placeholder that keeps the object schema-valid for standard clients. */
  created: number;
  owned_by: string;
  label: string;
  source: AgentModelOption['source'];
  is_default: boolean;
}

export interface ModelsListResponse {
  object: 'list';
  /** Which harness this list is for. Defaults to the gateway's configured
   *  default; selectable per request via `?agent=`. */
  agent: AgentType;
  default_model: string | null;
  default_provider: string | null;
  data: ModelInfo[];
}

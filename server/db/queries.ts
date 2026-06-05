import db from './index.js';
import type {
  AgentName,
  ApiError,
  ResponseObject,
  ResponseStatus,
  SessionObject,
  TurnUsage,
} from '../../shared/types.js';

// --- Row shapes -------------------------------------------------------------

interface SessionRow {
  id: string;
  agent: string;
  model: string | null;
  provider: string | null;
  created: number;
  last_response_at: number | null;
}

interface ResponseRow {
  id: string;
  session_id: string;
  status: string;
  agent: string;
  model: string | null;
  provider: string | null;
  output_text: string;
  usage: string | null;
  error: string | null;
  metadata: string | null;
  created: number;
}

function parseJson<T>(value: string | null): T | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Serialize a value for a nullable JSON column: null/undefined stays SQL NULL. */
function stringifyJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function rowToSession(row: SessionRow): SessionObject {
  return {
    id: row.id,
    agent: row.agent as AgentName,
    model: row.model,
    provider: row.provider,
    created: row.created,
    last_response_at: row.last_response_at,
  };
}

function rowToResponse(row: ResponseRow): ResponseObject {
  return {
    id: row.id,
    session_id: row.session_id,
    status: row.status as ResponseStatus,
    agent: row.agent as AgentName,
    model: row.model,
    provider: row.provider,
    output_text: row.output_text,
    usage: parseJson<TurnUsage>(row.usage),
    error: parseJson<ApiError>(row.error),
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    created: row.created,
  };
}

// --- Sessions ---------------------------------------------------------------

const stmtInsertSession = db.prepare(`
  INSERT INTO sessions (id, agent, model, provider, created, last_response_at)
  VALUES (@id, @agent, @model, @provider, @created, @last_response_at)
`);
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtListSessions = db.prepare('SELECT * FROM sessions ORDER BY created DESC');
const stmtSetSessionModel = db.prepare('UPDATE sessions SET model = @model, provider = @provider WHERE id = @id');
const stmtMarkSessionResponded = db.prepare('UPDATE sessions SET last_response_at = @at WHERE id = @id');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');

export function insertSession(input: {
  id: string;
  agent: AgentName;
  model?: string | null;
  provider?: string | null;
}): SessionObject {
  const row: SessionRow = {
    id: input.id,
    agent: input.agent,
    model: input.model ?? null,
    provider: input.provider ?? null,
    created: Date.now(),
    last_response_at: null,
  };
  stmtInsertSession.run(row);
  return rowToSession(row);
}

export function getSession(id: string): SessionObject | undefined {
  const row = stmtGetSession.get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function listSessions(): SessionObject[] {
  return (stmtListSessions.all() as SessionRow[]).map(rowToSession);
}

export function setSessionModel(id: string, model: string | null, provider: string | null): void {
  stmtSetSessionModel.run({ id, model, provider });
}

export function markSessionResponded(id: string, at = Date.now()): void {
  stmtMarkSessionResponded.run({ id, at });
}

export function deleteSession(id: string): boolean {
  return stmtDeleteSession.run(id).changes > 0;
}

// --- Responses --------------------------------------------------------------

const stmtInsertResponse = db.prepare(`
  INSERT INTO responses (id, session_id, status, agent, model, provider, output_text, usage, error, metadata, created)
  VALUES (@id, @session_id, @status, @agent, @model, @provider, '', NULL, NULL, @metadata, @created)
`);
const stmtGetResponse = db.prepare('SELECT * FROM responses WHERE id = ?');
const stmtDeleteResponsesForSession = db.prepare('DELETE FROM responses WHERE session_id = ?');
const stmtFinalizeResponse = db.prepare(`
  UPDATE responses
  SET status = @status, output_text = @output_text, usage = @usage, error = @error,
      model = @model, provider = @provider
  WHERE id = @id
`);
const stmtSetResponseStatus = db.prepare('UPDATE responses SET status = @status WHERE id = @id');

export function insertResponse(input: {
  id: string;
  session_id: string;
  agent: AgentName;
  model?: string | null;
  provider?: string | null;
  metadata?: Record<string, unknown> | null;
}): void {
  stmtInsertResponse.run({
    id: input.id,
    session_id: input.session_id,
    status: 'in_progress' satisfies ResponseStatus,
    agent: input.agent,
    model: input.model ?? null,
    provider: input.provider ?? null,
    metadata: stringifyJson(input.metadata),
    created: Date.now(),
  });
}

export function getResponse(id: string): ResponseObject | undefined {
  const row = stmtGetResponse.get(id) as ResponseRow | undefined;
  return row ? rowToResponse(row) : undefined;
}

export function finalizeResponse(
  id: string,
  fields: {
    status: ResponseStatus;
    output_text: string;
    usage: TurnUsage | null;
    error: ApiError | null;
    model: string | null;
    provider: string | null;
  },
): void {
  stmtFinalizeResponse.run({
    id,
    status: fields.status,
    output_text: fields.output_text,
    usage: stringifyJson(fields.usage),
    error: stringifyJson(fields.error),
    model: fields.model,
    provider: fields.provider,
  });
}

export function setResponseStatus(id: string, status: ResponseStatus): void {
  stmtSetResponseStatus.run({ id, status });
}

export function deleteResponsesForSession(sessionId: string): number {
  return stmtDeleteResponsesForSession.run(sessionId).changes;
}

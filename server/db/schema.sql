-- Gateway metadata only. Transcript history lives in Hermes' SessionDB and is
-- projected on demand; we never duplicate messages here.

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL DEFAULT 'hermes',
  model             TEXT,
  provider          TEXT,
  created           INTEGER NOT NULL,
  last_response_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created DESC);

CREATE TABLE IF NOT EXISTS responses (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'in_progress',
  agent        TEXT NOT NULL DEFAULT 'hermes',
  model        TEXT,
  provider     TEXT,
  output_text  TEXT NOT NULL DEFAULT '',
  usage        TEXT,   -- JSON: TurnUsage
  error        TEXT,   -- JSON: ApiError
  metadata     TEXT,   -- JSON: arbitrary key/value echoed back
  created      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, created DESC);

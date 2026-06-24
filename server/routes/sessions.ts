import { Router } from 'express';
import type { SessionMessage } from '../../shared/types.js';
import { SUPPORTED_AGENTS } from '../../shared/types.js';
import { getAdapter } from '../agent.js';
import { gatewayErrorFromWorker, optionalEnum, sessionNotFound } from '../errors.js';
import {
  deleteResponsesForSession,
  deleteSession,
  getSession,
  listSessions,
} from '../db/queries.js';

export const sessionsRouter = Router();

// GET /v1/sessions — list the sessions on this instance, optionally filtered
// by agent (e.g. `?agent=openclaw` for OpenClaw chat history).
sessionsRouter.get('/', (req, res, next) => {
  try {
    // `?agent=` (empty) is treated as absent → all sessions; an unknown agent is a 400.
    const raw = req.query.agent === '' ? undefined : req.query.agent;
    const agent = optionalEnum(raw, 'agent', SUPPORTED_AGENTS, null);
    res.json({ data: listSessions(agent) });
  } catch (error) {
    next(error);
  }
});

// GET /v1/sessions/:id — the session with its full transcript history.
sessionsRouter.get('/:id', async (req, res, next) => {
  const session = getSession(req.params.id);
  if (!session) return next(sessionNotFound(req.params.id));

  // No turns yet → no Hermes session exists, so history is empty.
  if (session.last_response_at === null) {
    return res.json({ ...session, history: [] });
  }

  try {
    const messages = await getAdapter(session.agent).getMessages(session.id);
    const history: SessionMessage[] = messages.map((m) => ({
      id: m.id,
      session_id: session.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      created_at: m.created_at,
    }));
    res.json({ ...session, history });
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Session history unavailable'));
  }
});

// DELETE /v1/sessions/:id — remove the conversation and its history.
sessionsRouter.delete('/:id', async (req, res, next) => {
  const session = getSession(req.params.id);
  if (!session) return next(sessionNotFound(req.params.id));

  // Best-effort removal of the Hermes transcript before dropping our records.
  try {
    await getAdapter(session.agent).deleteSession(session.id);
  } catch {
    // The gateway's own records still get cleaned up below.
  }
  deleteResponsesForSession(session.id);
  deleteSession(session.id);

  res.json({ id: session.id, deleted: true });
});

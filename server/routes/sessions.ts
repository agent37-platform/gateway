import { Router } from 'express';
import type { SessionMessage } from '../../shared/types.js';
import { adapter } from '../agent.js';
import { gatewayErrorFromWorker, sessionNotFound } from '../errors.js';
import {
  deleteResponsesForSession,
  deleteSession,
  getSession,
  listSessions,
} from '../db/queries.js';

export const sessionsRouter = Router();

// GET /v1/sessions — list the sessions on this instance.
sessionsRouter.get('/', (_req, res) => {
  res.json({ data: listSessions() });
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
    const messages = await adapter.getMessages(session.id);
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
    await adapter.deleteSession(session.id);
  } catch {
    // The gateway's own records still get cleaned up below.
  }
  deleteResponsesForSession(session.id);
  deleteSession(session.id);

  res.json({ id: session.id, deleted: true });
});

import { Router } from 'express';
import type { AgentType, SessionMessage } from '../../shared/types.js';
import { getAdapter, agentFromQuery } from '../agent.js';
import { gatewayErrorFromWorker, renameUnsupported, validationError } from '../errors.js';

export const sessionsRouter = Router();

// GET /v1/sessions?agent= — list a harness's sessions straight from its own
// store, native fields untouched. The harness owns the transcript and the index;
// the gateway keeps none. Harnesses without a list API (OpenClaw) return [].
sessionsRouter.get('/', async (req, res, next) => {
  let agent: AgentType | undefined;
  try {
    agent = agentFromQuery(req.query.agent);
    const data = await getAdapter(agent).listSessions();
    res.json({ agent, data });
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Could not list sessions', agent));
  }
});

// GET /v1/sessions/:id?agent= — the session's transcript, projected from the
// harness. An unknown id projects to empty history rather than 404 — the harness
// owns existence.
sessionsRouter.get('/:id', async (req, res, next) => {
  let agent: AgentType | undefined;
  try {
    agent = agentFromQuery(req.query.agent);
    const messages = await getAdapter(agent).getMessages(req.params.id);
    const history: SessionMessage[] = messages.map((m) => ({
      id: m.id,
      session_id: req.params.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      created_at: m.created_at,
    }));
    res.json({ id: req.params.id, agent, history });
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Session history unavailable', agent));
  }
});

// DELETE /v1/sessions/:id?agent= — best-effort removal from the harness.
sessionsRouter.delete('/:id', async (req, res, next) => {
  let agent: AgentType | undefined;
  try {
    agent = agentFromQuery(req.query.agent);
    const deleted = await getAdapter(agent).deleteSession(req.params.id);
    res.json({ id: req.params.id, deleted });
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Could not delete session', agent));
  }
});

// PATCH /v1/sessions/:id?agent= — rename a session by writing its title into the
// harness's own store (no gateway DB). Only harnesses that natively store an
// editable title implement it; the rest (OpenClaw) answer 405.
sessionsRouter.patch('/:id', async (req, res, next) => {
  let agent: AgentType | undefined;
  try {
    agent = agentFromQuery(req.query.agent);
    const adapter = getAdapter(agent);
    if (!adapter.renameSession) throw renameUnsupported(agent);

    const title = (req.body as { title?: unknown } | undefined)?.title;
    if (typeof title !== 'string' || title.trim() === '') {
      throw validationError('title is required.', 'title');
    }

    const renamed = await adapter.renameSession(req.params.id, title);
    res.json({ id: req.params.id, agent, renamed });
  } catch (error) {
    next(gatewayErrorFromWorker(error, 'Could not rename session', agent));
  }
});

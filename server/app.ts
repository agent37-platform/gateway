import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { getAdapter, agentFromQuery } from './agent.js';
import { responsesRouter } from './routes/responses.js';
import { sessionsRouter } from './routes/sessions.js';
import { modelsRouter } from './routes/models.js';
import { filesRouter } from './routes/files.js';
import { getAppVersion } from './version.js';
import { GatewayError } from './errors.js';

const app = express();

app.use(cors());
// A turn request is small (input text + a few fields). Keep the limit modest so
// an oversized body can't be a memory vector; oversize → 413 payload_too_large.
// PUT /v1/files/content is the one exception: it carries raw file bytes of any
// size, so it opts out of JSON parsing and the limit — the files route streams
// that body straight to disk.
app.use(
  express.json({
    limit: '2mb',
    type: (req) => (req as Request).path !== '/v1/files/content' && Boolean((req as Request).is('application/json')),
  }),
);

app.get('/v1/health', async (req, res, next) => {
  try {
    // `?agent=` selects the harness; omitted or empty falls back to the configured
    // default. `hermes` is kept for backward compatibility when Hermes is probed.
    const agent = agentFromQuery(req.query.agent);
    const healthy = await getAdapter(agent).healthCheck();
    res.json({
      ok: true,
      agent,
      healthy,
      ...(agent === 'hermes' ? { hermes: healthy } : {}),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/v1/version', (_req, res) => {
  res.json(getAppVersion());
});

app.use('/v1/responses', responsesRouter);
app.use('/v1/sessions', sessionsRouter);
app.use('/v1/models', modelsRouter);
app.use('/v1/files', filesRouter);

// Unknown route → documented JSON error body.
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}.` },
  });
});

// Central error handler. Renders the stable `{ error: { code, message, ... } }`
// body. Once an SSE stream's headers are sent we can't emit JSON, so defer.
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);

  if (error instanceof GatewayError) {
    res.status(error.status).json(error.toBody());
    return;
  }

  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large.' } });
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'validation_error', message: 'Request body is not valid JSON.' } });
    return;
  }

  console.error('Unhandled error:', error);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong.' } });
});

export default app;

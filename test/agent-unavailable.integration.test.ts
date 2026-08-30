import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './test-helpers.js';

// Point the OpenClaw adapter at a dead port and the Claude Code adapter at a
// missing binary so their backends are unreachable — the same shape as
// targeting a harness that isn't provisioned on this instance. node:test
// isolates each file in its own process, so these env overrides don't leak
// into the other suites.
let server: TestServer | undefined;
let base: string;

before(async () => {
  process.env.OPENCLAW_BASE_URL = 'http://127.0.0.1:59321';
  process.env.CLAUDE_CODE_BIN = '/nonexistent/claude';
  process.env.CODEX_BIN = '/nonexistent/codex';
  process.env.OPENCODE_BIN = '/nonexistent/opencode';
  process.env.GROK_BIN = '/nonexistent/grok';
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
});

test('a request for an unreachable harness fails with agent_unavailable, not a raw 502', async () => {
  const res = await fetch(`${base}/v1/models?agent=openclaw`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string; message: string; hint?: string } };
  assert.equal(body.error.code, 'agent_unavailable');
  assert.match(body.error.message, /openclaw/);
  assert.match(body.error.message, /not available on this instance/);
});

test('a turn for an unreachable harness settles as failed with agent_unavailable', async () => {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'openclaw', input: 'hello' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; error: { code: string } | null };
  assert.equal(body.status, 'failed');
  assert.equal(body.error?.code, 'agent_unavailable');
});

test('a claude-code request without the claude binary fails with agent_unavailable', async () => {
  const models = await fetch(`${base}/v1/models?agent=claude-code`);
  assert.equal(models.status, 503);
  const modelsBody = (await models.json()) as { error: { code: string; message: string } };
  assert.equal(modelsBody.error.code, 'agent_unavailable');
  assert.match(modelsBody.error.message, /claude-code/);

  const turn = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'claude-code', input: 'hello' }),
  });
  assert.equal(turn.status, 200);
  const body = (await turn.json()) as { status: string; error: { code: string } | null };
  assert.equal(body.status, 'failed');
  assert.equal(body.error?.code, 'agent_unavailable');

  const health = (await (await fetch(`${base}/v1/health?agent=claude-code`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

test('a codex request without the codex binary fails with agent_unavailable', async () => {
  const models = await fetch(`${base}/v1/models?agent=codex`);
  assert.equal(models.status, 503);
  const modelsBody = (await models.json()) as { error: { code: string; message: string } };
  assert.equal(modelsBody.error.code, 'agent_unavailable');
  assert.match(modelsBody.error.message, /codex/);

  // Codex resolves its session before the response begins, so a missing binary
  // is caught while headers are still open: the turn is a real 503, not a
  // 200 failed body (unlike Hermes/OpenClaw/Claude Code, which have no
  // resolveSession and settle mid-stream).
  const turn = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'codex', input: 'hello' }),
  });
  assert.equal(turn.status, 503);
  const turnBody = (await turn.json()) as { error: { code: string } };
  assert.equal(turnBody.error.code, 'agent_unavailable');

  const health = (await (await fetch(`${base}/v1/health?agent=codex`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

test('an opencode request without the opencode binary fails with agent_unavailable', async () => {
  const models = await fetch(`${base}/v1/models?agent=opencode`);
  assert.equal(models.status, 503);
  const modelsBody = (await models.json()) as { error: { code: string; message: string } };
  assert.equal(modelsBody.error.code, 'agent_unavailable');
  assert.match(modelsBody.error.message, /opencode/);

  // OpenCode resolves its session before the response begins, so a missing
  // binary is caught while headers are still open: the turn is a real 503, not
  // a 200 failed body (like Codex, unlike the harnesses without resolveSession).
  const turn = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'opencode', input: 'hello' }),
  });
  assert.equal(turn.status, 503);
  const turnBody = (await turn.json()) as { error: { code: string } };
  assert.equal(turnBody.error.code, 'agent_unavailable');

  const health = (await (await fetch(`${base}/v1/health?agent=opencode`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

test('a grok request without the grok binary fails with agent_unavailable', async () => {
  const models = await fetch(`${base}/v1/models?agent=grok`);
  assert.equal(models.status, 503);
  const modelsBody = (await models.json()) as { error: { code: string; message: string } };
  assert.equal(modelsBody.error.code, 'agent_unavailable');
  assert.match(modelsBody.error.message, /grok/);

  // Grok resolves its session before the response begins, so a missing binary
  // is caught while headers are still open: the turn is a real 503, not a
  // 200 failed body (like Codex and OpenCode).
  const turn = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'grok', input: 'hello' }),
  });
  assert.equal(turn.status, 503);
  const turnBody = (await turn.json()) as { error: { code: string } };
  assert.equal(turnBody.error.code, 'agent_unavailable');

  const health = (await (await fetch(`${base}/v1/health?agent=grok`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

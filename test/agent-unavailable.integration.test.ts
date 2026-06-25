import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './test-helpers.js';

// Point the OpenClaw adapter at a dead port so its backend is unreachable —
// the same shape as targeting a harness that isn't provisioned on this
// instance. node:test isolates each file in its own process, so this env
// override doesn't leak into the other suites.
let server: TestServer | undefined;
let base: string;

before(async () => {
  process.env.OPENCLAW_BASE_URL = 'http://127.0.0.1:59321';
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

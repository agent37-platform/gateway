import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer } from './test-helpers.js';

// Run the real worker on a machine with no Hermes install in sight — the
// shape of `agent: "hermes"` on an OpenClaw image. The worker itself starts
// (it is plain Python) and reports hermes_not_found; the gateway must present
// that as agent_unavailable, the same body a refused connection produces.
// node:test isolates each file in its own process, so the env overrides don't
// leak into the other suites.
let server: TestServer | undefined;
let base: string;

before(async () => {
  // Resolve the venv python before hiding the real home directory.
  if (!process.env.HERMES_PYTHON && !process.env.HERMES_AGENT_DIR) {
    process.env.HERMES_PYTHON = join(homedir(), '.hermes/hermes-agent/venv/bin/python');
  }
  const emptyHome = mkdtempSync(join(tmpdir(), 'a37gw-no-hermes-'));
  process.env.HOME = emptyHome;
  process.env.HERMES_HOME = join(emptyHome, '.hermes');
  process.env.HERMES_AGENT_DIR = join(emptyHome, 'missing-hermes-agent');
  process.env.PATH = '/usr/bin:/bin'; // no `hermes` CLI to discover the install from
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
});

test('a request for a harness with no install here fails with agent_unavailable', async () => {
  const res = await fetch(`${base}/v1/models?agent=hermes`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'agent_unavailable');
  assert.match(body.error.message, /hermes/);
  assert.match(body.error.message, /not available on this instance/);
});

test('a turn for a harness with no install here settles as failed with agent_unavailable', async () => {
  const res = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'hermes', input: 'hello' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; error: { code: string } | null };
  assert.equal(body.status, 'failed');
  assert.equal(body.error?.code, 'agent_unavailable');
});

test('health reports the missing harness as unhealthy, not as an error', async () => {
  const res = await fetch(`${base}/v1/health?agent=hermes`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; agent: string; healthy: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.healthy, false);
});

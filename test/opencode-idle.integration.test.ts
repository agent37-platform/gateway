import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { startTestServer, postJson, type TestServer } from './test-helpers.js';

// OpenCode keeps `opencode serve` resident and kills it after OPENCODE_IDLE_MS
// idle so a casual user costs zero RAM. Force a 1s idle window, run a turn, wait
// out the kill, then run another: the second must respawn the server
// transparently and complete. node:test isolates each file in its own process,
// so the tiny idle override doesn't leak into the other suites.

const opencodeMissing = await new Promise<false | string>((resolve) => {
  execFile(process.env.OPENCODE_BIN?.trim() || 'opencode', ['--version'], { timeout: 15_000 }, (error) => {
    resolve(error ? 'no OpenCode CLI installed' : false);
  });
});

let server: TestServer | undefined;
let base: string;
let previousIdle: string | undefined;

before(async () => {
  previousIdle = process.env.OPENCODE_IDLE_MS;
  process.env.OPENCODE_IDLE_MS = '1000';
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  if (previousIdle === undefined) delete process.env.OPENCODE_IDLE_MS;
  else process.env.OPENCODE_IDLE_MS = previousIdle;
});

async function pickModel(): Promise<string> {
  const models = (await (await fetch(`${base}/v1/models?agent=opencode`)).json()) as {
    default_model: string | null;
    data: Array<{ id: string }>;
  };
  return (
    models.data.find((m) => /big-pickle$/i.test(m.id))?.id ??
    models.data.find((m) => /free/i.test(m.id))?.id ??
    models.data.find((m) => m.id.startsWith('opencode/'))?.id ??
    models.default_model ??
    models.data[0].id
  );
}

test('a turn after the idle kill respawns the OpenCode server transparently', { skip: opencodeMissing }, async () => {
  const model = await pickModel();

  const first = (await (
    await postJson(base, { agent: 'opencode', model, input: 'Reply with just OK.', reasoning_effort: 'low' })
  ).json()) as { status: string; session_id: string; error: unknown };
  assert.equal(first.status, 'completed', JSON.stringify(first.error));

  // Wait past OPENCODE_IDLE_MS so the resident server is idle-killed.
  await new Promise((resolve) => setTimeout(resolve, 1800));

  const second = (await (
    await postJson(base, { agent: 'opencode', model, session_id: first.session_id, input: 'Reply with just DONE.', reasoning_effort: 'low' })
  ).json()) as { status: string; session_id: string; error: unknown };
  assert.equal(second.status, 'completed', JSON.stringify(second.error));
  assert.equal(second.session_id, first.session_id);

  await fetch(`${base}/v1/sessions/${first.session_id}?agent=opencode`, { method: 'DELETE' });
});

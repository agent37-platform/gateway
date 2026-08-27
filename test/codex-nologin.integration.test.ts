import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, postJson, type TestServer } from './test-helpers.js';

// Point Codex at an empty CODEX_HOME so it has no account. A turn must settle
// as a failed response with the documented auth_error and the login hint, and
// health must be false. Unlike Claude Code, a bare OPENAI_API_KEY does NOT
// authenticate Codex's app-server (it needs `codex login` / auth.json), so an
// empty home is logged-out regardless of the environment. node:test isolates
// each file in its own process, so this CODEX_HOME override doesn't leak.

const codexMissing = await new Promise<false | string>((resolve) => {
  execFile(process.env.CODEX_BIN?.trim() || 'codex', ['--version'], { timeout: 15_000 }, (error) => {
    resolve(error ? 'no Codex CLI installed' : false);
  });
});

let server: TestServer | undefined;
let base: string;
let configDir: string;
let previousHome: string | undefined;

before(async () => {
  previousHome = process.env.CODEX_HOME;
  configDir = mkdtempSync(join(tmpdir(), 'a37gw-codex-nologin-'));
  process.env.CODEX_HOME = configDir;
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  // Codex keeps writing into CODEX_HOME (a plugins clone) briefly after the
  // child is killed, so a plain rmdir can race to ENOTEMPTY. Retry, and never
  // fail the suite on temp-dir cleanup.
  try {
    rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best effort — the OS reaps the temp dir
  }
});

test('a codex turn without an account fails with auth_error', { skip: codexMissing }, async () => {
  const failed = (await (await postJson(base, { agent: 'codex', input: 'hello', reasoning_effort: 'low' })).json()) as {
    status: string;
    error: { code: string; hint?: string } | null;
  };
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'auth_error');
  assert.match(failed.error?.hint ?? '', /codex login/);

  const health = (await (await fetch(`${base}/v1/health?agent=codex`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

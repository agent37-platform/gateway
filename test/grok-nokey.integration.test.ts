import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { startTestServer, postJson, type TestServer } from './test-helpers.js';

// Point Grok at an empty GROK_HOME (no auth.json) with no XAI_API_KEY in the
// environment. A turn must settle as a failed response with the documented
// auth_error and the key hint, and health must be false. node:test isolates
// each file in its own process, so these env overrides don't leak.

try {
  const env = parse(readFileSync(new URL('../.env', import.meta.url)));
  if (env.GROK_BIN && !process.env.GROK_BIN) process.env.GROK_BIN = env.GROK_BIN;
} catch {
  // no .env — rely on the ambient environment
}

const grokMissing = await new Promise<false | string>((resolve) => {
  execFile(process.env.GROK_BIN?.trim() || 'grok', ['--version'], { timeout: 15_000 }, (error) => {
    resolve(error ? 'no Grok CLI installed' : false);
  });
});

let server: TestServer | undefined;
let base: string;
let grokHome: string;

before(async () => {
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_CODE_XAI_API_KEY;
  grokHome = mkdtempSync(join(tmpdir(), 'a37gw-grok-nokey-'));
  process.env.GROK_HOME = grokHome;
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  try {
    rmSync(grokHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best effort — the OS reaps the temp dir
  }
});

test('a grok turn without a key fails with auth_error', { skip: grokMissing }, async () => {
  const failed = (await (await postJson(base, { agent: 'grok', input: 'hello', reasoning_effort: 'low' })).json()) as {
    status: string;
    error: { code: string; hint?: string } | null;
  };
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'auth_error');
  assert.match(failed.error?.hint ?? '', /XAI_API_KEY/);

  const health = (await (await fetch(`${base}/v1/health?agent=grok`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

test('an unkeyed grok models read is an empty list, not an error', { skip: grokMissing }, async () => {
  const res = await fetch(`${base}/v1/models?agent=grok`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[]; default_model?: string | null };
  assert.deepEqual(body.data, []);
});

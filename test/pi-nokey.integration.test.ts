import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { startTestServer, postJson, type TestServer } from './test-helpers.js';

// Point Pi at an empty agent directory (no auth.json, no models.json) with every
// provider credential stripped from the environment. A turn must settle as a
// failed response with the documented auth_error and the login hint, and health
// must be false. node:test isolates each file in its own process, so these env
// overrides don't leak.

try {
  const env = parse(readFileSync(new URL('../.env', import.meta.url)));
  if (env.PI_BIN && !process.env.PI_BIN) process.env.PI_BIN = env.PI_BIN;
} catch {
  // no .env — rely on the ambient environment
}

const piMissing = await new Promise<false | string>((resolve) => {
  execFile(process.env.PI_BIN?.trim() || 'pi', ['--version'], { timeout: 15_000 }, (error) => {
    resolve(error ? 'no Pi CLI installed' : false);
  });
});

let server: TestServer | undefined;
let piDir: string;
let base: string;

before(async () => {
  // Pi resolves credentials for 20+ providers from the environment, so the test
  // strips anything shaped like one rather than naming each variable.
  for (const key of Object.keys(process.env)) {
    if (/_API_KEY$|_TOKEN$|^AWS_|^AZURE_|^GOOGLE_|^GCLOUD_|^CLOUDFLARE_|^HF_|^NVIDIA/.test(key)) delete process.env[key];
  }
  piDir = mkdtempSync(join(tmpdir(), 'a37gw-pi-nokey-'));
  process.env.PI_CODING_AGENT_DIR = piDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(piDir, 'sessions');
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  try {
    rmSync(piDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best effort — the OS reaps the temp dir
  }
});

test('a pi turn without a credential fails with auth_error', { skip: piMissing }, async () => {
  const failed = (await (await postJson(base, { agent: 'pi', input: 'hello', reasoning_effort: 'low' })).json()) as {
    status: string;
    error: { code: string; hint?: string } | null;
  };
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'auth_error');
  assert.match(failed.error?.hint ?? '', /\/login/);

  const health = (await (await fetch(`${base}/v1/health?agent=pi`)).json()) as { healthy: boolean };
  assert.equal(health.healthy, false);
});

test('an unkeyed pi models read is an empty list, not an error', { skip: piMissing }, async () => {
  const res = await fetch(`${base}/v1/models?agent=pi`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[] };
  assert.deepEqual(body.data, []);
});

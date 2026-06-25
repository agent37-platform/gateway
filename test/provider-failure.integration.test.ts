import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// Refuses every LLM call the way the Agent37 starter proxy does when the
// managed budget is exhausted: HTTP 402 with an OpenAI-style error body.
function startBudgetExhaustedProvider(): Promise<{ server: Server; port: number }> {
  const provider = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'instance_budget_exhausted',
          message: 'Instance budget exhausted. Raise the monthly cap or top up this instance to continue.',
        },
      }),
    );
  });
  return new Promise((resolve) => {
    provider.listen(0, '127.0.0.1', () => {
      resolve({ server: provider, port: (provider.address() as AddressInfo).port });
    });
  });
}

let provider: Server;
let server: TestServer | undefined;
let base: string;

before(async () => {
  const started = await startBudgetExhaustedProvider();
  provider = started.server;

  // A throwaway HERMES_HOME whose only provider is the refusing mock, so the
  // real worker and the real Hermes agent run the turn against it.
  const hermesHome = mkdtempSync(join(tmpdir(), 'a37gw-hermes-402-'));
  writeFileSync(
    join(hermesHome, 'config.yaml'),
    [
      'model:',
      '  default: mock-model',
      '  provider: custom:budget-mock',
      'custom_providers:',
      '  - name: budget-mock',
      `    base_url: http://127.0.0.1:${started.port}/v1`,
      '    api_key: test-key',
      '    model: mock-model',
      '',
    ].join('\n'),
  );
  process.env.HERMES_HOME = hermesHome;
  // Pointing HERMES_HOME away from the real install hides the venv from the
  // adapter's auto-detection; pin it unless the developer already overrides.
  if (!process.env.HERMES_PYTHON && !process.env.HERMES_AGENT_DIR) {
    process.env.HERMES_PYTHON = join(homedir(), '.hermes/hermes-agent/venv/bin/python');
  }

  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

test('a turn whose provider calls are all refused settles as failed with a structured error', async () => {
  const res = await postJson(base, { input: 'Reply with the single word: ok' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    id: string;
    status: string;
    output_text: string;
    error: { code: string; message: string; hint?: string } | null;
  };
  assert.equal(body.status, 'failed', JSON.stringify(body));
  assert.ok(body.error);
  assert.equal(body.error.code, 'quota_exhausted');
  assert.match(body.error.message, /instance_budget_exhausted|budget exhausted/i);
  assert.match(body.error.hint ?? '', /instance budget|workspace balance/i);
  assert.equal(body.output_text, '');
});

test('a streaming turn whose provider calls are all refused ends with response.failed', async () => {
  const res = await postJson(base, { input: 'Reply with the single word: ok', stream: true });
  assert.equal(res.status, 200);

  const events = await new SseReader(res).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.ok(!events.some((event) => event.event === 'response.completed'), JSON.stringify(events));

  const failed = events.at(-1);
  assert.equal(failed?.event, 'response.failed');
  const error = (failed?.data as { error: { code: string; message: string; hint?: string } }).error;
  assert.equal(error.code, 'quota_exhausted');
  assert.match(error.hint ?? '', /instance budget|workspace balance/i);
});

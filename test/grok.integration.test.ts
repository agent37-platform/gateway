import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// --- Grok adapter. Like Codex, Grok ships in a release image, so a missing or
// unkeyed CLI FAILS the suite via the gate test below rather than silently
// skipping. Turns run on the tester's own XAI_API_KEY and cost real usage.

// Pull only the Grok settings from .env; loading the whole file would reshape
// the Hermes worker's environment too.
try {
  const env = parse(readFileSync(new URL('../.env', import.meta.url)));
  for (const key of ['GROK_BIN', 'XAI_API_KEY'] as const) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
} catch {
  // no .env — rely on the ambient environment
}

const grokSkip = await new Promise<false | string>((resolve) => {
  execFile(process.env.GROK_BIN?.trim() || 'grok', ['--version'], { timeout: 15_000 }, (error) => {
    if (error) resolve('Grok is not installed');
    else if (!process.env.XAI_API_KEY?.trim()) resolve('XAI_API_KEY is not set');
    else resolve(false);
  });
});

let server: TestServer | undefined;
let base: string;
let grokHome: string;
let previousHome: string | undefined;

before(async () => {
  // An isolated GROK_HOME keeps the run off the developer's own session store,
  // and its config turns off grok's Claude-compat scanners so a local
  // ~/.claude.json can't wire personal MCP servers into every test turn.
  previousHome = process.env.GROK_HOME;
  grokHome = mkdtempSync(join(tmpdir(), 'a37gw-grok-'));
  writeFileSync(join(grokHome, 'config.toml'), '[compat.claude]\nmcps = false\n');
  process.env.GROK_HOME = grokHome;
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  if (previousHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousHome;
  try {
    rmSync(grokHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // best effort — the OS reaps the temp dir
  }
});

interface ResponseBody {
  id: string;
  session_id: string;
  status: string;
  agent: string;
  output_text: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number | null } | null;
  context: { used_tokens: number; window_tokens: number } | null;
  error: { code: string; message: string; hint?: string } | null;
}

async function jsonOk<T>(res: Response): Promise<T> {
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as T;
}

test('Grok CLI is installed and keyed (required — its tests must run)', () => {
  assert.equal(grokSkip, false, `Grok tests did not run: ${grokSkip}. Install Grok Build and set XAI_API_KEY — a green suite must include this harness.`);
});

test('grok responses complete, resume, and manage sessions on Grok\'s own store', { skip: grokSkip }, async () => {
  const marker = `grok-marker-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'grok',
      input: `Remember this marker: ${marker}. Reply with just OK.`,
      reasoning_effort: 'low',
    }),
  );
  assert.equal(created.status, 'completed', JSON.stringify(created.error));
  assert.equal(created.agent, 'grok');
  // A Grok session id is a UUID minted by the gateway and owned by grok's
  // store; the client can't bring its own (see the made-up-id case below).
  assert.match(created.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(created.output_text.trim().length > 0);
  assert.ok(created.usage && created.usage.output_tokens > 0);
  assert.equal(typeof created.usage.cost_usd, 'number'); // Grok reports USD cost.
  assert.equal(created.context, null); // Grok reports no context window.

  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health?agent=grok`)), {
    ok: true,
    agent: 'grok',
    healthy: true,
  });

  // A known session id resumes on grok's own store, so the marker is recalled.
  const recalled = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'grok',
      session_id: created.session_id,
      input: 'Reply with just the marker I asked you to remember.',
      reasoning_effort: 'low',
    }),
  );
  assert.equal(recalled.status, 'completed', JSON.stringify(recalled.error));
  assert.equal(recalled.session_id, created.session_id);
  assert.ok(recalled.output_text.includes(marker), recalled.output_text);

  // History projects grok's own transcript; reads name `?agent=grok`.
  const session = await jsonOk<{ history: { role: string; content: string; created_at: number }[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=grok`),
  );
  assert.ok(session.history.some((m) => m.role === 'user' && m.content.includes(marker)));
  assert.ok(session.history.some((m) => m.role === 'assistant'));

  // The list is grok's own session store for this workspace.
  const list = await jsonOk<{ agent: string; data: Array<{ id: string; title: string | null; last_active: number | null }> }>(
    await fetch(`${base}/v1/sessions?agent=grok`),
  );
  assert.equal(list.agent, 'grok');
  const row = list.data.find((s) => s.id === created.session_id);
  assert.ok(row, 'created session appears in the list');
  assert.equal(typeof row.last_active, 'number');

  // Grok stores no editable title, so rename is a documented 405.
  const rename = await fetch(`${base}/v1/sessions/${created.session_id}?agent=grok`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'nope' }),
  });
  assert.equal(rename.status, 405);

  // Models are grok's live per-key catalog.
  const models = await jsonOk<{ agent: string; data: Array<{ id: string; owned_by: string; source: string }> }>(
    await fetch(`${base}/v1/models?agent=grok`),
  );
  assert.equal(models.agent, 'grok');
  assert.ok(models.data.length > 0);
  assert.ok(models.data.every((m) => m.owned_by === 'xai' && m.source === 'catalog'));

  const stream = await postJson(base, {
    agent: 'grok',
    input: 'Reply with exactly this word: PONG',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(stream.status, 200);
  const events = await new SseReader(stream).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.ok(events.some((event) => event.event === 'response.output_text.delta'));
  assert.equal(events.at(-1)?.event, 'response.completed');
  await fetch(`${base}/v1/sessions/${events[0]?.data.session_id as string}?agent=grok`, { method: 'DELETE' });

  // Delete removes the session; it leaves the list and its history projects empty.
  const deleted = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=grok`, { method: 'DELETE' }),
  );
  assert.equal(deleted.deleted, true);
  const gone = await jsonOk<{ history: unknown[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=grok`),
  );
  assert.deepEqual(gone.history, []);

  // Deleting an unknown session is not an error.
  const unknown = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/00000000-0000-0000-0000-000000000000?agent=grok`, { method: 'DELETE' }),
  );
  assert.equal(unknown.deleted, false);

  // A client cannot invent a session_id on grok: an unknown id is a 400.
  const madeUp = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'grok', session_id: 'not-a-real-session', input: 'hello' }),
  });
  assert.equal(madeUp.status, 400);
  const madeUpBody = (await madeUp.json()) as { error: { code: string; param?: string } };
  assert.equal(madeUpBody.error.code, 'validation_error');
  assert.equal(madeUpBody.error.param, 'session_id');
});

test('an in-flight grok turn can be cancelled', { skip: grokSkip }, async () => {
  const slow = await postJson(base, {
    agent: 'grok',
    input: 'Run the shell command `sleep 30` and then reply with the word done.',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(slow.status, 200);

  const reader = new SseReader(slow);
  const opening = await reader.until((event) => event.event !== 'response.created');
  const created = opening.find((event) => event.event === 'response.created');
  assert.ok(created);
  const responseId = created.data.id as string;
  const sessionId = created.data.session_id as string;

  const cancel = await fetch(`${base}/v1/responses/${responseId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  await reader.drain();

  const settled = await jsonOk<{ active_response_id: string | null }>(
    await fetch(`${base}/v1/sessions/${sessionId}?agent=grok`),
  );
  assert.equal(settled.active_response_id, null);
  const replay = await new SseReader(await fetch(`${base}/v1/responses/${responseId}/stream`)).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');
  // A cancelled turn reports no usage or context.
  assert.equal(replay.at(-1)?.data.usage, null);

  await fetch(`${base}/v1/sessions/${sessionId}?agent=grok`, { method: 'DELETE' });
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// --- Pi adapter. Like Codex and Grok, Pi ships in a release image, so a missing
// or unkeyed CLI FAILS the suite via the gate test below rather than silently
// skipping. Turns run on the tester's own PI_MODEL credentials and cost real
// usage.

// Pull only the Pi settings from .env; loading the whole file would reshape the
// Hermes worker's environment too.
try {
  const env = parse(readFileSync(new URL('../.env', import.meta.url)));
  for (const key of ['PI_BIN', 'PI_MODEL'] as const) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
} catch {
  // no .env — rely on the ambient environment
}

// The model every turn below runs on. Pi picks a model from whatever provider is
// authenticated, so the suite names one explicitly and the tester supplies its
// key (PI_MODEL="anthropic/claude-sonnet-5" with ANTHROPIC_API_KEY, say).
const model = process.env.PI_MODEL?.trim() || '';

const piSkip = await new Promise<false | string>((resolve) => {
  execFile(process.env.PI_BIN?.trim() || 'pi', ['--version'], { timeout: 15_000 }, (error) => {
    if (error) resolve('Pi is not installed');
    else if (!model) resolve('PI_MODEL is not set');
    else resolve(false);
  });
});

let server: TestServer | undefined;
let base: string;
let piDir: string;
let sessionDir: string;

before(async () => {
  // An isolated agent + session directory keeps the run off the developer's own
  // pi store; every turn below names its model, so the credentials in the
  // environment are the only model config these tests depend on.
  piDir = mkdtempSync(join(tmpdir(), 'a37gw-pi-'));
  sessionDir = join(piDir, 'sessions');
  process.env.PI_CODING_AGENT_DIR = piDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    rmSync(piDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

test('Pi CLI is installed and keyed (required — its tests must run)', () => {
  assert.equal(piSkip, false, `Pi tests did not run: ${piSkip}. Install @earendil-works/pi-coding-agent, set PI_MODEL and its provider key — a green suite must include this harness.`);
});

test('pi responses complete, resume, and manage sessions on Pi\'s own store', { skip: piSkip }, async () => {
  const marker = `pi-marker-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'pi',
      model,
      input: `Remember this marker: ${marker}. Reply with just OK.`,
      reasoning_effort: 'low',
    }),
  );
  assert.equal(created.status, 'completed', JSON.stringify(created.error));
  assert.equal(created.agent, 'pi');
  // A Pi session id is a UUID minted by the gateway and owned by pi's store; the
  // client can't bring its own (see the made-up-id case below).
  assert.match(created.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(created.output_text.trim().length > 0);
  assert.ok(created.usage && created.usage.output_tokens > 0);
  assert.ok(created.usage.input_tokens > 0);
  assert.equal(created.context, null); // Pi reports no context window.

  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health?agent=pi`)), {
    ok: true,
    agent: 'pi',
    healthy: true,
  });

  // A known session id resumes on pi's own store, so the marker is recalled.
  const recalled = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'pi',
      model,
      session_id: created.session_id,
      input: 'Reply with just the marker I asked you to remember.',
      reasoning_effort: 'low',
    }),
  );
  assert.equal(recalled.status, 'completed', JSON.stringify(recalled.error));
  assert.equal(recalled.session_id, created.session_id);
  assert.ok(recalled.output_text.includes(marker), recalled.output_text);

  // History projects pi's own transcript; reads name `?agent=pi`.
  const session = await jsonOk<{ history: { role: string; content: string; created_at: number }[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=pi`),
  );
  assert.ok(session.history.some((m) => m.role === 'user' && m.content.includes(marker)));
  assert.ok(session.history.some((m) => m.role === 'assistant'));

  // The list is pi's own session store for this workspace.
  const list = await jsonOk<{ agent: string; data: Array<{ id: string; title: string | null; last_active: number | null; message_count: number | null }> }>(
    await fetch(`${base}/v1/sessions?agent=pi`),
  );
  assert.equal(list.agent, 'pi');
  const row = list.data.find((s) => s.id === created.session_id);
  assert.ok(row, 'created session appears in the list');
  assert.equal(typeof row.last_active, 'number');
  assert.ok((row.message_count ?? 0) >= 4);

  // Pi stores a session name only when one is set, and nothing sets it through
  // the gateway, so rename is a documented 405.
  const rename = await fetch(`${base}/v1/sessions/${created.session_id}?agent=pi`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'nope' }),
  });
  assert.equal(rename.status, 405);

  // Models are pi's own list for the credentials this box has.
  const models = await jsonOk<{ agent: string; data: Array<{ id: string; owned_by: string; source: string }> }>(
    await fetch(`${base}/v1/models?agent=pi`),
  );
  assert.equal(models.agent, 'pi');
  assert.ok(models.data.length > 0);
  assert.ok(models.data.every((m) => m.source === 'catalog' && m.owned_by.length > 0));

  const stream = await postJson(base, {
    agent: 'pi',
    model,
    input: 'Reply with exactly this word: PONG',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(stream.status, 200);
  const events = await new SseReader(stream).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.ok(events.some((event) => event.event === 'response.output_text.delta'));
  assert.equal(events.at(-1)?.event, 'response.completed');
  await fetch(`${base}/v1/sessions/${events[0]?.data.session_id as string}?agent=pi`, { method: 'DELETE' });

  // Delete removes the session; it leaves the list and its history projects empty.
  const deleted = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=pi`, { method: 'DELETE' }),
  );
  assert.equal(deleted.deleted, true);
  const gone = await jsonOk<{ history: unknown[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=pi`),
  );
  assert.deepEqual(gone.history, []);

  // Deleting an unknown session is not an error.
  const unknown = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/00000000-0000-0000-0000-000000000000?agent=pi`, { method: 'DELETE' }),
  );
  assert.equal(unknown.deleted, false);

  // A client cannot invent a session_id on pi: an unknown id is a 400.
  const madeUp = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'pi', session_id: 'not-a-real-session', input: 'hello' }),
  });
  assert.equal(madeUp.status, 400);
  const madeUpBody = (await madeUp.json()) as { error: { code: string; param?: string } };
  assert.equal(madeUpBody.error.code, 'validation_error');
  assert.equal(madeUpBody.error.param, 'session_id');
});

test('a pi turn on an unknown model fails with model_error', { skip: piSkip }, async () => {
  const failed = await jsonOk<ResponseBody>(
    await postJson(base, { agent: 'pi', model: 'totally/bogus-model', input: 'hello' }),
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'model_error', JSON.stringify(failed.error));
});

test('an in-flight pi turn can be cancelled', { skip: piSkip }, async () => {
  const slow = await postJson(base, {
    agent: 'pi',
    model,
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
    await fetch(`${base}/v1/sessions/${sessionId}?agent=pi`),
  );
  assert.equal(settled.active_response_id, null);
  const replay = await new SseReader(await fetch(`${base}/v1/responses/${responseId}/stream`)).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');
  // A cancelled turn reports no usage or context.
  assert.equal(replay.at(-1)?.data.usage, null);

  await fetch(`${base}/v1/sessions/${sessionId}?agent=pi`, { method: 'DELETE' });
});

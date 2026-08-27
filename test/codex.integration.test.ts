import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// --- Codex adapter. Like Claude Code (and unlike the optional OpenClaw probe),
// Codex ships in a release image, so a missing or logged-out CLI FAILS the
// suite via the gate test below rather than silently skipping. Turns run on
// Codex's own login and cost real usage.

const codexSkip = await new Promise<false | string>((resolve) => {
  execFile(process.env.CODEX_BIN?.trim() || 'codex', ['login', 'status'], { timeout: 15_000 }, (error) => {
    if (!error) resolve(false);
    else resolve('Codex is not installed or not logged in');
  });
});

let server: TestServer | undefined;
let base: string;

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
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

test('Codex CLI is installed and logged in (required — its tests must run)', () => {
  assert.equal(codexSkip, false, `Codex tests did not run: ${codexSkip}. Install Codex and \`codex login\` — a green suite must include this harness.`);
});

test('codex responses complete, resume, and manage sessions on Codex\'s own store', { skip: codexSkip }, async () => {
  const marker = `codex-marker-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'codex',
      input: `Remember this marker: ${marker}. Reply with just OK.`,
      reasoning_effort: 'low',
    }),
  );
  assert.equal(created.status, 'completed', JSON.stringify(created.error));
  assert.equal(created.agent, 'codex');
  // A Codex thread id is a UUID; the harness store owns it, so the client can't
  // bring its own on the first turn (see the made-up-id case below).
  assert.match(created.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(created.output_text.trim().length > 0);
  assert.ok(created.usage && created.usage.output_tokens > 0);
  assert.equal(created.usage.cost_usd, null); // Codex reports no USD cost.
  assert.ok(created.context && created.context.used_tokens > 0);
  assert.ok(created.context.window_tokens >= created.context.used_tokens);

  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health?agent=codex`)), {
    ok: true,
    agent: 'codex',
    healthy: true,
  });

  // A known session id resumes the thread, so the marker is recalled.
  const recalled = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'codex',
      session_id: created.session_id,
      input: 'Reply with just the marker I asked you to remember.',
      reasoning_effort: 'low',
    }),
  );
  assert.equal(recalled.status, 'completed', JSON.stringify(recalled.error));
  assert.equal(recalled.session_id, created.session_id);
  assert.ok(recalled.output_text.includes(marker), recalled.output_text);

  // History projects Codex's own thread; reads name `?agent=codex`.
  const session = await jsonOk<{ history: { role: string; content: string; created_at: number }[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=codex`),
  );
  assert.ok(session.history.some((m) => m.role === 'user' && m.content.includes(marker)));
  assert.ok(session.history.some((m) => m.role === 'assistant'));

  // The list is Codex's own thread list for this workspace.
  const list = await jsonOk<{ agent: string; data: Array<{ id: string; title: string | null; last_active: number | null }> }>(
    await fetch(`${base}/v1/sessions?agent=codex`),
  );
  assert.equal(list.agent, 'codex');
  const row = list.data.find((s) => s.id === created.session_id);
  assert.ok(row, 'created session appears in the list');
  assert.equal(typeof row.last_active, 'number');

  // Rename writes Codex's thread name; it reads back as the row title.
  const title = `integration-rename-${marker}`;
  const rename = await jsonOk<{ renamed: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=codex`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  );
  assert.equal(rename.renamed, true);
  const renamedList = await jsonOk<{ data: Array<{ id: string; title: string | null }> }>(
    await fetch(`${base}/v1/sessions?agent=codex`),
  );
  assert.equal(renamedList.data.find((s) => s.id === created.session_id)?.title, title);

  // Models are Codex's live catalog.
  const models = await jsonOk<{ agent: string; data: Array<{ id: string; owned_by: string; source: string }> }>(
    await fetch(`${base}/v1/models?agent=codex`),
  );
  assert.equal(models.agent, 'codex');
  assert.ok(models.data.length > 0);
  assert.ok(models.data.every((m) => m.owned_by === 'openai' && m.source === 'catalog'));

  const stream = await postJson(base, {
    agent: 'codex',
    input: 'Reply with exactly this word: PONG',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(stream.status, 200);
  const events = await new SseReader(stream).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.ok(events.some((event) => event.event === 'response.output_text.delta'));
  assert.equal(events.at(-1)?.event, 'response.completed');
  await fetch(`${base}/v1/sessions/${events[0]?.data.session_id as string}?agent=codex`, { method: 'DELETE' });

  // Delete removes the thread; it leaves the list and its history projects empty.
  const deleted = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=codex`, { method: 'DELETE' }),
  );
  assert.equal(deleted.deleted, true);
  const gone = await jsonOk<{ history: unknown[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=codex`),
  );
  assert.deepEqual(gone.history, []);

  // Deleting an unknown thread is not an error.
  const unknown = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/00000000-0000-0000-0000-000000000000?agent=codex`, { method: 'DELETE' }),
  );
  assert.equal(unknown.deleted, false);

  // A client cannot invent a session_id on codex: an unknown id is a 400.
  const madeUp = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'codex', session_id: 'not-a-real-thread', input: 'hello' }),
  });
  assert.equal(madeUp.status, 400);
  const madeUpBody = (await madeUp.json()) as { error: { code: string; param?: string } };
  assert.equal(madeUpBody.error.code, 'validation_error');
  assert.equal(madeUpBody.error.param, 'session_id');
});

test('an in-flight codex turn can be cancelled', { skip: codexSkip }, async () => {
  const slow = await postJson(base, {
    agent: 'codex',
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
    await fetch(`${base}/v1/sessions/${sessionId}?agent=codex`),
  );
  assert.equal(settled.active_response_id, null);
  const replay = await new SseReader(await fetch(`${base}/v1/responses/${responseId}/stream`)).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');
  // A cancelled turn reports no usage or context.
  assert.equal(replay.at(-1)?.data.usage, null);

  await fetch(`${base}/v1/sessions/${sessionId}?agent=codex`, { method: 'DELETE' });
});

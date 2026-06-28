import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';
import { DEFAULT_BASE_URL } from '../server/adapters/openclaw-adapter.js';

// Pull only the OpenClaw settings from .env. Loading the whole file would
// reshape the Hermes worker's environment too (e.g. HERMES_HOME).
try {
  const env = parse(readFileSync(new URL('../.env', import.meta.url)));
  for (const key of ['OPENCLAW_BASE_URL', 'OPENCLAW_TOKEN'] as const) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
} catch {
  // no .env — rely on the ambient environment
}

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
  model: string | null;
  output_text: string;
  usage: unknown;
  metadata: Record<string, unknown> | null;
}

async function jsonOk<T>(res: Response): Promise<T> {
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as T;
}

function assertCompleted(body: ResponseBody): void {
  assert.match(body.id, /^[a-f0-9]{32}$/);
  assert.match(body.session_id, /^[a-f0-9]{32}$/);
  assert.equal(body.status, 'completed');
  assert.equal(body.agent, 'hermes');
  assert.ok(body.output_text.trim().length > 0);
  assert.ok(body.usage);
}

test('health, version, and models endpoints answer from the real gateway', async () => {
  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health`)), {
    ok: true,
    agent: 'hermes',
    healthy: true,
    hermes: true,
  });
  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health?agent=hermes`)), {
    ok: true,
    agent: 'hermes',
    healthy: true,
    hermes: true,
  });

  const version = await jsonOk<{ name: string; version: string }>(await fetch(`${base}/v1/version`));
  assert.equal(version.name, 'agent37-gateway');
  assert.ok(version.version.length > 0);

  const models = await jsonOk<{ object: string; agent: string; data: Record<string, unknown>[] }>(
    await fetch(`${base}/v1/models`),
  );
  assert.equal(models.object, 'list');
  assert.equal(models.agent, 'hermes');
  assert.ok(Array.isArray(models.data));
  for (const model of models.data) {
    assert.equal(model.object, 'model');
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.owned_by, 'string');
  }

  // `?agent=` selects the harness; the default agent is echoed back either way.
  const defaulted = await jsonOk<{ agent: string }>(
    await fetch(`${base}/v1/models?agent=hermes`),
  );
  assert.equal(defaulted.agent, 'hermes');
});

test('responses and sessions work end-to-end through the local LLM', async () => {
  const marker = `gateway-integration-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      input: `Reply with one short sentence. Include this marker: ${marker}`,
      reasoning_effort: 'low',
      metadata: { marker },
    }),
  );
  assertCompleted(created);
  assert.equal(created.metadata?.marker, marker);

  // GET /v1/sessions lists straight from the harness, native fields untouched;
  // the chosen agent is echoed at the top level. `?agent=` selects the harness
  // (default hermes); an unknown agent is a 400.
  const sessions = await jsonOk<{ agent: string; data: Array<{ id: string }> }>(
    await fetch(`${base}/v1/sessions`),
  );
  assert.equal(sessions.agent, 'hermes');
  assert.ok(sessions.data.some((session) => session.id === created.session_id));

  const hermesSessions = await jsonOk<{ agent: string; data: Array<{ id: string }> }>(
    await fetch(`${base}/v1/sessions?agent=hermes`),
  );
  assert.equal(hermesSessions.agent, 'hermes');
  assert.ok(hermesSessions.data.some((session) => session.id === created.session_id));

  const badFilter = await fetch(`${base}/v1/sessions?agent=bogus`);
  assert.equal(badFilter.status, 400);
  const badBody = (await badFilter.json()) as { error: { code: string; param: string } };
  assert.equal(badBody.error.code, 'validation_error');
  assert.equal(badBody.error.param, 'agent');

  const session = await jsonOk<{
    id: string;
    history: Array<{ role: string; content: string }>;
  }>(await fetch(`${base}/v1/sessions/${created.session_id}`));
  assert.equal(session.id, created.session_id);
  assert.ok(session.history.some((message) => message.role === 'user' && message.content.includes(marker)));
  assert.ok(session.history.some((message) => message.role === 'assistant' && message.content.trim()));

  const continued = await jsonOk<ResponseBody>(
    await postJson(base, {
      session_id: created.session_id,
      input: 'Reply with one short follow-up sentence.',
      reasoning_effort: 'low',
    }),
  );
  assertCompleted(continued);
  assert.equal(continued.session_id, created.session_id);

  // Rename writes the title straight into Hermes' SessionDB; it round-trips
  // through the native `title` field the session list passes through — no
  // gateway-side store involved.
  const renameTitle = `renamed-${marker}`;
  const renamed = await jsonOk<{ id: string; agent: string; renamed: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: renameTitle }),
    }),
  );
  assert.deepEqual(renamed, { id: created.session_id, agent: 'hermes', renamed: true });

  const titled = await jsonOk<{ data: Array<{ id: string; title?: string }> }>(
    await fetch(`${base}/v1/sessions?agent=hermes`),
  );
  assert.equal(titled.data.find((session) => session.id === created.session_id)?.title, renameTitle);

  // An empty/whitespace title is rejected before it reaches the worker.
  const badRename = await fetch(`${base}/v1/sessions/${created.session_id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '   ' }),
  });
  assert.equal(badRename.status, 400);
  assert.equal(((await badRename.json()) as { error: { param: string } }).error.param, 'title');

  const deleted = await jsonOk<{ id: string; deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}`, { method: 'DELETE' }),
  );
  assert.deepEqual(deleted, { id: created.session_id, deleted: true });

  // After deletion the harness has no transcript, so history projects empty.
  const gone = await jsonOk<{ history: unknown[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}`),
  );
  assert.deepEqual(gone.history, []);
});

test('streaming responses can be replayed', async () => {
  const res = await postJson(base, {
    input: 'Reply with one short sentence for a streaming integration test.',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const events = await new SseReader(res).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.equal(events.at(-1)?.event, 'response.completed');
  assert.ok(events.some((event) => event.event === 'response.output_text.delta'));

  const responseId = events[0].data.id as string;

  const replay = await fetch(`${base}/v1/responses/${responseId}/stream`);
  assert.equal(replay.status, 200);
  const replayEvents = await new SseReader(replay).drain();
  assert.equal(replayEvents[0]?.event, 'response.created');
  assert.equal(replayEvents.at(-1)?.event, 'response.completed');
});

test('an in-flight response blocks another turn and can be cancelled', async () => {
  const slow = await postJson(base, {
    input: 'Count from 1 to 2000, one number per line. Do not summarize.',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(slow.status, 200);

  const reader = new SseReader(slow);
  const opening = await reader.until((event) => event.event === 'response.created');
  const created = opening.find((event) => event.event === 'response.created');
  assert.ok(created);
  const responseId = created.data.id as string;
  const sessionId = created.data.session_id as string;

  const busy = await postJson(base, { session_id: sessionId, input: 'start another turn' });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, 'session_busy');

  const cancel = await fetch(`${base}/v1/responses/${responseId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  await reader.drain(); // the in-flight stream ends once the turn is cancelled

  // Reconnecting replays the now-terminal turn and closes immediately.
  const replay = await new SseReader(
    await fetch(`${base}/v1/responses/${responseId}/stream`),
  ).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');

  // The session lock is released, so a new turn on it is no longer rejected.
  const next = await postJson(base, { session_id: sessionId, input: 'ok', reasoning_effort: 'low' });
  assert.equal(next.status, 200);
});

test('a file written via PUT can be attached to a turn and downloaded back', async () => {
  const marker = `attachment-marker-${Date.now()}`;
  const filePath = join(tmpdir(), `a37gw-attach-${Date.now()}.txt`);
  const written = await jsonOk<{ path: string; type: string; size: number }>(
    await fetch(`${base}/v1/files/content?path=${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: `The secret marker is: ${marker}\n`,
    }),
  );
  assert.equal(written.path, filePath);
  assert.equal(written.type, 'file');
  assert.ok(written.size > 0);

  const turn = await jsonOk<ResponseBody>(
    await postJson(base, {
      input: 'Read the attached file and reply with the exact secret marker it contains.',
      files: [written.path],
      reasoning_effort: 'low',
    }),
  );
  assertCompleted(turn);
  assert.ok(turn.output_text.includes(marker), `output should contain ${marker}: ${turn.output_text}`);

  // The attachment block lands in the session history the same way minions writes it.
  const session = await jsonOk<{ history: Array<{ role: string; content: string }> }>(
    await fetch(`${base}/v1/sessions/${turn.session_id}`),
  );
  assert.ok(
    session.history.some(
      (message) => message.role === 'user' && message.content.includes(`[Attached files:\n- ${written.path}]`),
    ),
  );

  const download = await fetch(`${base}/v1/files/content?path=${encodeURIComponent(written.path)}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), `The secret marker is: ${marker}\n`);
});

test('responses files[] validation stays stable', async () => {
  const badFiles = await postJson(base, { input: 'x', files: 'not-an-array' });
  assert.equal(badFiles.status, 400);
  assert.equal((await badFiles.json()).error.param, 'files');

  const missingAttachment = await postJson(base, { input: 'x', files: ['/nope/missing.txt'] });
  assert.equal(missingAttachment.status, 400);
  const missingBody = await missingAttachment.json();
  assert.equal(missingBody.error.param, 'files');
  assert.ok(missingBody.error.message.includes('/nope/missing.txt'));
});

// --- OpenClaw adapter (needs a local OpenClaw gateway; skipped when it's down) ---

const openclawBase = process.env.OPENCLAW_BASE_URL?.trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
const openclawSkip = (await fetch(`${openclawBase}/health`).then((res) => res.ok).catch(() => false))
  ? false
  : 'no OpenClaw gateway running locally';

test('openclaw responses complete, stream, and stay on one session', { skip: openclawSkip }, async () => {
  const marker = `openclaw-marker-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'openclaw',
      input: `Remember this marker: ${marker}. Reply with just OK.`,
    }),
  );
  assert.equal(created.status, 'completed');
  assert.equal(created.agent, 'openclaw');
  assert.equal(created.model, null);
  assert.ok(created.output_text.trim().length > 0);
  assert.ok(created.usage);

  const recalled = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'openclaw',
      session_id: created.session_id,
      input: 'Reply with just the marker I asked you to remember.',
    }),
  );
  assert.equal(recalled.status, 'completed');
  assert.equal(recalled.session_id, created.session_id);
  assert.ok(recalled.output_text.includes(marker));

  // History reads back through OpenClaw's GET /sessions/{key}/history. The
  // session lives on OpenClaw, so the read must name `?agent=openclaw` — the
  // gateway keeps no index to infer it from.
  const session = await jsonOk<{ history: { role: string; content: string }[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=openclaw`),
  );
  assert.ok(session.history.some((m) => m.role === 'user' && m.content.includes(marker)));
  assert.ok(session.history.some((m) => m.role === 'assistant' && m.content.includes(marker)));

  // OpenClaw has no list API over HTTP, so the adapter shells out to the
  // `openclaw` CLI and surfaces each `openresponses-user:{user}` session under
  // the `id` it reads back with — so the created session shows up here.
  const list = await jsonOk<{ agent: string; data: Array<{ id: string }> }>(
    await fetch(`${base}/v1/sessions?agent=openclaw`),
  );
  assert.equal(list.agent, 'openclaw');
  assert.ok(list.data.some((s) => s.id === created.session_id));

  // OpenClaw stores no round-trippable session title, so rename is a 405 rather
  // than a gateway-side name the read paths couldn't surface.
  const rename = await fetch(`${base}/v1/sessions/${created.session_id}?agent=openclaw`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'nope' }),
  });
  assert.equal(rename.status, 405);
  assert.equal(((await rename.json()) as { error: { code: string } }).error.code, 'rename_unsupported');

  const stream = await postJson(base, {
    agent: 'openclaw',
    input: 'Reply with one short sentence.',
    stream: true,
  });
  assert.equal(stream.status, 200);
  const events = await new SseReader(stream).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.ok(events.some((event) => event.event === 'response.output_text.delta'));
  assert.equal(events.at(-1)?.event, 'response.completed');
});

test('an in-flight openclaw turn can be cancelled', { skip: openclawSkip }, async () => {
  const slow = await postJson(base, {
    agent: 'openclaw',
    input: 'Write a 1000 word essay about oceans.',
    stream: true,
  });
  assert.equal(slow.status, 200);

  const reader = new SseReader(slow);
  const opening = await reader.until((event) => event.event === 'response.created');
  const responseId = opening.at(-1)?.data.id as string;

  const cancel = await fetch(`${base}/v1/responses/${responseId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  await reader.drain(); // the in-flight stream ends once the turn is cancelled

  // Reconnecting replays the now-terminal turn and closes immediately.
  const replay = await new SseReader(
    await fetch(`${base}/v1/responses/${responseId}/stream`),
  ).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');
});

test('validation and not-found errors stay stable', async () => {
  const noInput = await postJson(base, {});
  assert.equal(noInput.status, 400);
  assert.equal((await noInput.json()).error.param, 'input');

  const goal = await postJson(base, { input: 'x', mode: 'goal' });
  assert.equal(goal.status, 400);
  assert.equal((await goal.json()).error.param, 'mode');

  const badHealthAgent = await fetch(`${base}/v1/health?agent=bogus`);
  assert.equal(badHealthAgent.status, 400);
  assert.equal((await badHealthAgent.json()).error.param, 'agent');

  // GET /v1/responses/:id was removed; the stream endpoint still 404s a missing id.
  const response = await fetch(`${base}/v1/responses/missing/stream`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'response_not_found');

  // Sessions project from the harness, which owns existence: an unknown id
  // returns empty history rather than a 404.
  const session = await jsonOk<{ history: unknown[] }>(await fetch(`${base}/v1/sessions/missing`));
  assert.deepEqual(session.history, []);

  const route = await fetch(`${base}/v1/nope`);
  assert.equal(route.status, 404);
  assert.equal((await route.json()).error.code, 'not_found');
});

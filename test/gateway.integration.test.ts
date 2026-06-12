import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { parse } from 'dotenv';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

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

async function waitForTerminalResponse(responseId: string): Promise<ResponseBody> {
  for (let i = 0; i < 120; i += 1) {
    const body = await jsonOk<ResponseBody>(await fetch(`${base}/v1/responses/${responseId}`));
    if (body.status !== 'in_progress') return body;
    await delay(500);
  }
  throw new Error(`response ${responseId} stayed in_progress`);
}

test('health, version, and models endpoints answer from the real gateway', async () => {
  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health`)), { ok: true, hermes: true });

  const version = await jsonOk<{ name: string; version: string }>(await fetch(`${base}/v1/version`));
  assert.equal(version.name, 'agent37-gateway');
  assert.ok(version.version.length > 0);

  const models = await jsonOk<{ data: unknown[] }>(await fetch(`${base}/v1/models`));
  assert.ok(Array.isArray(models.data));
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

  const fetched = await jsonOk<ResponseBody>(await fetch(`${base}/v1/responses/${created.id}`));
  assert.equal(fetched.output_text, created.output_text);

  const sessions = await jsonOk<{ data: Array<{ id: string }> }>(await fetch(`${base}/v1/sessions`));
  assert.ok(sessions.data.some((session) => session.id === created.session_id));

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

  const deleted = await jsonOk<{ id: string; deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}`, { method: 'DELETE' }),
  );
  assert.deepEqual(deleted, { id: created.session_id, deleted: true });
  assert.equal((await fetch(`${base}/v1/sessions/${created.session_id}`)).status, 404);
  assert.equal((await fetch(`${base}/v1/responses/${created.id}`)).status, 404);
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
  assertCompleted(await jsonOk<ResponseBody>(await fetch(`${base}/v1/responses/${responseId}`)));

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
  await reader.drain();
  assert.equal((await waitForTerminalResponse(responseId)).status, 'cancelled');
});

test('a file can be uploaded, attached to a turn, and downloaded back', async () => {
  const marker = `attachment-marker-${Date.now()}`;
  const form = new FormData();
  form.set('file', new File([`The secret marker is: ${marker}\n`], 'attachment tëst.txt'));
  const uploaded = await jsonOk<{ path: string; filename: string; bytes: number }>(
    await fetch(`${base}/v1/files`, { method: 'POST', body: form }),
  );
  assert.equal(uploaded.filename, 'attachment tëst.txt'); // UTF-8 name survives multipart
  assert.match(uploaded.path, /\/workspace\/uploads\/[a-f0-9]{8}-attachment tëst\.txt$/);
  assert.ok(uploaded.bytes > 0);
  assert.ok(existsSync(uploaded.path));

  const turn = await jsonOk<ResponseBody>(
    await postJson(base, {
      input: 'Read the attached file and reply with the exact secret marker it contains.',
      files: [uploaded.path],
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
      (message) => message.role === 'user' && message.content.includes(`[Attached files:\n- ${uploaded.path}]`),
    ),
  );

  const download = await fetch(`${base}/v1/files/content?path=${encodeURIComponent(uploaded.path)}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), `The secret marker is: ${marker}\n`);

  // Agents produce dotfiles too; express must not hide them.
  const dotfilePath = join(dirname(uploaded.path), '.dotfile-download-test');
  writeFileSync(dotfilePath, 'dot');
  const dotfile = await fetch(`${base}/v1/files/content?path=${encodeURIComponent(dotfilePath)}`);
  assert.equal(dotfile.status, 200);
  assert.equal(await dotfile.text(), 'dot');
});

test('file validation and not-found errors stay stable', async () => {
  const noFile = await fetch(`${base}/v1/files`, { method: 'POST', body: new FormData() });
  assert.equal(noFile.status, 400);
  assert.equal((await noFile.json()).error.param, 'file');

  const badFiles = await postJson(base, { input: 'x', files: 'not-an-array' });
  assert.equal(badFiles.status, 400);
  assert.equal((await badFiles.json()).error.param, 'files');

  const missingAttachment = await postJson(base, { input: 'x', files: ['/nope/missing.txt'] });
  assert.equal(missingAttachment.status, 400);
  const missingBody = await missingAttachment.json();
  assert.equal(missingBody.error.param, 'files');
  assert.ok(missingBody.error.message.includes('/nope/missing.txt'));

  const noPath = await fetch(`${base}/v1/files/content`);
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error.param, 'path');

  const missingDownload = await fetch(`${base}/v1/files/content?path=${encodeURIComponent('/nope/missing.txt')}`);
  assert.equal(missingDownload.status, 404);
  assert.equal((await missingDownload.json()).error.code, 'file_not_found');
});

// --- OpenClaw adapter (needs a local OpenClaw gateway; skipped when it's down) ---

const openclawBase = process.env.OPENCLAW_BASE_URL?.trim().replace(/\/$/, '') || 'http://localhost:3738';
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
  await reader.drain();
  assert.equal((await waitForTerminalResponse(responseId)).status, 'cancelled');
});

test('validation and not-found errors stay stable', async () => {
  const noInput = await postJson(base, {});
  assert.equal(noInput.status, 400);
  assert.equal((await noInput.json()).error.param, 'input');

  const goal = await postJson(base, { input: 'x', mode: 'goal' });
  assert.equal(goal.status, 400);
  assert.equal((await goal.json()).error.param, 'mode');

  const response = await fetch(`${base}/v1/responses/missing`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'response_not_found');

  const session = await fetch(`${base}/v1/sessions/missing`);
  assert.equal(session.status, 404);
  assert.equal((await session.json()).error.code, 'session_not_found');

  const route = await fetch(`${base}/v1/nope`);
  assert.equal(route.status, 404);
  assert.equal((await route.json()).error.code, 'not_found');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// --- OpenCode adapter. Like Claude Code and Codex (and unlike the optional
// OpenClaw probe), OpenCode ships in a release image, so a missing CLI FAILS
// the suite via the gate test below rather than silently skipping. The happy
// path runs on a free Zen model (`opencode/*-free`) so it costs nothing; a
// managed or BYO-keyed instance answers the same way.

const opencodeSkip = await new Promise<false | string>((resolve) => {
  execFile(process.env.OPENCODE_BIN?.trim() || 'opencode', ['--version'], { timeout: 15_000 }, (error) => {
    resolve(error ? 'OpenCode is not installed' : false);
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

/** A no-cost model to run the suite on: prefer `big-pickle` (a stable Zen model
 *  that reports usage), else any free Zen model, else the configured default,
 *  else the first model the instance advertises. */
async function pickModel(): Promise<string> {
  const models = await jsonOk<{ default_model: string | null; data: Array<{ id: string }> }>(
    await fetch(`${base}/v1/models?agent=opencode`),
  );
  assert.ok(models.data.length > 0, 'OpenCode advertises at least one model');
  return (
    models.data.find((m) => /big-pickle$/i.test(m.id))?.id ??
    models.data.find((m) => /free/i.test(m.id))?.id ??
    models.data.find((m) => m.id.startsWith('opencode/'))?.id ??
    models.default_model ??
    models.data[0].id
  );
}

test('OpenCode CLI is installed (required — its tests must run)', () => {
  assert.equal(opencodeSkip, false, `OpenCode tests did not run: ${opencodeSkip}. Install OpenCode — a green suite must include this harness.`);
});

test('opencode responses complete, resume, and manage sessions on OpenCode\'s own store', { skip: opencodeSkip }, async () => {
  const model = await pickModel();
  const marker = `opencode-marker-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'opencode',
      model,
      input: `Remember this marker: ${marker}. Reply with just OK.`,
      reasoning_effort: 'low',
    }),
  );
  assert.equal(created.status, 'completed', JSON.stringify(created.error));
  assert.equal(created.agent, 'opencode');
  // An OpenCode session id; the harness store owns it, so a client can't bring
  // its own on the first turn (see the made-up-id case below).
  assert.match(created.session_id, /^ses_/);
  assert.ok(created.output_text.trim().length > 0);
  // The gateway projects whatever OpenCode reports; the shape is the contract
  // (some free models report zero token counts, so don't assert a positive).
  assert.ok(created.usage, 'usage is reported');
  assert.equal(typeof created.usage.input_tokens, 'number');
  assert.equal(typeof created.usage.output_tokens, 'number');
  // OpenCode always reports a cost number (0 on free/unpriced models).
  assert.equal(typeof created.usage.cost_usd, 'number');

  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health?agent=opencode`)), {
    ok: true,
    agent: 'opencode',
    healthy: true,
  });

  // A known session id resumes it, so the marker is recalled.
  const recalled = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'opencode',
      model,
      session_id: created.session_id,
      input: 'Reply with just the marker I asked you to remember.',
      reasoning_effort: 'low',
    }),
  );
  assert.equal(recalled.status, 'completed', JSON.stringify(recalled.error));
  assert.equal(recalled.session_id, created.session_id);
  assert.ok(recalled.output_text.includes(marker), recalled.output_text);

  // History projects OpenCode's own session; reads name `?agent=opencode`.
  const session = await jsonOk<{ history: { role: string; content: string; created_at: number }[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=opencode`),
  );
  assert.ok(session.history.some((m) => m.role === 'user' && m.content.includes(marker)));
  assert.ok(session.history.some((m) => m.role === 'assistant'));

  // The list is OpenCode's own session list.
  const list = await jsonOk<{ agent: string; data: Array<{ id: string; title: string | null; last_active: number | null }> }>(
    await fetch(`${base}/v1/sessions?agent=opencode`),
  );
  assert.equal(list.agent, 'opencode');
  const row = list.data.find((s) => s.id === created.session_id);
  assert.ok(row, 'created session appears in the list');
  assert.equal(typeof row.last_active, 'number');

  // OpenCode auto-titles the first turn asynchronously (an LLM summary that can
  // land seconds later). Wait for it to replace the "New session …" placeholder
  // before renaming, so that one-shot auto-title can't clobber the rename after
  // the fact; then the write/read below is the gateway's own contract.
  const titleRow = async (): Promise<string | null> => {
    const list = await jsonOk<{ data: Array<{ id: string; title: string | null }> }>(
      await fetch(`${base}/v1/sessions?agent=opencode`),
    );
    return list.data.find((s) => s.id === created.session_id)?.title ?? null;
  };
  for (let i = 0; i < 30; i++) {
    const t = await titleRow();
    if (t && !/^New session/.test(t)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const title = `integration-rename-${marker}`;
  const rename = await jsonOk<{ renamed: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=opencode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  );
  assert.equal(rename.renamed, true);
  assert.equal(await titleRow(), title);

  // Models are OpenCode's provider catalog, each owned by its provider.
  const models = await jsonOk<{ agent: string; data: Array<{ id: string; owned_by: string; source: string }> }>(
    await fetch(`${base}/v1/models?agent=opencode`),
  );
  assert.equal(models.agent, 'opencode');
  assert.ok(models.data.length > 0);
  assert.ok(models.data.every((m) => m.source === 'catalog' && typeof m.owned_by === 'string'));

  const stream = await postJson(base, {
    agent: 'opencode',
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
  await fetch(`${base}/v1/sessions/${events[0]?.data.session_id as string}?agent=opencode`, { method: 'DELETE' });

  // Delete removes the session; its history then projects empty.
  const deleted = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=opencode`, { method: 'DELETE' }),
  );
  assert.equal(deleted.deleted, true);
  const gone = await jsonOk<{ history: unknown[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=opencode`),
  );
  assert.deepEqual(gone.history, []);

  // Deleting an unknown session is not an error.
  const unknown = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/ses_00000000000000000000000000?agent=opencode`, { method: 'DELETE' }),
  );
  assert.equal(unknown.deleted, false);

  // A client cannot invent a session_id on opencode: an unknown id is a 400.
  const madeUp = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'opencode', session_id: 'ses_notarealsession', input: 'hello' }),
  });
  assert.equal(madeUp.status, 400);
  const madeUpBody = (await madeUp.json()) as { error: { code: string; param?: string } };
  assert.equal(madeUpBody.error.code, 'validation_error');
  assert.equal(madeUpBody.error.param, 'session_id');

  // A bare/malformed model id is rejected, not silently run on the default and
  // mislabelled as the requested model.
  const badModel = await jsonOk<ResponseBody>(await postJson(base, { agent: 'opencode', model: 'not-a-real-model', input: 'hi' }));
  assert.equal(badModel.status, 'failed');
  assert.equal(badModel.error?.code, 'model_error');
  await fetch(`${base}/v1/sessions/${badModel.session_id}?agent=opencode`, { method: 'DELETE' });
});

test('an in-flight opencode turn can be cancelled', { skip: opencodeSkip }, async () => {
  const model = await pickModel();
  const slow = await postJson(base, {
    agent: 'opencode',
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

  // Whatever the model did, the session lock releases and the turn settles.
  const settled = await jsonOk<{ active_response_id: string | null }>(
    await fetch(`${base}/v1/sessions/${sessionId}?agent=opencode`),
  );
  assert.equal(settled.active_response_id, null);
  const replay = await new SseReader(await fetch(`${base}/v1/responses/${responseId}/stream`)).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');

  await fetch(`${base}/v1/sessions/${sessionId}?agent=opencode`, { method: 'DELETE' });
});

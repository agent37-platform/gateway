import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// --- Claude Code adapter. Unlike the OpenClaw probe (optional harness, its
// tests skip), Claude Code ships in the images this repo releases into, so a
// missing or logged-out CLI FAILS the suite via the gate test below instead of
// silently green-lighting an untested harness. Turns run on that login, so
// they cost real usage.

const claudeCodeSkip = await new Promise<false | string>((resolve) => {
  execFile(process.env.CLAUDE_CODE_BIN?.trim() || 'claude', ['auth', 'status', '--json'], { timeout: 15_000 }, (error, stdout) => {
    if (error) {
      resolve('no Claude Code CLI installed');
      return;
    }
    try {
      resolve((JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true ? false : 'Claude Code is not logged in');
    } catch {
      resolve('Claude Code auth status unreadable');
    }
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
  model: string | null;
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

test('Claude Code CLI is installed and logged in (required — its tests must run)', () => {
  assert.equal(claudeCodeSkip, false, `Claude Code tests did not run: ${claudeCodeSkip}. Install the CLI and \`claude auth login\` — a green suite must include this harness.`);
});

test('claude-code responses complete, resume, and manage sessions on Claude Code\'s own store', { skip: claudeCodeSkip }, async () => {
  const marker = `claude-code-marker-${Date.now()}`;
  const created = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'claude-code',
      input: `Remember this marker: ${marker}. Reply with just OK.`,
      reasoning_effort: 'low',
    }),
  );
  assert.equal(created.status, 'completed', JSON.stringify(created.error));
  assert.equal(created.agent, 'claude-code');
  assert.match(created.session_id, /^[a-f0-9]{32}$/);
  assert.ok(created.output_text.trim().length > 0);
  assert.ok(created.usage && created.usage.output_tokens > 0);
  assert.equal(typeof created.usage.cost_usd, 'number');
  // The window the turn ran in, from Claude Code's own per-model usage.
  assert.ok(created.context && created.context.used_tokens > 0);
  assert.ok(created.context.window_tokens >= created.context.used_tokens);

  assert.deepEqual(await jsonOk(await fetch(`${base}/v1/health?agent=claude-code`)), {
    ok: true,
    agent: 'claude-code',
    healthy: true,
  });

  // A known session id resumes the transcript (`--resume`), so the marker is recalled.
  const recalled = await jsonOk<ResponseBody>(
    await postJson(base, {
      agent: 'claude-code',
      session_id: created.session_id,
      input: 'Reply with just the marker I asked you to remember.',
      reasoning_effort: 'low',
    }),
  );
  assert.equal(recalled.status, 'completed', JSON.stringify(recalled.error));
  assert.equal(recalled.session_id, created.session_id);
  assert.ok(recalled.output_text.includes(marker), recalled.output_text);

  // History projects Claude Code's transcript; reads must name `?agent=claude-code`.
  const session = await jsonOk<{ history: { role: string; content: string; created_at: number }[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=claude-code`),
  );
  assert.ok(session.history.some((m) => m.role === 'user' && m.content.includes(marker)));
  assert.ok(session.history.some((m) => m.role === 'assistant' && m.content.includes(marker)));
  assert.ok(session.history.every((m) => m.created_at > 0));

  // The list is Claude Code's own (its projects store for the workspace cwd);
  // the UUID strips back to the gateway id, and the display title is set.
  const list = await jsonOk<{ agent: string; data: Array<{ id: string; title: string | null; last_active: number | null }> }>(
    await fetch(`${base}/v1/sessions?agent=claude-code`),
  );
  assert.equal(list.agent, 'claude-code');
  const row = list.data.find((s) => s.id === created.session_id);
  assert.ok(row);
  assert.ok(row.title && row.title.length > 0);
  assert.equal(typeof row.last_active, 'number');

  // Rename is Claude Code's own /rename (a custom-title entry in the transcript).
  const title = `integration-rename-${marker}`;
  const rename = await jsonOk<{ renamed: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=claude-code`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  );
  assert.equal(rename.renamed, true);
  const renamedList = await jsonOk<{ data: Array<{ id: string; title: string | null }> }>(
    await fetch(`${base}/v1/sessions?agent=claude-code`),
  );
  assert.equal(renamedList.data.find((s) => s.id === created.session_id)?.title, title);

  // Models are Claude Code's fixed aliases.
  const models = await jsonOk<{ agent: string; data: Array<{ id: string; owned_by: string; source: string }> }>(
    await fetch(`${base}/v1/models?agent=claude-code`),
  );
  assert.equal(models.agent, 'claude-code');
  assert.ok(models.data.some((m) => m.id === 'sonnet' && m.owned_by === 'anthropic' && m.source === 'alias'));

  const stream = await postJson(base, {
    agent: 'claude-code',
    input: 'Reply with exactly this word: PONG',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(stream.status, 200);
  const events = await new SseReader(stream).drain();
  assert.equal(events[0]?.event, 'response.created');
  assert.ok(events.some((event) => event.event === 'response.output_text.delta'));
  assert.equal(events.at(-1)?.event, 'response.completed');
  assert.ok(events.at(-1)?.data.context);
  await fetch(`${base}/v1/sessions/${events[0]?.data.session_id as string}?agent=claude-code`, { method: 'DELETE' });

  // Delete removes the transcript; the session leaves the list and its history projects empty.
  const deleted = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=claude-code`, { method: 'DELETE' }),
  );
  assert.equal(deleted.deleted, true);
  const afterDelete = await jsonOk<{ data: Array<{ id: string }> }>(await fetch(`${base}/v1/sessions?agent=claude-code`));
  assert.ok(!afterDelete.data.some((s) => s.id === created.session_id));
  const gone = await jsonOk<{ history: unknown[] }>(
    await fetch(`${base}/v1/sessions/${created.session_id}?agent=claude-code`),
  );
  assert.deepEqual(gone.history, []);

  // Unknown ids are not an error: no transcript means nothing to delete or rename.
  const unknown = await jsonOk<{ deleted: boolean }>(
    await fetch(`${base}/v1/sessions/missing?agent=claude-code`, { method: 'DELETE' }),
  );
  assert.equal(unknown.deleted, false);
});

test('an in-flight claude-code turn can be cancelled', { skip: claudeCodeSkip }, async () => {
  const slow = await postJson(base, {
    agent: 'claude-code',
    input: 'Write a 1500 word essay about oceans. Do not use any tools.',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(slow.status, 200);

  const reader = new SseReader(slow);
  const opening = await reader.until((event) => event.event === 'response.output_text.delta');
  const created = opening.find((event) => event.event === 'response.created');
  assert.ok(created);
  const responseId = created.data.id as string;
  const sessionId = created.data.session_id as string;

  const cancel = await fetch(`${base}/v1/responses/${responseId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  await reader.drain(); // the in-flight stream ends once the turn is cancelled

  // Terminal turn: the session lock is released and the replay closes immediately.
  const settled = await jsonOk<{ active_response_id: string | null }>(
    await fetch(`${base}/v1/sessions/${sessionId}?agent=claude-code`),
  );
  assert.equal(settled.active_response_id, null);
  const replay = await new SseReader(await fetch(`${base}/v1/responses/${responseId}/stream`)).drain();
  assert.equal(replay.at(-1)?.event, 'response.completed');
  // A cancelled turn reports no usage or context; a completed one always carries the window.
  assert.equal(replay.at(-1)?.data.context, null);
  assert.equal(replay.at(-1)?.data.usage, null);

  await fetch(`${base}/v1/sessions/${sessionId}?agent=claude-code`, { method: 'DELETE' });
});

// Point Claude Code at an empty config dir (no login) — the turn must settle as
// a failed response with the documented auth_error and the login hint.
const notLoggedInSkip =
  claudeCodeSkip ||
  (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? 'a Claude credential is set in the environment'
    : false);

test('a claude-code turn without a login fails with auth_error', { skip: notLoggedInSkip }, async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const configDir = mkdtempSync(join(tmpdir(), 'a37gw-claude-nologin-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const failed = await jsonOk<ResponseBody>(
      await postJson(base, { agent: 'claude-code', input: 'hello', reasoning_effort: 'low' }),
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'auth_error');
    assert.match(failed.error?.hint ?? '', /claude auth login/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  }
});

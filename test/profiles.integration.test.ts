import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { startTestServer, postJson, type TestServer } from './test-helpers.js';
import { resolveHermesHome } from '../server/paths.js';

// Two throwaway Hermes profiles in the real Hermes home, each with its own SOUL
// and a copy of the root config (credentials fall back to the root auth store).
// A turn with `profile` must run in that profile's home: its persona answers and
// its session lands in its own store, not the default one or the other profile's.
let server: TestServer | undefined;
let base: string;
const suffix = randomBytes(4).toString('hex');
const personas = [
  { profile: `a37gw-test-${suffix}-a`, name: 'Zorblax' },
  { profile: `a37gw-test-${suffix}-b`, name: 'Quintessa' },
];

function profileDir(profile: string): string {
  return join(resolveHermesHome(), 'profiles', profile);
}

before(async () => {
  for (const { profile, name } of personas) {
    const dir = profileDir(profile);
    mkdirSync(dir, { recursive: true });
    for (const file of ['config.yaml', '.env']) {
      const source = join(resolveHermesHome(), file);
      if (existsSync(source)) copyFileSync(source, join(dir, file));
    }
    writeFileSync(join(dir, 'SOUL.md'), `Your name is ${name}. When asked your name, answer with exactly: ${name}\n`);
  }
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  for (const { profile } of personas) rmSync(profileDir(profile), { recursive: true, force: true });
});

interface ResponseBody {
  session_id: string;
  status: string;
  profile: string | null;
  output_text: string;
}

async function sessionIds(query: string): Promise<string[]> {
  const res = await fetch(`${base}/v1/sessions${query}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((session) => session.id);
}

test('each profile answers in its own persona and keeps its own sessions', async () => {
  const results: ResponseBody[] = [];
  for (const { profile, name } of personas) {
    const res = await postJson(base, { profile, input: 'What is your name? Reply with your name only.', reasoning_effort: 'low' });
    const body = (await res.json()) as ResponseBody;
    assert.equal(body.status, 'completed', JSON.stringify(body));
    assert.equal(body.profile, profile);
    assert.match(body.output_text, new RegExp(name));
    results.push(body);
  }

  const [a, b] = results;
  const aSessions = await sessionIds(`?profile=${personas[0].profile}`);
  const bSessions = await sessionIds(`?profile=${personas[1].profile}`);
  assert.ok(aSessions.includes(a.session_id) && !aSessions.includes(b.session_id));
  assert.ok(bSessions.includes(b.session_id) && !bSessions.includes(a.session_id));
  const defaultSessions = await sessionIds('');
  assert.ok(!defaultSessions.includes(a.session_id) && !defaultSessions.includes(b.session_id));

  // A session continues on its profile, and its transcript reads from there too.
  const followUp = await postJson(base, {
    profile: personas[0].profile,
    session_id: a.session_id,
    input: 'Repeat your name once more.',
    reasoning_effort: 'low',
  });
  const followBody = (await followUp.json()) as ResponseBody;
  assert.equal(followBody.status, 'completed');
  assert.match(followBody.output_text, /Zorblax/);
  const history = await fetch(`${base}/v1/sessions/${a.session_id}?profile=${personas[0].profile}`);
  const historyBody = (await history.json()) as { history: Array<{ role: string }> };
  assert.equal(historyBody.history.filter((m) => m.role === 'user').length, 2);

  const deleted = await fetch(`${base}/v1/sessions/${b.session_id}?profile=${personas[1].profile}`, { method: 'DELETE' });
  assert.deepEqual(await deleted.json(), { id: b.session_id, deleted: true });
});

test('profile is validated: bad name 400, unknown profile 404, non-Hermes agent 400', async () => {
  const bad = await postJson(base, { profile: '../etc', input: 'hi' });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { param: string } }).error.param, 'profile');

  const missing = await fetch(`${base}/v1/sessions?profile=a37gw-no-such-profile`);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'profile_not_found');

  const wrongAgent = await postJson(base, { agent: 'codex', profile: personas[0].profile, input: 'hi' });
  assert.equal(wrongAgent.status, 400);

  // "default" is the instance's own Hermes home, same as omitting it.
  const models = await fetch(`${base}/v1/models?profile=default`);
  assert.equal(models.status, 200);
});

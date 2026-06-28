// The /v1/files surface is pure filesystem — it never touches a harness — so
// this suite boots the real Express app but needs no live Hermes/LLM. Run it
// alone with: node --import tsx --test test/files.integration.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startTestServer, type TestServer } from './test-helpers.js';
import { resolveWorkspaceDir } from '../server/paths.js';
import type { FileEntry, FileListResponse as ListBody } from '../shared/types.js';

let server: TestServer | undefined;
let base: string;

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
});

async function jsonOk<T>(res: Response): Promise<T> {
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as T;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'a37gw-files-'));
}

const filesUrl = (path: string) => `${base}/v1/files?path=${encodeURIComponent(path)}`;
const contentUrl = (path: string, query = '') =>
  `${base}/v1/files/content?path=${encodeURIComponent(path)}${query}`;
const archiveUrl = (path: string) => `${base}/v1/files/archive?path=${encodeURIComponent(path)}`;

/** Extract a fetched .tar.gz response body into a fresh dir; returns that dir. */
async function extractArchive(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  // gzip magic — proves we streamed a real gzip stream, not an error body.
  assert.equal(buf[0], 0x1f);
  assert.equal(buf[1], 0x8b);
  const work = freshDir();
  const tgz = join(work, 'archive.tar.gz');
  writeFileSync(tgz, buf);
  const out = join(work, 'out');
  mkdirSync(out);
  const r = spawnSync('tar', ['-xzf', tgz, '-C', out]);
  assert.equal(r.status, 0, r.stderr?.toString());
  return out;
}

test('GET /v1/files lists one level: dirs first, then case-insensitive name', async () => {
  const dir = freshDir();
  mkdirSync(join(dir, 'alpha-dir'));
  writeFileSync(join(dir, 'Zebra.txt'), 'z');
  writeFileSync(join(dir, 'apple.txt'), 'apple');
  writeFileSync(join(dir, '.hidden'), 'h');
  symlinkSync(join(dir, 'apple.txt'), join(dir, 'link'));

  const body = await jsonOk<ListBody>(await fetch(filesUrl(dir)));
  assert.equal(body.path, dir);
  assert.equal(body.parentPath, dirname(dir));
  assert.equal(body.truncated, false);
  assert.equal(body.entries.length, 5);

  // Same ordering rule the route applies — directories first, then name (ci).
  const expected = [...body.entries].sort((a, b) => {
    const ad = a.type === 'directory';
    const bd = b.type === 'directory';
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  assert.deepEqual(body.entries.map((e) => e.name), expected.map((e) => e.name));
  assert.equal(body.entries[0].name, 'alpha-dir');

  const byName = Object.fromEntries(body.entries.map((e) => [e.name, e]));
  assert.equal(byName['alpha-dir'].type, 'directory');
  assert.equal(byName['alpha-dir'].size, null);
  assert.equal(byName['apple.txt'].type, 'file');
  assert.equal(byName['apple.txt'].size, 5);
  assert.equal(byName['link'].type, 'symlink');
  assert.equal(byName['.hidden'].hidden, true);
  assert.equal(byName['apple.txt'].hidden, false);
  for (const entry of body.entries) {
    assert.equal(entry.path, join(dir, entry.name));
    assert.equal(typeof entry.modified, 'number');
  }
});

test('GET /v1/files defaults to the workspace dir and roots parentPath at /', async () => {
  // Production creates the workspace at boot (ensureGatewayStateDirs); the test
  // boots the app directly, so create it here before listing the default.
  mkdirSync(resolveWorkspaceDir(), { recursive: true });
  const dflt = await jsonOk<ListBody>(await fetch(`${base}/v1/files`));
  assert.equal(dflt.path, resolveWorkspaceDir());
  assert.ok(Array.isArray(dflt.entries));

  const root = await jsonOk<ListBody>(await fetch(filesUrl('/')));
  assert.equal(root.path, '/');
  assert.equal(root.parentPath, null);
});

test('GET /v1/files errors: not-a-directory and missing path', async () => {
  const dir = freshDir();
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'x');

  const notDir = await fetch(filesUrl(file));
  assert.equal(notDir.status, 400);
  assert.equal((await notDir.json()).error.code, 'not_a_directory');

  const missing = await fetch(filesUrl(join(dir, 'nope')));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'file_not_found');
});

test('GET /v1/files/content reads, previews, and downloads', async () => {
  const dir = freshDir();
  const file = join(dir, 'note.txt');
  writeFileSync(file, 'hello world');

  const dl = await fetch(contentUrl(file));
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello world');
  assert.match(dl.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment/);

  const inline = await fetch(contentUrl(file, '&disposition=inline'));
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-disposition'), 'inline');
  assert.equal(await inline.text(), 'hello world');

  // Agents produce dotfiles too; express must not hide them.
  const dot = join(dir, '.env');
  writeFileSync(dot, 'SECRET=1');
  const dotRes = await fetch(contentUrl(dot));
  assert.equal(dotRes.status, 200);
  assert.equal(await dotRes.text(), 'SECRET=1');
});

test('GET /v1/files/content errors stay stable', async () => {
  const dir = freshDir();

  const noPath = await fetch(`${base}/v1/files/content`);
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error.param, 'path');

  const missing = await fetch(contentUrl(join(dir, 'nope.txt')));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'file_not_found');

  const notFile = await fetch(contentUrl(dir));
  assert.equal(notFile.status, 400);
  assert.equal((await notFile.json()).error.code, 'validation_error');
});

test('PUT /v1/files/content writes raw bytes, mkdir -p parent, returns the entry', async () => {
  const dir = freshDir();
  const file = join(dir, 'nested/deep/file.txt');

  const created = await jsonOk<FileEntry>(
    await fetch(contentUrl(file), { method: 'PUT', body: 'first' }),
  );
  assert.equal(created.path, file);
  assert.equal(created.name, 'file.txt');
  assert.equal(created.type, 'file');
  assert.equal(created.size, 5);
  assert.equal(existsSync(file), true);
  assert.equal(statSync(file).size, 5);

  // Overwrite is the default.
  const updated = await jsonOk<FileEntry>(
    await fetch(contentUrl(file), { method: 'PUT', body: 'second-longer' }),
  );
  assert.equal(updated.size, 'second-longer'.length);

  const noPath = await fetch(`${base}/v1/files/content`, { method: 'PUT', body: 'x' });
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error.param, 'path');
});

test('PUT /v1/files/content honors overwrite=false and X-Expected-Mtime', async () => {
  const dir = freshDir();
  const file = join(dir, 'guarded.txt');

  // overwrite=false on an absent file creates it.
  await jsonOk<FileEntry>(
    await fetch(contentUrl(file, '&overwrite=false'), { method: 'PUT', body: 'v1' }),
  );
  // overwrite=false on an existing file is a 409.
  const conflict = await fetch(contentUrl(file, '&overwrite=false'), { method: 'PUT', body: 'v2' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'file_exists');

  // A stale X-Expected-Mtime is a 412.
  const stale = await fetch(contentUrl(file), {
    method: 'PUT',
    headers: { 'X-Expected-Mtime': '1' },
    body: 'v3',
  });
  assert.equal(stale.status, 412);
  assert.equal((await stale.json()).error.code, 'modified');

  // The current mtime is accepted.
  const fresh = await fetch(contentUrl(file), {
    method: 'PUT',
    headers: { 'X-Expected-Mtime': String(statSync(file).mtimeMs) },
    body: 'v4',
  });
  assert.equal(fresh.status, 200);
});

test('DELETE /v1/files removes files, dirs (recursive), and symlinks; no guards', async () => {
  const dir = freshDir();
  const file = join(dir, 'gone.txt');
  writeFileSync(file, 'x');
  const del = await jsonOk<{ ok: boolean }>(await fetch(filesUrl(file), { method: 'DELETE' }));
  assert.deepEqual(del, { ok: true });
  assert.equal(existsSync(file), false);

  // Recursive: a populated directory.
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  writeFileSync(join(sub, 'child.txt'), 'x');
  await jsonOk(await fetch(filesUrl(sub), { method: 'DELETE' }));
  assert.equal(existsSync(sub), false);

  // A symlink is removed itself, the target survives.
  const target = join(dir, 'target.txt');
  const link = join(dir, 'link');
  writeFileSync(target, 'keep');
  symlinkSync(target, link);
  await jsonOk(await fetch(filesUrl(link), { method: 'DELETE' }));
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(target), true);

  // Deleting a missing path is a no-op success (no guards).
  const noop = await jsonOk<{ ok: boolean }>(
    await fetch(filesUrl(join(dir, 'never')), { method: 'DELETE' }),
  );
  assert.deepEqual(noop, { ok: true });

  const noPath = await fetch(`${base}/v1/files`, { method: 'DELETE' });
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error.param, 'path');
});

test('PATCH /v1/files renames/moves and returns the new entry', async () => {
  const dir = freshDir();
  const from = join(dir, 'before.txt');
  const to = join(dir, 'after.txt');
  writeFileSync(from, 'payload');

  const moved = await jsonOk<FileEntry>(
    await fetch(`${base}/v1/files`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
    }),
  );
  assert.equal(moved.path, to);
  assert.equal(moved.type, 'file');
  assert.equal(existsSync(from), false);
  assert.equal(statSync(to).size, 'payload'.length);

  const badBody = await fetch(`${base}/v1/files`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  });
  assert.equal(badBody.status, 400);
  assert.equal((await badBody.json()).error.param, 'from');

  const missingSrc = await fetch(`${base}/v1/files`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: join(dir, 'nope'), to: join(dir, 'x') }),
  });
  assert.equal(missingSrc.status, 404);
  assert.equal((await missingSrc.json()).error.code, 'file_not_found');
});

test('POST /v1/files/dir is mkdir -p and idempotent', async () => {
  const dir = freshDir();
  const target = join(dir, 'a/b/c');

  const made = await jsonOk<FileEntry>(
    await fetch(`${base}/v1/files/dir?path=${encodeURIComponent(target)}`, { method: 'POST' }),
  );
  assert.equal(made.path, target);
  assert.equal(made.type, 'directory');
  assert.equal(made.size, null);
  assert.equal(existsSync(target), true);

  // Idempotent: a second call on an existing dir succeeds.
  const again = await jsonOk<FileEntry>(
    await fetch(`${base}/v1/files/dir?path=${encodeURIComponent(target)}`, { method: 'POST' }),
  );
  assert.equal(again.type, 'directory');

  const noPath = await fetch(`${base}/v1/files/dir`, { method: 'POST' });
  assert.equal(noPath.status, 400);
  assert.equal((await noPath.json()).error.param, 'path');
});

test('GET /v1/files/archive streams a .tar.gz that unpacks to one top-level folder', async () => {
  const dir = freshDir();
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, 'nested/deep'), { recursive: true });
  writeFileSync(join(proj, 'top.txt'), 'top');
  writeFileSync(join(proj, 'nested/deep/file.txt'), 'deep');

  const res = await fetch(archiveUrl(proj));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="proj\.tar\.gz"/);

  // Round-trips: the tarball unpacks to a single `proj/` dir with the tree intact.
  const out = await extractArchive(res);
  assert.equal(readFileSync(join(out, 'proj/top.txt'), 'utf8'), 'top');
  assert.equal(readFileSync(join(out, 'proj/nested/deep/file.txt'), 'utf8'), 'deep');
});

test('GET /v1/files/archive treats a dash-led directory name as a path, not a flag', async () => {
  // Without `--` in the tar argv, `--weird` would be parsed as an option (RCE/arg
  // injection vector). With it, the dir archives normally.
  const dir = freshDir();
  const weird = join(dir, '--weird');
  mkdirSync(weird);
  writeFileSync(join(weird, 'a.txt'), 'x');

  const res = await fetch(archiveUrl(weird));
  assert.equal(res.status, 200);
  const out = await extractArchive(res);
  assert.equal(readFileSync(join(out, '--weird/a.txt'), 'utf8'), 'x');
});

test('GET /v1/files/archive stores symlinks as links, never the target bytes', async () => {
  // No `-h`/`--dereference`: a symlink must round-trip as a symlink, so the archive can't be used
  // to exfiltrate a link target's contents as inlined file bytes.
  const dir = freshDir();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  writeFileSync(join(proj, 'secret.txt'), 'classified');
  symlinkSync(join(proj, 'secret.txt'), join(proj, 'link'));

  const out = await extractArchive(await fetch(archiveUrl(proj)));
  assert.equal(lstatSync(join(out, 'proj/link')).isSymbolicLink(), true);
});

test('GET /v1/files/archive sanitizes the Content-Disposition filename', async () => {
  // A directory name is agent-controlled and Linux allows almost anything in it; quotes (which would
  // break out of the header) must be stripped, leaving a clean `*.tar.gz` download name.
  const dir = freshDir();
  const weird = join(dir, 'my "quoted" dir');
  mkdirSync(weird);
  writeFileSync(join(weird, 'a.txt'), 'x');

  const res = await fetch(archiveUrl(weird));
  assert.equal(res.status, 200);
  const cd = res.headers.get('content-disposition') ?? '';
  assert.match(cd, /filename="my quoted dir\.tar\.gz"/);
  await res.arrayBuffer(); // drain the stream so the connection closes cleanly
});

test('GET /v1/files/archive errors before streaming: 404 missing, 400 not-a-directory', async () => {
  const dir = freshDir();
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'x');

  const missing = await fetch(archiveUrl(join(dir, 'nope')));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'file_not_found');

  const notDir = await fetch(archiveUrl(file));
  assert.equal(notDir.status, 400);
  assert.equal((await notDir.json()).error.code, 'not_a_directory');
});

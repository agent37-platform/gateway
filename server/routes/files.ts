// The agent's filesystem over HTTP. The sk_live_ key is the instance root —
// there is no jail; `path` (resolved, absolute) is the identity for every call.
// The worker runs with cwd = the workspace, so files written here are the files
// the agent reads from disk, and files the agent produces are read back here.

import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import type { FileEntry, FileListResponse } from '../../shared/types.js';
import {
  fileExists,
  fileModified,
  fileNotFound,
  isRecord,
  notADirectory,
  optionalEnum,
  queryParam,
  toErrorMessage,
  validationError,
} from '../errors.js';
import { resolveHomeAwarePath, resolveWorkspaceDir } from '../paths.js';

export const filesRouter = Router();

// A directory listing returns at most this many entries; past it the list is
// clipped and `truncated` is set, so one pathological directory can't blow up a
// response (or the client rendering it).
const LIST_CAP = 1000;

const DISPOSITIONS = ['inline', 'attachment'] as const;

/** A required `path` query param: missing/empty → 400; otherwise resolved abs. */
function requirePathParam(raw: unknown, field = 'path'): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw validationError(`${field} query parameter is required.`, field);
  }
  return resolveHomeAwarePath(raw);
}

/** A required path in a JSON body (rename's from/to): missing/empty → 400. */
function requireBodyPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${field} must be a non-empty string.`, field);
  }
  return resolveHomeAwarePath(value);
}

/** An optional boolean query flag (`true`/`false`); absent → fallback. */
function boolFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw validationError(`${field} must be 'true' or 'false'.`, field);
}

/** Parse the optional X-Expected-Mtime header (epoch ms). Absent → null. */
function expectedMtime(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw.trim()) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) {
    throw validationError('X-Expected-Mtime must be epoch milliseconds.', 'X-Expected-Mtime');
  }
  return ms;
}

/** Build the FileEntry for an absolute path. `lstat` (not `stat`) so a symlink
 *  reports as a symlink rather than its target. */
async function toFileEntry(path: string): Promise<FileEntry> {
  const stats = await lstat(path);
  const type: FileEntry['type'] = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : stats.isSymbolicLink()
        ? 'symlink'
        : 'other';
  const name = basename(path);
  return {
    name,
    path,
    type,
    size: type === 'directory' ? null : stats.size,
    modified: stats.mtimeMs,
    hidden: name.startsWith('.'),
  };
}

// GET /v1/files?path=<dir> — list one directory level. `path` is optional and
// defaults to the agent workspace dir. Directories sort first, then by name.
filesRouter.get('/', async (req, res, next) => {
  try {
    const raw = req.query.path;
    const dir = typeof raw === 'string' && raw.trim() ? resolveHomeAwarePath(raw) : resolveWorkspaceDir();

    let stats;
    try {
      stats = await stat(dir);
    } catch {
      throw fileNotFound(dir);
    }
    if (!stats.isDirectory()) throw notADirectory(dir);

    const dirents = await readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    const truncated = dirents.length > LIST_CAP;
    const capped = truncated ? dirents.slice(0, LIST_CAP) : dirents;
    const entries = await Promise.all(capped.map((d) => toFileEntry(join(dir, d.name))));

    const parent = dirname(dir);
    const body: FileListResponse = {
      path: dir,
      parentPath: parent === dir ? null : parent,
      entries,
      truncated,
    };
    res.json(body);
  } catch (error) {
    next(error);
  }
});

// GET /v1/files/content?path=<file>&disposition=inline|attachment — read/preview
// /download a file. `send` (under sendFile/download) sets Content-Type from the
// extension and streams at any size; dotfiles:'allow' so agent-produced dotfiles
// download too. disposition defaults to attachment; inline lets a browser render.
filesRouter.get('/content', async (req, res, next) => {
  try {
    const path = requirePathParam(req.query.path);

    let stats;
    try {
      stats = await stat(path);
    } catch {
      throw fileNotFound(path);
    }
    if (!stats.isFile()) throw validationError(`'${path}' is not a downloadable file.`, 'path');

    const disposition = optionalEnum(queryParam(req.query.disposition), 'disposition', DISPOSITIONS, 'attachment');
    const onDone = (error: unknown) => {
      if (error) next(error);
    };
    if (disposition === 'inline') {
      res.sendFile(path, { dotfiles: 'allow', headers: { 'Content-Disposition': 'inline' } }, onDone);
    } else {
      res.download(path, basename(path), { dotfiles: 'allow' }, onDone);
    }
  } catch (error) {
    next(error);
  }
});

// PUT /v1/files/content?path=<file>&overwrite=true|false — write the raw request
// body to the path (create/overwrite/edit/upload). The parent dir is created as
// needed. The global JSON parser skips this route (see app.ts), so the body is
// the untouched byte stream — piped straight to disk at any size.
filesRouter.put('/content', async (req, res, next) => {
  try {
    const path = requirePathParam(req.query.path);
    const overwrite = boolFlag(queryParam(req.query.overwrite), 'overwrite', true);
    const expected = expectedMtime(req.headers['x-expected-mtime']);

    let existing;
    try {
      existing = await stat(path);
    } catch {
      existing = null;
    }
    if (existing) {
      if (!overwrite) throw fileExists(path);
      if (expected !== null && existing.mtimeMs !== expected) throw fileModified(path);
    }

    await mkdir(dirname(path), { recursive: true });
    await pipeline(req, createWriteStream(path));

    res.json(await toFileEntry(path));
  } catch (error) {
    next(error);
  }
});

// DELETE /v1/files?path=<path> — recursive force delete (rm -rf), no guards. A
// symlink is removed itself, not followed; deleting a missing path is a no-op.
filesRouter.delete('/', async (req, res, next) => {
  try {
    const path = requirePathParam(req.query.path);
    await rm(path, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// PATCH /v1/files  { from, to } — rename/move via fs.rename; the OS decides the
// overwrite/dir rules. Returns the FileEntry of the new path.
filesRouter.patch('/', async (req, res, next) => {
  try {
    const body: unknown = req.body;
    if (!isRecord(body)) throw validationError('Request body must be a JSON object with from and to.', 'body');
    const from = requireBodyPath(body.from, 'from');
    const to = requireBodyPath(body.to, 'to');

    try {
      await stat(from);
    } catch {
      throw fileNotFound(from);
    }
    try {
      await rename(from, to);
    } catch (error) {
      // fs.rename decides the overwrite/dir rules; surface its complaint (e.g.
      // the destination's parent doesn't exist, or a cross-device move) as a 400
      // rather than a generic 500. The source is known to exist by here.
      throw validationError(toErrorMessage(error, 'Could not move the file.'), 'to');
    }

    res.json(await toFileEntry(to));
  } catch (error) {
    next(error);
  }
});

// POST /v1/files/dir?path=<dir> — mkdir -p (recursive, idempotent).
filesRouter.post('/dir', async (req, res, next) => {
  try {
    const path = requirePathParam(req.query.path);
    await mkdir(path, { recursive: true });
    res.json(await toFileEntry(path));
  } catch (error) {
    next(error);
  }
});

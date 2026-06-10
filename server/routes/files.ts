// File attachments for chat: upload a file into the agent's workspace, and
// download a file the agent produced. Identity is the absolute path — the
// worker runs with cwd = workspace, so the agent reads attachments from disk.

import { mkdir } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { Router } from 'express';
import type { FileUploadResult } from '../../shared/types.js';
import { fileNotFound, validationError } from '../errors.js';
import { resolveHomeAwarePath, resolveUploadsDir } from '../paths.js';

export const filesRouter = Router();

// Uploads stream straight to their final location in <workspace>/uploads/
// under a collision-proof name; no staging dir or rename step needed. The dir
// is (re)created per upload: it sits in the agent-owned workspace, which the
// agent may wipe at runtime, so boot-time creation can't hold the invariant.
const upload = multer({
  // Multipart filenames arrive as UTF-8 bytes; multer's default decodes latin1.
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      const dir = resolveUploadsDir();
      mkdir(dir, { recursive: true }, (error) => callback(error, dir));
    },
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID().slice(0, 8)}-${basename(file.originalname)}`);
    },
  }),
});

// POST /v1/files — multipart upload (one file per request, field name `file`).
// Returns the absolute workspace path to attach via `files` on POST /v1/responses.
filesRouter.post('/', (req, res, next) => {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      return next(validationError(error.message, 'file'));
    }
    if (error) return next(error);
    const file = req.file;
    if (!file) {
      return next(validationError('A multipart "file" field with one file is required.', 'file'));
    }
    const result: FileUploadResult = {
      path: file.path,
      filename: basename(file.originalname),
      bytes: file.size,
    };
    res.json(result);
  });
});

// GET /v1/files/content?path=… — download a file (e.g. one the agent produced).
filesRouter.get('/content', async (req, res, next) => {
  try {
    const raw = req.query.path;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw validationError('path query parameter is required.', 'path');
    }
    const path = resolveHomeAwarePath(raw);

    let stats;
    try {
      stats = await stat(path);
    } catch {
      throw fileNotFound(path);
    }
    if (!stats.isFile()) {
      throw validationError(`'${path}' is not a downloadable file.`, 'path');
    }

    // dotfiles: 'allow' — express hides dot-basenames by default, but agents
    // legitimately produce files like .gitignore.
    res.download(path, basename(path), { dotfiles: 'allow' }, (error) => {
      if (error) next(error);
    });
  } catch (error) {
    next(error);
  }
});

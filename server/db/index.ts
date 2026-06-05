import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGatewayDbPath, ensureGatewayStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureGatewayStateDirs();

const dbPath = resolveGatewayDbPath();

const db: import('better-sqlite3').Database = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

export default db;

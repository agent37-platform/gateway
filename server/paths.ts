import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function expandHomePrefix(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function resolveHomeAwarePath(value: string): string {
  return resolve(expandHomePrefix(value));
}

/** Where Hermes itself is installed — used to locate its Python venv. */
export function resolveHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.hermes');
}

/** Root for all gateway state (SQLite db, logs, the agent's workspace). */
export function resolveGatewayHome(): string {
  const configured = process.env.AGENT37_GATEWAY_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.agent37-gateway');
}

export function resolveGatewayDataDir(): string {
  return join(resolveGatewayHome(), 'data');
}

export function resolveGatewayLogsDir(): string {
  return join(resolveGatewayHome(), 'logs');
}

/** The working directory the Hermes worker runs in (where the agent writes files). */
export function resolveWorkspaceDir(): string {
  const configured = process.env.GATEWAY_WORKSPACE_DIR?.trim();
  return resolveHomeAwarePath(configured || join(resolveGatewayHome(), 'workspace'));
}

/** Where POST /v1/files lands uploads, inside the agent's workspace. */
export function resolveUploadsDir(): string {
  return join(resolveWorkspaceDir(), 'uploads');
}

export function resolveGatewayDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return resolveHomeAwarePath(configured);
  return join(resolveGatewayDataDir(), 'gateway.db');
}

export function ensureGatewayStateDirs(): void {
  const dbPath = resolveGatewayDbPath();
  mkdirSync(resolveGatewayDataDir(), { recursive: true });
  mkdirSync(resolveGatewayLogsDir(), { recursive: true });
  mkdirSync(resolveWorkspaceDir(), { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
}

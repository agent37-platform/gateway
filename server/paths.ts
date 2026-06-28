import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** Root for all gateway state (logs, the agent's workspace). */
export function resolveGatewayHome(): string {
  const configured = process.env.AGENT37_GATEWAY_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.agent37-gateway');
}

export function resolveGatewayLogsDir(): string {
  return join(resolveGatewayHome(), 'logs');
}

/** The working directory the Hermes worker runs in (where the agent writes files). */
export function resolveWorkspaceDir(): string {
  const configured = process.env.GATEWAY_WORKSPACE_DIR?.trim();
  return resolveHomeAwarePath(configured || join(resolveGatewayHome(), 'workspace'));
}

export function ensureGatewayStateDirs(): void {
  mkdirSync(resolveGatewayLogsDir(), { recursive: true });
  mkdirSync(resolveWorkspaceDir(), { recursive: true });
}

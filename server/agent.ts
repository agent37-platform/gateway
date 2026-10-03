import { statSync } from 'node:fs';
import { join } from 'node:path';
import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';
import { ClaudeCodeAdapter } from './adapters/claude-code-adapter.js';
import { CodexAdapter } from './adapters/codex-adapter.js';
import { OpenCodeAdapter } from './adapters/opencode-adapter.js';
import { GrokAdapter } from './adapters/grok-adapter.js';
import { PiAdapter } from './adapters/pi-adapter.js';
import type { AgentAdapter } from './adapters/types.js';
import { resolveConfiguredDefaultAgent, SUPPORTED_AGENTS, type AgentType } from '../shared/types.js';
import { GatewayError, optionalEnum, queryParam, validationError } from './errors.js';
import { resolveHermesHome } from './paths.js';

export interface GatewayAdapter extends AgentAdapter {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

const registry: Record<AgentType, GatewayAdapter> = {
  hermes: new HermesWorkerAdapter(),
  openclaw: new OpenClawAdapter(),
  'claude-code': new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
  grok: new GrokAdapter(),
  pi: new PiAdapter(),
};

export function getAdapter(agent: AgentType, profile?: string | null): GatewayAdapter {
  return profile ? hermesProfileAdapter(profile) : registry[agent];
}

// ---------------------------------------------------------------------------
// Hermes profiles: one instance can hold several Hermes homes under
// ~/.hermes/profiles/<name> (each with its own SOUL, skills, memory, config and
// sessions). A request picks one with `profile`; each profile runs its own
// worker (HERMES_HOME = the profile directory), spawned on first use, stopped
// after PROFILE_IDLE_MS idle, and capped at MAX_PROFILE_WORKERS live at once
// (least recently used idle worker goes first) so RAM stays bounded.
// ---------------------------------------------------------------------------

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_IDLE_MS = 10 * 60_000;
const MAX_PROFILE_WORKERS = Number(process.env.GATEWAY_MAX_PROFILE_WORKERS) || 4;

/** Profile name -> its adapter, least recently used first. */
const profileAdapters = new Map<string, HermesWorkerAdapter>();

function profileHome(profile: string): string {
  return join(resolveHermesHome(), 'profiles', profile);
}

function hermesProfileAdapter(profile: string): HermesWorkerAdapter {
  let adapter = profileAdapters.get(profile);
  profileAdapters.delete(profile);
  adapter ??= new HermesWorkerAdapter({ hermesHome: profileHome(profile), idleMs: PROFILE_IDLE_MS });

  let live = 0;
  for (const other of profileAdapters.values()) if (other.running) live++;
  for (const other of profileAdapters.values()) {
    if (live < MAX_PROFILE_WORKERS) break;
    if (!other.running || other.busy) continue;
    void other.stop();
    live--;
  }

  profileAdapters.set(profile, adapter);
  return adapter;
}

/** The Hermes profile a request targets (`profile` in the body, `?profile=` on
 *  reads). Omitted, empty, or "default" is null: the instance's own Hermes home. */
export function profileFromRequest(raw: unknown, agent: AgentType): string | null {
  const value = queryParam(raw);
  if (value === undefined || value === null || value === 'default') return null;
  if (typeof value !== 'string' || !PROFILE_NAME.test(value)) {
    throw validationError('profile must be a Hermes profile name: lowercase letters, digits, "-" or "_".', 'profile');
  }
  if (agent !== 'hermes') throw validationError('profile is only supported with agent "hermes".', 'profile');
  if (!statSync(profileHome(value), { throwIfNoEntry: false })?.isDirectory()) {
    throw new GatewayError(404, 'profile_not_found', `No Hermes profile '${value}' on this instance.`, {
      param: 'profile',
      hint: 'Install it with `hermes profile install` or `hermes profile create`.',
    });
  }
  return value;
}

/** Stop every profile worker (shutdown and test teardown). */
export async function stopProfileAdapters(): Promise<void> {
  await Promise.all([...profileAdapters.values()].map((adapter) => adapter.stop()));
}

// The DEFAULT harness for requests that omit `agent`. GATEWAY_DEFAULT_AGENT names
// it (the OpenClaw image sets "openclaw"); a request can still target any registered
// harness explicitly — via `agent` in the POST /v1/responses body, or `?agent=`
// on GET /v1/health, /v1/models, and /v1/sessions. This is the default only, not
// a one-backend limit, though a request targeting a harness whose backend isn't
// provisioned in this container fails at request time. Resolved once at load.
export const INSTANCE_DEFAULT_AGENT: AgentType = resolveConfiguredDefaultAgent(process.env.GATEWAY_DEFAULT_AGENT);

export function getDefaultAdapter(): GatewayAdapter {
  return getAdapter(INSTANCE_DEFAULT_AGENT);
}

/** Resolve the harness a request targets from its `?agent=` query value: omitted
 *  or empty falls back to the configured default; an unknown value is a 400. */
export function agentFromQuery(raw: unknown): AgentType {
  return optionalEnum(queryParam(raw), 'agent', SUPPORTED_AGENTS, INSTANCE_DEFAULT_AGENT);
}

// Kept for test teardown: refers to the Hermes adapter.
export let adapter: GatewayAdapter = registry.hermes;

/** Replace the Hermes backend. Intended for tests. */
export function setAdapter(next: GatewayAdapter): void {
  registry.hermes = next;
  adapter = next;
}

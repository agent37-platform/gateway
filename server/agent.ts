import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';
import type { AgentAdapter } from './adapters/types.js';
import { resolveConfiguredDefaultAgent, SUPPORTED_AGENTS, type AgentType } from '../shared/types.js';
import { optionalEnum, queryParam } from './errors.js';

export interface GatewayAdapter extends AgentAdapter {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

const registry: Record<AgentType, GatewayAdapter> = {
  hermes: new HermesWorkerAdapter(),
  openclaw: new OpenClawAdapter(),
};

export function getAdapter(agent: AgentType): GatewayAdapter {
  return registry[agent];
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

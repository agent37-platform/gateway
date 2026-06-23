import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';
import type { AgentAdapter } from './adapters/types.js';
import { resolveConfiguredDefaultAgent, type AgentType } from '../shared/types.js';

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

// One gateway serves one agent backend per instance. The image sets
// GATEWAY_DEFAULT_AGENT to what it bakes (the OpenClaw image sets "openclaw"), so
// turns that omit `agent` and the agent-agnostic routes (health, models) all hit
// the right backend. Resolved once at load.
export const INSTANCE_DEFAULT_AGENT: AgentType = resolveConfiguredDefaultAgent(process.env.GATEWAY_DEFAULT_AGENT);

export function getDefaultAdapter(): GatewayAdapter {
  return getAdapter(INSTANCE_DEFAULT_AGENT);
}

// Kept for test teardown: refers to the Hermes adapter.
export let adapter: GatewayAdapter = registry.hermes;

/** Replace the Hermes backend. Intended for tests. */
export function setAdapter(next: GatewayAdapter): void {
  registry.hermes = next;
  adapter = next;
}

import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';
import type { AgentAdapter } from './adapters/types.js';
import type { AgentType } from '../shared/types.js';

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

// Kept for test teardown: refers to the Hermes adapter.
export let adapter: GatewayAdapter = registry.hermes;

/** Replace the Hermes backend. Intended for tests. */
export function setAdapter(next: GatewayAdapter): void {
  registry.hermes = next;
  adapter = next;
}

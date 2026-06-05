import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import type { AgentAdapter } from './adapters/types.js';

/** An AgentAdapter plus the optional process lifecycle the worker-backed
 *  implementation needs. */
export interface GatewayAdapter extends AgentAdapter {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// The single agent backend this build routes to. It's an exported `let` (a live
// ESM binding) so tests can swap in a deterministic fake via setAdapter() and
// every importer immediately sees it. Adding OpenClaw / Claude Code later means
// selecting an adapter here.
export let adapter: GatewayAdapter = new HermesWorkerAdapter();

/** Replace the agent backend. Intended for tests. */
export function setAdapter(next: GatewayAdapter): void {
  adapter = next;
}

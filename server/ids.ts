import { randomUUID } from 'node:crypto';

function compactUuid(): string {
  return randomUUID().replace(/-/g, '');
}

/** Mint a session id. Used as the gateway session id and passed to the session's
 *  harness backend (Hermes resolves resume/compression chains internally; OpenClaw
 *  keys its conversation history off it). */
export function newSessionId(): string {
  return compactUuid();
}

/** Mint a response id for a single turn. */
export function newResponseId(): string {
  return compactUuid();
}

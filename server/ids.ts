import { randomUUID } from 'node:crypto';

function compactUuid(): string {
  return randomUUID().replace(/-/g, '');
}

/** Mint a session id. Used verbatim as the Hermes session id (the worker
 *  resolves Hermes resume/compression chains internally). */
export function newSessionId(): string {
  return compactUuid();
}

/** Mint a response id for a single turn. */
export function newResponseId(): string {
  return compactUuid();
}

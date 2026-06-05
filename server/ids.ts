import { randomUUID } from 'node:crypto';

function compactUuid(): string {
  return randomUUID().replace(/-/g, '');
}

/** Mint a session id. Used verbatim as the Hermes session id (the worker
 *  resolves Hermes resume/compression chains internally). */
export function newSessionId(): string {
  return `sess_${compactUuid()}`;
}

/** Mint a response id for a single turn. */
export function newResponseId(): string {
  return `resp_${compactUuid()}`;
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('sess_');
}

export function isResponseId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('resp_');
}

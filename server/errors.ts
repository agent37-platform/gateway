import type { ApiError } from '../shared/types.js';

/**
 * An error that carries an HTTP status and the stable, machine-readable body
 * (see the error-code table in the README). Throw these from routes; the error
 * middleware renders them as `{ error: { code, message, param?, hint? } }`.
 */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;
  readonly hint?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { param?: string; hint?: string },
  ) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.param = options?.param;
    this.hint = options?.hint;
  }

  toBody(): { error: ApiError } {
    const error: ApiError = { code: this.code, message: this.message };
    if (this.param) error.param = this.param;
    if (this.hint) error.hint = this.hint;
    return { error };
  }
}

export function validationError(message: string, param?: string, hint?: string): GatewayError {
  return new GatewayError(400, 'validation_error', message, { param, hint });
}

/** An optional field constrained to a fixed set: absent → `fallback`, present →
 *  validated against `allowed` (throws `validationError` otherwise). */
export function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T;
export function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: null): T | null;
export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T | null,
): T | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationError(`${field} must be one of: ${allowed.join(', ')}.`, field);
  }
  return value as T;
}

/** Express parses a valueless query key (`?agent=`) as `''`; normalize that to
 *  `undefined` so it falls through to a fallback instead of failing validation. */
export function queryParam(value: unknown): unknown {
  return value === '' ? undefined : value;
}

export function responseNotFound(id: string): GatewayError {
  return new GatewayError(404, 'response_not_found', `No response with id '${id}'.`);
}

export function fileNotFound(path: string): GatewayError {
  return new GatewayError(404, 'file_not_found', `No file at '${path}'.`);
}

export function notADirectory(path: string): GatewayError {
  return new GatewayError(400, 'not_a_directory', `'${path}' is not a directory.`, { param: 'path' });
}

export function fileExists(path: string): GatewayError {
  return new GatewayError(409, 'file_exists', `A file already exists at '${path}'.`, {
    hint: 'Pass overwrite=true to replace it.',
  });
}

export function fileModified(path: string): GatewayError {
  return new GatewayError(412, 'modified', `'${path}' was modified since it was last read.`, {
    hint: 'Re-read the file to get its current X-Expected-Mtime, then retry.',
  });
}

export function sessionBusy(): GatewayError {
  return new GatewayError(409, 'session_busy', 'A response is already running on this session.', {
    hint: 'Cancel the running response, or start another session.',
  });
}

export function renameUnsupported(agent: string): GatewayError {
  return new GatewayError(405, 'rename_unsupported', `The '${agent}' harness does not support renaming sessions.`, {
    hint: 'Rename is only available on harnesses that natively store an editable session title.',
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof Error ? error.message : fallback;
}

export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The HTTP status and documented-style API code for each known worker error
 * code, defined once so the two stay in sync. The 503 group is "instance not
 * ready / Hermes unavailable". Codes absent here (auth_error, quota_exhausted,
 * model_error, invalid_provider, provider_error, worker_error, …) fall through
 * to the defaults: a 502 (the upstream agent failed) and the raw code as its
 * own API code.
 */
const WORKER_CODE_MAP: Record<string, { status: number; apiCode: string }> = {
  bad_request: { status: 400, apiCode: 'validation_error' },
  task_busy: { status: 409, apiCode: 'session_busy' },
  title_conflict: { status: 409, apiCode: 'title_conflict' },
  rate_limit: { status: 429, apiCode: 'rate_limited' },
  hermes_not_found: { status: 503, apiCode: 'hermes_not_found' },
  import_error: { status: 503, apiCode: 'import_error' },
  session_db_unavailable: { status: 503, apiCode: 'session_db_unavailable' },
  session_load_error: { status: 503, apiCode: 'session_load_error' },
};

/** Map a worker error code to the HTTP status the gateway should return. */
function httpStatusForWorkerCode(code: string | undefined): number {
  return (code ? WORKER_CODE_MAP[code]?.status : undefined) ?? 502;
}

/** Translate an internal worker code to a documented-style API code. */
function apiCodeForWorkerCode(code: string | undefined): string {
  if (!code) return 'agent_error';
  return WORKER_CODE_MAP[code]?.apiCode ?? code;
}

// Connection-level syscall codes that mean "this harness's backend isn't
// there" — whether it was never provisioned on this instance or is simply down.
// We don't distinguish the two: the caller's fix is the same either way.
const UNREACHABLE_SYSCALLS = new Set([
  'ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
]);

/** True when an error (or its `cause` — Node's fetch nests the system error
 *  there) is a connection-level failure to reach a harness backend. */
function isBackendUnreachable(error: unknown): boolean {
  for (const e of [error, (error as { cause?: unknown })?.cause]) {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === 'string' && UNREACHABLE_SYSCALLS.has(code)) return true;
  }
  return false;
}

/** The uniform "harness not available on this instance" body, or null when the
 *  error isn't a backend-unreachable failure. A turn targeting an unprovisioned
 *  (or down) harness fails here rather than leaking a raw `ECONNREFUSED`/`ENOENT`. */
function agentUnavailableError(error: unknown, agent?: string): ApiError | null {
  if (!isBackendUnreachable(error)) return null;
  const who = agent ? `The '${agent}' harness` : 'The requested harness';
  return {
    code: 'agent_unavailable',
    message: `${who} is not available on this instance.`,
    hint: `Check that ${agent ? `'${agent}'` : 'it'} is provisioned and running here, or target a harness this instance serves.`,
  };
}

/**
 * Convert an error thrown by the adapter/worker into a GatewayError suitable
 * for an HTTP response (used by non-streaming calls: models, session reads).
 * Pass `agent` so an unreachable backend names the harness it couldn't reach.
 */
export function gatewayErrorFromWorker(error: unknown, fallback = 'Agent request failed', agent?: string): GatewayError {
  if (error instanceof GatewayError) return error;
  const unavailable = agentUnavailableError(error, agent);
  if (unavailable) return new GatewayError(503, unavailable.code, unavailable.message, { hint: unavailable.hint });
  const code = errorCode(error);
  const message = toErrorMessage(error, fallback);
  const hint = error instanceof Error ? (error as Error & { hint?: string }).hint : undefined;
  return new GatewayError(httpStatusForWorkerCode(code), apiCodeForWorkerCode(code), message, {
    hint: typeof hint === 'string' ? hint : undefined,
  });
}

/** Build a `response.failed` error body from a worker `error` stream event. */
export function apiErrorFromStreamEvent(
  event: { code?: string; error?: string; hint?: string },
  fallback = 'The turn ended on an error.',
): ApiError {
  const apiError: ApiError = {
    code: apiCodeForWorkerCode(event.code),
    message: event.error ?? fallback,
  };
  if (event.hint) apiError.hint = event.hint;
  return apiError;
}

/** Build the streamed `response.failed` error body from any caught error.
 *  Pass `agent` so an unreachable backend names the harness in the failure. */
export function apiErrorFromUnknown(error: unknown, fallback = 'The turn ended on an error.', agent?: string): ApiError {
  if (error instanceof GatewayError) {
    const body = error.toBody().error;
    return body;
  }
  const unavailable = agentUnavailableError(error, agent);
  if (unavailable) return unavailable;
  const code = errorCode(error);
  const hint = error instanceof Error ? (error as Error & { hint?: string }).hint : undefined;
  const apiError: ApiError = {
    code: apiCodeForWorkerCode(code),
    message: toErrorMessage(error, fallback),
  };
  if (typeof hint === 'string') apiError.hint = hint;
  return apiError;
}

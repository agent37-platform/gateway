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

export function sessionNotFound(id: string): GatewayError {
  return new GatewayError(404, 'session_not_found', `No session with id '${id}'.`);
}

export function responseNotFound(id: string): GatewayError {
  return new GatewayError(404, 'response_not_found', `No response with id '${id}'.`);
}

export function fileNotFound(path: string): GatewayError {
  return new GatewayError(404, 'file_not_found', `No file at '${path}'.`);
}

export function sessionBusy(): GatewayError {
  return new GatewayError(409, 'session_busy', 'A response is already running on this session.', {
    hint: 'Cancel the running response, or start another session.',
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

/**
 * Convert an error thrown by the adapter/worker into a GatewayError suitable
 * for an HTTP response (used by non-streaming calls: models, session reads).
 */
export function gatewayErrorFromWorker(error: unknown, fallback = 'Agent request failed'): GatewayError {
  if (error instanceof GatewayError) return error;
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

/** Build the streamed `response.failed` error body from any caught error. */
export function apiErrorFromUnknown(error: unknown, fallback = 'The turn ended on an error.'): ApiError {
  if (error instanceof GatewayError) {
    const body = error.toBody().error;
    return body;
  }
  const code = errorCode(error);
  const hint = error instanceof Error ? (error as Error & { hint?: string }).hint : undefined;
  const apiError: ApiError = {
    code: apiCodeForWorkerCode(code),
    message: toErrorMessage(error, fallback),
  };
  if (typeof hint === 'string') apiError.hint = hint;
  return apiError;
}

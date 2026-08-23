import { randomUUID } from 'node:crypto';

// OpenClaw's real API is its WebSocket gateway RPC: session management
// (list/get/patch/delete), the LLM model catalog, and chat itself live there;
// the HTTP surface exposes almost none of it. Frames are OpenClaw's own
// envelope, not JSON-RPC: requests `{type:'req', id, method, params}`,
// responses `{type:'res', id, ok, payload, error}`, server pushes
// `{type:'event', event, payload, seq}`. The first request on a connection
// must be `connect` (protocol 4), authenticated with the shared token
// (config `gateway.auth.token`, passed as OPENCLAW_TOKEN).
//
// Two client identities, because OpenClaw's deviceless trust paths differ by
// auth mode: under `gateway.auth.mode: 'token'` (local dev) only a loopback
// CLI client (`client.id/mode = 'cli'`) keeps its requested operator scopes;
// under `mode: 'none'` (how platform instances run) a CLI identity is
// refused outright (NOT_PAIRED) and the accepted deviceless identity is the
// local backend (`gateway-client`/`backend`). We try CLI first and fall back.

const CONNECT_PROTOCOL = 4;
const REQUEST_TIMEOUT_MS = 15_000;

// The scopes our RPCs need: read (list/get/models), write (chat.send/abort,
// label patches), admin (model/thinking patches, sessions.delete).
const SCOPES = ['operator.admin', 'operator.read', 'operator.write'];

const CLIENT_IDENTITIES = [
  { id: 'cli', mode: 'cli' },
  { id: 'gateway-client', mode: 'backend' },
];

export interface OpenClawEvent {
  event: string;
  payload: Record<string, unknown>;
}

interface WireFrame {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
}

interface Pending {
  method: string;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** An RPC the OpenClaw gateway answered with `ok: false`. The backend was
 *  reachable — never mapped to `agent_unavailable`. */
export class OpenClawRpcError extends Error {
  constructor(method: string, public readonly rpcCode: string | undefined, message: string | undefined) {
    super(`OpenClaw ${method} → ${rpcCode ?? 'error'}: ${message ?? 'unknown error'}`);
  }
}

function unreachable(message: string, cause?: unknown): Error {
  // errors.ts maps syscall codes to the uniform `agent_unavailable` body; a
  // socket that won't open or dies mid-call is exactly that condition.
  const error = new Error(message, cause !== undefined ? { cause } : undefined);
  (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
  return error;
}

function parseFrame(raw: string): WireFrame | null {
  try {
    return JSON.parse(raw) as WireFrame;
  } catch {
    return null;
  }
}

export class OpenClawSocket {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: OpenClawEvent) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly wsUrl: () => string, private readonly token: () => string | undefined) {}

  /** One RPC round-trip, dialing (or re-dialing) the connection when needed. */
  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw unreachable('OpenClaw gateway connection is down');
    }
    const id = randomUUID();
    const payload = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeout = new Error(`OpenClaw ${method} timed out`);
        (timeout as NodeJS.ErrnoException).code = 'ETIMEDOUT';
        reject(timeout);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
    return payload as T;
  }

  /** Subscribe to server-push events (chat/agent streams). Returns unsubscribe. */
  onEvent(listener: (event: OpenClawEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Fires when the live connection drops, so in-flight chat streams can fail
   *  fast instead of waiting for events that will never arrive. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async ensureConnected(): Promise<void> {
    while (this.connecting) await this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = this.dial().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.failPending(unreachable('OpenClaw gateway connection closed'));
  }

  private async dial(): Promise<void> {
    let lastError: unknown;
    for (const client of CLIENT_IDENTITIES) {
      try {
        this.socket = await this.connectAttempt(client);
        return;
      } catch (error) {
        lastError = error;
        // Only a handshake refusal is worth retrying under the other
        // identity; an unreachable backend fails the same way for both.
        if (!(error instanceof OpenClawRpcError)) throw error;
      }
    }
    throw lastError;
  }

  /** Open one socket and complete the connect handshake. The socket is not
   *  published to `this.socket` until the hello lands, so a concurrent
   *  request() can never slip an RPC in front of `connect` (the server kills
   *  the whole connection for that), and a stale socket's close event can
   *  never fail RPCs riding its replacement. */
  private async connectAttempt(client: { id: string; mode: string }): Promise<WebSocket> {
    const socket = new WebSocket(this.wsUrl());

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        (event) => reject(unreachable('OpenClaw gateway is unreachable', (event as ErrorEvent).error)),
        { once: true },
      );
    });

    socket.addEventListener('message', (event) => this.onMessage(String((event as MessageEvent).data)));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(unreachable('OpenClaw gateway connection closed'));
      for (const listener of this.closeListeners) listener();
    });

    const helloId = randomUUID();
    const token = this.token();
    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(unreachable('OpenClaw connect handshake timed out')), REQUEST_TIMEOUT_MS);
      socket.addEventListener('message', (event) => {
        const frame = parseFrame(String((event as MessageEvent).data));
        if (frame?.type !== 'res' || frame.id !== helloId) return;
        clearTimeout(timer);
        if (frame.ok) resolve();
        else reject(new OpenClawRpcError('connect', frame.error?.code, frame.error?.message));
      });
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          reject(unreachable('OpenClaw gateway closed during handshake'));
        },
        { once: true },
      );
    });

    socket.send(
      JSON.stringify({
        type: 'req',
        id: helloId,
        method: 'connect',
        params: {
          minProtocol: CONNECT_PROTOCOL,
          maxProtocol: CONNECT_PROTOCOL,
          client: { ...client, version: 'agent37-gateway', platform: process.platform },
          role: 'operator',
          scopes: SCOPES,
          ...(token ? { auth: { token } } : {}),
        },
      }),
    );

    try {
      await hello;
    } catch (error) {
      socket.close();
      throw error;
    }
    return socket;
  }

  private onMessage(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;

    if (frame.type === 'res' && typeof frame.id === 'string') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(new OpenClawRpcError(entry.method, frame.error?.code, frame.error?.message));
      return;
    }

    if (frame.type === 'event' && typeof frame.event === 'string') {
      const event: OpenClawEvent = {
        event: frame.event,
        payload: (frame.payload ?? {}) as Record<string, unknown>,
      };
      for (const listener of this.eventListeners) listener(event);
    }
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

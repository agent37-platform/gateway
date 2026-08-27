// A lazily-spawned child process with reference-counted use and an idle timer.
//
// Two harnesses share it with different timeouts: Codex spawns `codex
// app-server` per call and lingers ~30s so a UI burst (list + read + turn)
// reuses one process, then falls to zero RAM; OpenCode keeps `opencode serve`
// resident and kills it after ~10 idle minutes. In both cases a turn in flight
// blocks the kill, the idle timer is `unref()`'d so it never holds the event
// loop open, and `stop()` (test teardown / SIGTERM) kills immediately.
//
// The generic parameter T is the per-spawn protocol client the adapter builds
// on the child (a JSON-RPC client for Codex, an HTTP client for OpenCode). The
// `start` closure reads the environment fresh on every spawn, so an env change
// between spawns (the integration tests flip CODEX_HOME / *_BIN) is honoured
// without any explicit snapshot bookkeeping.

export interface StartedChild<T> {
  /** The protocol client the adapter talks to. */
  value: T;
  /** Kill the child now (SIGKILL-strength; must be prompt). */
  kill: () => void;
  /** Resolves when the child has exited for any reason. */
  exited: Promise<void>;
}

export class IdleChild<T> {
  private current: StartedChild<T> | null = null;
  private starting: Promise<T> | null = null;
  private inflight = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  // Bumped on every stop(); a spawn in flight when stop() ran checks this and
  // kills the freshly-started child instead of publishing it, so teardown can't
  // be outraced by a pending start (a subsequent acquire() starts a new one).
  private generation = 0;

  constructor(private readonly opts: { idleMs: number; start: () => Promise<StartedChild<T>> }) {}

  /** Ensure a live child, cancel any pending idle-kill, and count one use. The
   *  caller MUST call `release()` once (a `try/finally`). Throws if the spawn
   *  fails (e.g. ENOENT for a missing binary) — the adapter lets that surface
   *  as `503 agent_unavailable`. */
  async acquire(): Promise<T> {
    this.clearIdle();
    this.inflight++;
    try {
      if (this.current) return this.current.value;
      if (!this.starting) {
        const startGeneration = this.generation;
        this.starting = this.opts
          .start()
          .then((started) => {
            // A stop() landed while we were spawning: don't publish a child the
            // teardown already reported killing — kill it here instead.
            if (startGeneration !== this.generation) {
              started.kill();
              throw new Error('idle child start aborted by stop()');
            }
            this.current = started;
            started.exited.then(() => {
              if (this.current === started) this.current = null;
            });
            return started.value;
          })
          .finally(() => {
            this.starting = null;
          });
      }
      return await this.starting;
    } catch (error) {
      this.inflight--;
      throw error;
    }
  }

  /** Release one use. When the last use ends, arm the idle-kill timer. */
  release(): void {
    if (this.inflight > 0) this.inflight--;
    this.armIdle();
  }

  /** Kill the child immediately and drop all in-flight accounting. A spawn in
   *  flight is invalidated (see `generation`) so it can't republish a child. */
  async stop(): Promise<void> {
    this.generation++;
    this.inflight = 0;
    this.killNow();
  }

  /** True while a child is alive. */
  get running(): boolean {
    return this.current !== null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.inflight > 0 || !this.current) return;
    this.idleTimer = setTimeout(() => {
      if (this.inflight === 0) this.killNow();
    }, this.opts.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private killNow(): void {
    this.clearIdle();
    const child = this.current;
    this.current = null;
    if (child) child.kill();
  }
}

/** A minimal push/pull async queue: producers `push`, one consumer iterates,
 *  `end()` closes the iterator. Used to hand app-server notifications to a
 *  streaming turn. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    let resolve;
    while ((resolve = this.resolvers.shift())) resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

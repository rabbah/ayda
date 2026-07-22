/**
 * A tiny FIFO counting semaphore for bounding concurrent Claude runs.
 *
 * Each agent turn spawns a `claude` child (CPU + memory); without a cap, N
 * concurrent Slack threads spawn N children and can OOM the container. Turns
 * acquire a slot before running and release it when done (or aborted); excess
 * turns queue in arrival order. Cap via MAX_CONCURRENT_RUNS (cruise-line's
 * MAX_CONCURRENT_JOBS analog; default 3).
 */

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  /** Acquire a slot, resolving immediately if free or when one frees up. */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Release a slot, handing it directly to the next waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // slot passes straight to the waiter; `available` stays 0
      return;
    }
    this.available += 1;
  }

  /** Run `fn` holding a slot, releasing even if it throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Snapshot for logging/health. */
  stats(): { available: number; queued: number } {
    return { available: this.available, queued: this.waiters.length };
  }
}

/** Process-wide run limiter. Each Claude turn holds one slot. */
export const runLimiter = new Semaphore(Number(process.env.MAX_CONCURRENT_RUNS ?? "3"));

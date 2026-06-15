/**
 * ───────────────────────────────────────────────────────────────────────────
 *  Concurrency limiter — a lightweight, dependency-free `p-limit` equivalent.
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  Caps the number of simultaneously-running async tasks to protect the
 *  YouTube API from aggressive flooding while still running requests in
 *  parallel. Vercel-safe, no external packages.
 *
 *      const limit = pLimit(5);
 *      const results = await Promise.allSettled(
 *        tasks.map((t) => limit(() => run(t)))
 *      );
 * ───────────────────────────────────────────────────────────────────────────
 */

export type LimitedFunction = <T>(fn: () => Promise<T> | T) => Promise<T>;

/**
 * Create a concurrency-limited runner.
 *
 * @param concurrency Maximum number of tasks allowed to run at once (>= 1).
 */
export function pLimit(concurrency: number): LimitedFunction {
  const max = Math.max(1, Math.trunc(concurrency) || 1);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };

  return function limited<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(task);
      next();
    });
  };
}

/** Default concurrency for the collection engine; overridable via env. */
export function resolveConcurrency(fallback = 6): number {
  const raw = process.env.YOUTUBE_FETCH_CONCURRENCY;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 50);
  return fallback;
}

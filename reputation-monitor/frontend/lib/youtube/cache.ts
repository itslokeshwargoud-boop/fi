/**
 * ───────────────────────────────────────────────────────────────────────────
 *  Lightweight in-memory TTL cache
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  A tiny, dependency-free, per-instance cache used to short-circuit repeated
 *  identical collection runs and reduce quota usage. Vercel-safe: state lives
 *  for the lifetime of the serverless instance and is bounded in size, so it
 *  never leaks memory or requires an external store.
 * ───────────────────────────────────────────────────────────────────────────
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 200) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict the oldest entry when the cache is full (simple FIFO bound).
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

/** TTL for collection results, overridable via env (seconds). Default 90s. */
export function resolveCacheTtlMs(fallbackSeconds = 90): number {
  const raw = process.env.YOUTUBE_CACHE_TTL_SECONDS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
  return fallbackSeconds * 1000;
}

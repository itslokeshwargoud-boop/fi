/**
 * ───────────────────────────────────────────────────────────────────────────
 *  YouTube API Key Pool
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  Dynamic, unlimited, multi-key management for the YouTube collection engine.
 *
 *  Keys are discovered automatically from the environment. Any variable whose
 *  name begins with `YOUTUBE_API_KEY_` is picked up, plus the legacy single
 *  `YOUTUBE_API_KEY` (kept for full backward compatibility). There is NO
 *  hard-coded key count — adding `YOUTUBE_API_KEY_1 … YOUTUBE_API_KEY_999` (or
 *  more) in Vercel is enough; no code change is required.
 *
 *      YOUTUBE_API_KEY          (legacy — still honoured)
 *      YOUTUBE_API_KEY_1
 *      YOUTUBE_API_KEY_2
 *      ...
 *      YOUTUBE_API_KEY_999
 *
 *  The pool provides rotation, automatic failover, cooldown tracking for
 *  quota-exhausted / rate-limited keys, and lazy restoration once a cooldown
 *  window elapses. State is held per serverless instance (Vercel-safe and
 *  ephemeral) — no external store required.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Prefix used for dynamic, numbered keys. */
const KEY_PREFIX = "YOUTUBE_API_KEY_";
/** Legacy single-key variable name, kept for backward compatibility. */
const LEGACY_KEY = "YOUTUBE_API_KEY";

/** Cooldown applied when a key reports quota exhaustion (HTTP 403). */
const COOLDOWN_QUOTA_MS = 15 * 60 * 1000; // 15 minutes
/** Cooldown applied when a key is rate-limited (HTTP 429). */
const COOLDOWN_RATELIMIT_MS = 60 * 1000; // 1 minute
/** Cooldown applied on transient network / unknown failures. */
const COOLDOWN_TRANSIENT_MS = 30 * 1000; // 30 seconds

export type KeyState = "available" | "cooling" | "failed";

interface ManagedKey {
  /** The raw API key value. */
  value: string;
  /** Stable identifier for logging (never logs the raw key). */
  label: string;
  state: KeyState;
  /** Epoch ms at which a cooling key becomes available again. */
  cooldownUntil: number;
  /** Number of times this key has failed since process start. */
  failures: number;
  /** Number of successful requests served by this key. */
  successes: number;
}

/** Mask a key for safe logging — only the last 4 chars are shown. */
function maskKey(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

/**
 * Discover every configured key from the environment.
 * Empty / whitespace-only values are ignored. Duplicate values are collapsed
 * so the same physical key is never tracked twice.
 */
function discoverKeys(): Array<{ name: string; value: string }> {
  const seen = new Set<string>();
  const found: Array<{ name: string; value: string }> = [];

  const consider = (name: string, raw: string | undefined) => {
    const value = (raw ?? "").trim();
    if (!value) return; // safe handling of empty keys
    if (seen.has(value)) return; // de-duplicate identical values
    seen.add(value);
    found.push({ name, value });
  };

  // Dynamic numbered keys — discovered with zero hard-coded limits.
  for (const [name, raw] of Object.entries(process.env)) {
    if (name.startsWith(KEY_PREFIX) && raw) {
      consider(name, raw);
    }
  }

  // Sort numbered keys by their numeric suffix for deterministic ordering.
  found.sort((a, b) => {
    const na = parseInt(a.name.slice(KEY_PREFIX.length), 10);
    const nb = parseInt(b.name.slice(KEY_PREFIX.length), 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.name.localeCompare(b.name);
  });

  // Legacy single key appended last so existing single-key deployments keep
  // working unchanged.
  consider(LEGACY_KEY, process.env[LEGACY_KEY]);

  return found;
}

/**
 * The API Key Pool. A long-lived singleton per serverless instance that
 * rotates across all configured keys and quarantines exhausted ones.
 */
export class ApiKeyPool {
  private keys: ManagedKey[] = [];
  private rotationIndex = 0;
  /** Snapshot of discovered env values, used to detect newly-added keys. */
  private signature = "";

  constructor() {
    this.refresh();
  }

  /**
   * Re-scan the environment and merge any newly-discovered keys. Existing key
   * state (cooldowns, failure counts) is preserved across refreshes. This lets
   * keys added in Vercel start being used automatically without a redeploy on
   * instances that re-invoke `refresh()`.
   */
  refresh(): void {
    const discovered = discoverKeys();
    const signature = discovered.map((k) => k.value).join("|");
    if (signature === this.signature && this.keys.length > 0) return;
    this.signature = signature;

    const existing = new Map(this.keys.map((k) => [k.value, k]));
    const merged: ManagedKey[] = discovered.map((d, idx) => {
      const prior = existing.get(d.value);
      if (prior) return prior;
      return {
        value: d.value,
        label: `key#${idx + 1}(${maskKey(d.value)})`,
        state: "available",
        cooldownUntil: 0,
        failures: 0,
        successes: 0,
      };
    });
    this.keys = merged;
    if (this.rotationIndex >= this.keys.length) this.rotationIndex = 0;
  }

  /** Total number of configured keys (regardless of current state). */
  get size(): number {
    return this.keys.length;
  }

  /** True when at least one key is configured. */
  hasKeys(): boolean {
    return this.keys.length > 0;
  }

  /** Lazily restore any cooling keys whose cooldown window has elapsed. */
  private reviveExpired(now = Date.now()): void {
    for (const key of this.keys) {
      if (key.state === "cooling" && now >= key.cooldownUntil) {
        key.state = "available";
        key.cooldownUntil = 0;
        // eslint-disable-next-line no-console
        console.info(`[youtube:keypool] ${key.label} cooldown elapsed → restored`);
      }
    }
  }

  /** Return every key currently eligible to serve a request. */
  getAvailableKeys(): string[] {
    this.reviveExpired();
    return this.keys.filter((k) => k.state === "available").map((k) => k.value);
  }

  /**
   * Round-robin selection of the next available key. Returns `null` when every
   * key is cooling or failed. Intelligent load balancing: rotation favours the
   * least-recently-used available key.
   */
  getNextApiKey(): string | null {
    this.reviveExpired();
    const n = this.keys.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i++) {
      const idx = (this.rotationIndex + i) % n;
      const key = this.keys[idx];
      if (key.state === "available") {
        this.rotationIndex = (idx + 1) % n;
        return key.value;
      }
    }
    return null;
  }

  private find(value: string): ManagedKey | undefined {
    return this.keys.find((k) => k.value === value);
  }

  /** Record a successful request for load-balancing telemetry. */
  markSuccess(value: string): void {
    const key = this.find(value);
    if (key) key.successes += 1;
  }

  /**
   * Mark a key as permanently failed for this instance's lifetime (e.g. an
   * invalid / revoked key). Quota and rate-limit issues should use
   * {@link markKeyAsCooling} instead so the key is retried later.
   */
  markKeyAsFailed(value: string): void {
    const key = this.find(value);
    if (!key) return;
    key.state = "failed";
    key.failures += 1;
    // eslint-disable-next-line no-console
    console.warn(`[youtube:keypool] ${key.label} marked FAILED (failures=${key.failures})`);
  }

  /**
   * Quarantine a key for a cooldown window. Used for recoverable conditions:
   * 403 quota exhaustion, 429 rate limiting, or transient network errors. The
   * key is restored automatically once the window elapses.
   */
  markKeyAsCooling(value: string, ms: number = COOLDOWN_QUOTA_MS): void {
    const key = this.find(value);
    if (!key) return;
    key.state = "cooling";
    key.cooldownUntil = Date.now() + Math.max(0, ms);
    key.failures += 1;
    // eslint-disable-next-line no-console
    console.warn(
      `[youtube:keypool] ${key.label} cooling for ${Math.round(ms / 1000)}s (failures=${key.failures})`
    );
  }

  /** Immediately return a key to the available pool. */
  restoreKey(value: string): void {
    const key = this.find(value);
    if (!key) return;
    key.state = "available";
    key.cooldownUntil = 0;
  }

  /**
   * Classify a failure and apply the appropriate cooldown. Returns the cooldown
   * milliseconds applied (0 when the key was hard-failed).
   */
  reportFailure(
    value: string,
    kind: "quota" | "ratelimit" | "transient" | "fatal"
  ): number {
    switch (kind) {
      case "quota":
        this.markKeyAsCooling(value, COOLDOWN_QUOTA_MS);
        return COOLDOWN_QUOTA_MS;
      case "ratelimit":
        this.markKeyAsCooling(value, COOLDOWN_RATELIMIT_MS);
        return COOLDOWN_RATELIMIT_MS;
      case "transient":
        this.markKeyAsCooling(value, COOLDOWN_TRANSIENT_MS);
        return COOLDOWN_TRANSIENT_MS;
      case "fatal":
        this.markKeyAsFailed(value);
        return 0;
    }
  }

  /** Snapshot of pool health for diagnostics / logging. */
  getStats() {
    this.reviveExpired();
    return {
      total: this.keys.length,
      available: this.keys.filter((k) => k.state === "available").length,
      cooling: this.keys.filter((k) => k.state === "cooling").length,
      failed: this.keys.filter((k) => k.state === "failed").length,
      keys: this.keys.map((k) => ({
        label: k.label,
        state: k.state,
        failures: k.failures,
        successes: k.successes,
      })),
    };
  }
}

/**
 * Process-wide singleton. Reused across requests within the same serverless
 * instance so cooldown state persists between invocations.
 */
let poolInstance: ApiKeyPool | null = null;

export function getApiKeyPool(): ApiKeyPool {
  if (!poolInstance) {
    poolInstance = new ApiKeyPool();
  } else {
    // Pick up keys that may have been added since the instance booted.
    poolInstance.refresh();
  }
  return poolInstance;
}

/**
 * Convenience accessor returning a single usable key (next in rotation),
 * falling back to the legacy `YOUTUBE_API_KEY`. Used by callers that only need
 * one key (e.g. comment pagination) and want multi-key resilience without the
 * full collection engine.
 */
export function getSingleApiKey(): string | null {
  const pool = getApiKeyPool();
  return pool.getNextApiKey() ?? process.env[LEGACY_KEY]?.trim() ?? null;
}

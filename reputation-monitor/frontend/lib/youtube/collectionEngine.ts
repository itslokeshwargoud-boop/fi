/**
 * ───────────────────────────────────────────────────────────────────────────
 *  Unified YouTube Collection Engine
 * ───────────────────────────────────────────────────────────────────────────
 *
 *      QUERY
 *        ↓  Query Expander          (queryExpansion.ts)
 *        ↓  API Key Manager          (apiKeyPool.ts)
 *        ↓  Parallel Fetch Engine    (Promise.allSettled + pLimit)
 *        ↓  Pagination Engine        (nextPageToken chaining)
 *        ↓  Deduplication Engine     (Map keyed by videoId)
 *        ↓  Normalization Layer      (fetchCore → YouTubeVideo)
 *        ↓  Cache                     (TtlCache)
 *        ↓  DASHBOARD
 *
 *  Two entry points:
 *    • fetchPageWithFailover() — single page, rotates across keys with retry +
 *      exponential backoff. Used by the backward-compatible `fetchYouTubeVideos`.
 *    • collectYouTubeVideos()  — the full parallel pipeline for large, unique,
 *      multi-query / multi-page collections (opt-in deep mode).
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  fetchYouTubeVideosWithKey,
  type CoreFetchResult,
  type YouTubeFetchOptions,
  type YouTubeSearchResult,
  type YouTubeVideo,
} from "./fetchCore";
import { getApiKeyPool } from "./apiKeyPool";
import { pLimit, resolveConcurrency } from "./concurrency";
import { expandQuery, type QueryExpansionOptions } from "./queryExpansion";
import { TtlCache, resolveCacheTtlMs } from "./cache";

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Max attempts (across rotating keys) for a single page fetch. */
const MAX_ATTEMPTS_PER_PAGE = 4;
/** Base delay for exponential backoff between attempts (ms). */
const BACKOFF_BASE_MS = 250;
/** Hard ceiling on pages fetched per query during deep collection. */
const DEFAULT_MAX_PAGES_PER_QUERY = 3;

/** Sleep helper. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── De-duplication ───────────────────────────────────────────────────────────

/**
 * Remove duplicate videos across keys / queries / pages using `videoId` (the
 * `id` field) as the unique identifier. First occurrence wins.
 */
export function dedupeVideos(videos: YouTubeVideo[]): YouTubeVideo[] {
  return Array.from(
    new Map(videos.map((video) => [video.id, video])).values()
  );
}

// ─── Single-page fetch with multi-key failover + backoff ──────────────────────

/**
 * Fetch ONE page for `query`, rotating across the key pool. On a recoverable
 * failure (quota/rate-limit/transient) the offending key is cooled down and the
 * next available key is tried, with exponential backoff between attempts.
 *
 * Returns the standard `YouTubeSearchResult` so it is a drop-in for the legacy
 * single-key fetch.
 */
export async function fetchPageWithFailover(
  query: string,
  options: YouTubeFetchOptions = {}
): Promise<YouTubeSearchResult> {
  const pool = getApiKeyPool();

  if (!pool.hasKeys()) {
    return { videos: [], totalResults: 0, error: "YouTube API key not configured" };
  }

  let lastError = "All YouTube API keys are exhausted";

  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PAGE; attempt++) {
    const key = pool.getNextApiKey();
    if (!key) {
      // Every key is cooling/failed right now.
      lastError = "All YouTube API keys are temporarily unavailable (quota/rate-limit)";
      break;
    }

    const result: CoreFetchResult = await fetchYouTubeVideosWithKey(query, key, options);

    if (result.ok && !result.errorKind) {
      pool.markSuccess(key);
      return {
        videos: result.videos,
        totalResults: result.totalResults,
        nextPageToken: result.nextPageToken,
      };
    }

    // Failure — classify and decide how to treat the key.
    lastError = result.error ?? lastError;
    if (result.errorKind === "fatal") {
      pool.markKeyAsFailed(key);
    } else if (result.errorKind) {
      pool.reportFailure(key, result.errorKind);
    }

    // Exponential backoff before trying the next key.
    if (attempt < MAX_ATTEMPTS_PER_PAGE - 1) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
    }
  }

  return { videos: [], totalResults: 0, error: lastError };
}

// ─── Deep collection pipeline ─────────────────────────────────────────────────

export interface CollectionOptions extends YouTubeFetchOptions {
  /** Query expansion controls. Set { maxQueries: 1 } to disable expansion. */
  expansion?: QueryExpansionOptions;
  /** Pages to fetch per expanded query (default 3). */
  maxPagesPerQuery?: number;
  /** Override max simultaneous in-flight requests. */
  concurrency?: number;
  /** Disable the result cache for this call. */
  noCache?: boolean;
  /**
   * Additional explicit queries to union into the expanded set (e.g. NC's
   * Telugu target-alias expansion). De-duplicated against normal expansion.
   */
  extraQueries?: string[];
}

export interface CollectionResult extends YouTubeSearchResult {
  /** Distinct video count after deduplication. */
  uniqueCount: number;
  /** The expanded queries that were actually issued. */
  queriesIssued: string[];
  /** Per-key / pool health snapshot for diagnostics. */
  poolStats: ReturnType<ReturnType<typeof getApiKeyPool>["getStats"]>;
  /** Non-fatal errors encountered across the parallel fan-out. */
  partialErrors: string[];
}

/** Process-wide result cache (per serverless instance). */
const collectionCache = new TtlCache<CollectionResult>(resolveCacheTtlMs());

function cacheKey(query: string, options: CollectionOptions): string {
  return JSON.stringify({
    q: query.trim().toLowerCase(),
    s: options.startDate ?? "",
    e: options.endDate ?? "",
    mq: options.expansion?.maxQueries ?? 8,
    mp: options.maxPagesPerQuery ?? DEFAULT_MAX_PAGES_PER_QUERY,
    mr: options.maxResults ?? 50,
  });
}

/**
 * Collect a large, deduplicated set of videos for `query` by expanding the
 * query, fetching multiple pages per variation in parallel across the entire
 * key pool, then deduplicating by videoId.
 *
 * Never throws. Degrades gracefully: partial failures are recorded in
 * `partialErrors` while successful results are still returned.
 */
export async function collectYouTubeVideos(
  query: string,
  options: CollectionOptions = {}
): Promise<CollectionResult> {
  const pool = getApiKeyPool();

  if (!query.trim()) {
    return {
      videos: [], totalResults: 0, uniqueCount: 0, queriesIssued: [],
      poolStats: pool.getStats(), partialErrors: [], error: "Missing query",
    };
  }

  // ── Cache ──────────────────────────────────────────────────────────────────
  const key = cacheKey(query, options);
  if (!options.noCache) {
    const hit = collectionCache.get(key);
    if (hit) return hit;
  }

  if (!pool.hasKeys()) {
    return {
      videos: [], totalResults: 0, uniqueCount: 0, queriesIssued: [],
      poolStats: pool.getStats(), partialErrors: [],
      error: "YouTube API key not configured",
    };
  }

  // ── Query expansion ─────────────────────────────────────────────────────────
  const expanded = expandQuery(query, options.expansion);
  // Union in any caller-supplied extra queries (e.g. NC's Telugu target-alias
  // expansion), de-duplicated. Additive: callers that don't pass extraQueries
  // are unaffected.
  const queries = (() => {
    if (!options.extraQueries || options.extraQueries.length === 0) return expanded;
    const seen = new Set(expanded.map((q) => q.toLowerCase()));
    const merged = [...expanded];
    for (const q of options.extraQueries) {
      const t = q.trim();
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        merged.push(t);
      }
    }
    return merged;
  })();
  const maxPages = Math.max(1, options.maxPagesPerQuery ?? DEFAULT_MAX_PAGES_PER_QUERY);
  // Concurrency scales with the number of available keys but stays bounded.
  const availableKeys = Math.max(1, pool.getAvailableKeys().length);
  const concurrency = options.concurrency ?? resolveConcurrency(Math.min(availableKeys * 2, 12));
  const limit = pLimit(concurrency);

  const baseOptions: YouTubeFetchOptions = {
    startDate: options.startDate,
    endDate: options.endDate,
    maxResults: options.maxResults,
  };

  const collected: YouTubeVideo[] = [];
  const partialErrors: string[] = [];
  let totalResults = 0;

  /**
   * Sequentially walk pages for a single query (pagination must be sequential
   * because each page depends on the previous nextPageToken), but each page
   * fetch still rotates across keys via fetchPageWithFailover. Many of these
   * per-query walkers run concurrently under the shared limiter.
   */
  const walkQuery = async (q: string): Promise<void> => {
    let pageToken: string | undefined = undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await fetchPageWithFailover(q, { ...baseOptions, pageToken });
      if (res.error) {
        partialErrors.push(`[${q}] ${res.error}`);
        break; // stop paginating this query on error; other queries continue
      }
      collected.push(...res.videos);
      totalResults = Math.max(totalResults, res.totalResults);
      if (!res.nextPageToken) break; // no further pages
      pageToken = res.nextPageToken;
    }
  };

  // ── TRUE parallel fan-out across all expanded queries ─────────────────────────
  const settled = await Promise.allSettled(
    queries.map((q) => limit(() => walkQuery(q)))
  );
  for (const s of settled) {
    if (s.status === "rejected") {
      partialErrors.push(String(s.reason));
    }
  }

  // ── Deduplication ─────────────────────────────────────────────────────────────
  const unique = dedupeVideos(collected);
  // Newest first for consistent dashboard ordering.
  unique.sort((a, b) => (b.publishedAt > a.publishedAt ? 1 : b.publishedAt < a.publishedAt ? -1 : 0));

  const result: CollectionResult = {
    videos: unique,
    totalResults: Math.max(totalResults, unique.length),
    uniqueCount: unique.length,
    queriesIssued: queries,
    poolStats: pool.getStats(),
    partialErrors,
    // Only surface a top-level error when we got nothing at all.
    error: unique.length === 0 ? (partialErrors[0] ?? "No videos found") : undefined,
  };

  if (!options.noCache && unique.length > 0) {
    collectionCache.set(key, result);
  }

  // eslint-disable-next-line no-console
  console.info(
    `[youtube:collect] q="${query}" queries=${queries.length} pages<=${maxPages} ` +
    `raw=${collected.length} unique=${unique.length} concurrency=${concurrency} ` +
    `keys(avail/total)=${result.poolStats.available}/${result.poolStats.total} ` +
    `partialErrors=${partialErrors.length}`
  );

  return result;
}

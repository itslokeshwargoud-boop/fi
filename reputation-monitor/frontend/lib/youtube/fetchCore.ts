/**
 * ───────────────────────────────────────────────────────────────────────────
 *  YouTube single-key fetch core
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  The lowest-level building block of the collection pipeline: fetch ONE page
 *  of search results for ONE query using ONE explicit API key. It never throws
 *  and classifies failures so the key pool can decide whether to cool down,
 *  retry, or hard-fail a key.
 *
 *  Both the public `/api/youtube` route (single-page, backward-compatible) and
 *  the parallel collection engine build on top of this function. Keeping it in
 *  a neutral module avoids any circular import between the route and engine.
 * ───────────────────────────────────────────────────────────────────────────
 */

import {
  validateYouTubeProofUrl,
  logProofRejection,
} from "@/lib/proofValidation";

// ─── Public shapes (re-exported from pages/api/youtube for compatibility) ────

export interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string;
  description: string;
  proofUrl: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export interface YouTubeFetchOptions {
  /** Timeline mode: ISO date (YYYY-MM-DD). When both set, overrides the 7-day window. */
  startDate?: string;
  endDate?: string;
  /** Pagination cursor from a previous response's nextPageToken. */
  pageToken?: string;
  /**
   * Results per page. Defaults to YOUTUBE_MAX_RESULTS (50).
   * Clamped to the YouTube-supported 1–50 range.
   */
  maxResults?: number;
}

export interface YouTubeSearchResult {
  videos: YouTubeVideo[];
  totalResults: number;
  error?: string;
  /** Cursor returned by the YouTube API for fetching the next page. */
  nextPageToken?: string;
}

/** How a single-key fetch failed — drives the key pool's cooldown policy. */
export type FetchErrorKind = "quota" | "ratelimit" | "transient" | "fatal" | null;

export interface CoreFetchResult extends YouTubeSearchResult {
  /** Classification of any failure; null on success. */
  errorKind: FetchErrorKind;
  /** Whether the request itself completed (HTTP layer), regardless of items. */
  ok: boolean;
}

/** YouTube Search API hard ceiling for results per page. */
export const YOUTUBE_MAX_RESULTS = 50;

/** Clamp a requested page size into the YouTube-supported 1–50 range. */
export function resolveMaxResults(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return YOUTUBE_MAX_RESULTS;
  }
  return Math.min(YOUTUBE_MAX_RESULTS, Math.max(1, Math.trunc(requested)));
}

/** Per-request timeout (ms) for YouTube API calls. */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Fetch a single page of videos for `query` using the explicit `apiKey`.
 * Never throws — failures are returned with an `errorKind` for the caller.
 */
export async function fetchYouTubeVideosWithKey(
  query: string,
  apiKey: string,
  options: YouTubeFetchOptions = {}
): Promise<CoreFetchResult> {
  if (!apiKey) {
    return { videos: [], totalResults: 0, error: "YouTube API key not configured", errorKind: "fatal", ok: false };
  }
  if (!query.trim()) {
    return { videos: [], totalResults: 0, error: "Missing query", errorKind: "fatal", ok: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { startDate, endDate } = options;
    const isTimelineMode = !!(startDate && endDate);
    const maxResults = resolveMaxResults(options.maxResults);

    const publishedAfter = isTimelineMode
      ? new Date(startDate as string).toISOString()
      : (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString(); })();

    // ── Step 1: search ──────────────────────────────────────────────────────
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("maxResults", String(maxResults));
    searchUrl.searchParams.set("order", "date");
    searchUrl.searchParams.set("publishedAfter", publishedAfter);
    if (options.pageToken) {
      searchUrl.searchParams.set("pageToken", options.pageToken);
    }
    if (isTimelineMode) {
      const before = new Date(endDate as string);
      before.setDate(before.getDate() + 1); // inclusive end date
      searchUrl.searchParams.set("publishedBefore", before.toISOString());
    }
    searchUrl.searchParams.set("key", apiKey);

    const searchRes = await fetch(searchUrl.toString(), { signal: controller.signal });
    const searchData = (await searchRes.json().catch(() => ({}))) as {
      items?: Array<{
        id: { videoId: string };
        snippet: {
          title: string;
          channelTitle: string;
          publishedAt: string;
          description: string;
          thumbnails?: { medium?: { url: string }; default?: { url: string } };
        };
      }>;
      pageInfo?: { totalResults: number };
      nextPageToken?: string;
      error?: { message: string };
    };

    if (!searchRes.ok || !Array.isArray(searchData.items)) {
      const status = searchRes.status;
      const errorKind: FetchErrorKind =
        status === 403 ? "quota" : status === 429 ? "ratelimit" : status >= 500 ? "transient" : "fatal";
      const reason =
        searchData.error?.message ??
        (status === 403
          ? "YouTube API quota exceeded or access forbidden"
          : status === 429
          ? "YouTube API rate limit reached"
          : `YouTube search failed (HTTP ${status})`);
      return { videos: [], totalResults: 0, error: reason, errorKind, ok: false };
    }

    const validItems = searchData.items.filter((item) => !!item?.id?.videoId);
    const videoIds = validItems.map((item) => item.id.videoId);
    const totalResults = searchData.pageInfo?.totalResults ?? 0;
    const nextPageToken = searchData.nextPageToken;

    if (videoIds.length === 0) {
      return { videos: [], totalResults, nextPageToken, errorKind: null, ok: true };
    }

    // ── Step 2: statistics ────────────────────────────────────────────────────
    const statsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    statsUrl.searchParams.set("part", "statistics");
    statsUrl.searchParams.set("id", videoIds.join(","));
    statsUrl.searchParams.set("key", apiKey);

    const statsRes = await fetch(statsUrl.toString(), { signal: controller.signal });
    const statsData = (await statsRes.json().catch(() => ({}))) as {
      items?: Array<{
        id: string;
        statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
      }>;
    };

    const statsMap: Record<string, { viewCount?: string; likeCount?: string; commentCount?: string }> = {};
    if (Array.isArray(statsData.items)) {
      for (const item of statsData.items) {
        if (item?.id) statsMap[item.id] = item.statistics ?? {};
      }
    }

    const videos: YouTubeVideo[] = validItems
      .map((item) => {
        const videoId = item.id.videoId;
        const stats = statsMap[videoId] ?? {};
        const snippet = item.snippet ?? ({} as typeof item.snippet);
        const proofUrl = `https://www.youtube.com/watch?v=${videoId}`;
        return {
          id: videoId,
          title: snippet?.title ?? "",
          channelTitle: snippet?.channelTitle ?? "",
          publishedAt: snippet?.publishedAt ?? "",
          thumbnailUrl:
            snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.default?.url ?? "",
          description: snippet?.description ?? "",
          proofUrl,
          viewCount: parseInt(stats.viewCount ?? "0", 10) || 0,
          likeCount: parseInt(stats.likeCount ?? "0", 10) || 0,
          commentCount: parseInt(stats.commentCount ?? "0", 10) || 0,
        };
      })
      .filter((v) => {
        const result = validateYouTubeProofUrl(v.proofUrl);
        if (result.status === "invalid") {
          logProofRejection("youtube-api", v.proofUrl, result);
          return false;
        }
        return true;
      });

    return { videos, totalResults, nextPageToken, errorKind: null, ok: true };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const message = isAbort
      ? "Request timed out"
      : err instanceof Error
      ? err.message
      : "Unknown error";
    // Aborts / network blips are transient — the key can be retried later.
    return { videos: [], totalResults: 0, error: message, errorKind: "transient", ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

import type { NextApiRequest, NextApiResponse } from "next";
import {
  fetchPageWithFailover,
  collectYouTubeVideos,
} from "@/lib/youtube/collectionEngine";

// ---------------------------------------------------------------------------
// Shared types re-exported for backward compatibility.
// Existing imports such as `import type { YouTubeVideo } from "@/pages/api/youtube"`
// continue to work unchanged — the canonical definitions now live in the
// collection engine's fetch core.
// ---------------------------------------------------------------------------
export type {
  YouTubeVideo,
  YouTubeFetchOptions,
  YouTubeSearchResult,
} from "@/lib/youtube/fetchCore";

import type {
  YouTubeVideo,
  YouTubeFetchOptions,
} from "@/lib/youtube/fetchCore";

export interface YouTubeApiResponse {
  status: "ok" | "error" | "partial_data";
  videos: YouTubeVideo[];
  totalResults: number;
  reason?: string;
  query: string;
  /** Pagination cursor for the next page of results, when available. */
  nextPageToken?: string;
}

/** Structured JSON envelope required by the dashboard contract */
interface StructuredResponse {
  success: boolean;
  data: YouTubeVideo[];
  error?: string;
  totalResults: number;
  query: string;
  /** Pagination cursor for the next page of results, when available. */
  nextPageToken?: string;
}

/** Build both legacy and structured response from shared fields */
function buildResponse(
  res: NextApiResponse,
  statusCode: number,
  fields: {
    status: YouTubeApiResponse["status"];
    videos: YouTubeVideo[];
    totalResults: number;
    reason?: string;
    query: string;
    nextPageToken?: string;
    /** Optional diagnostics for deep-collection mode (additive, non-breaking). */
    meta?: Record<string, unknown>;
  }
) {
  const legacy: YouTubeApiResponse = {
    status: fields.status,
    videos: fields.videos,
    totalResults: fields.totalResults,
    reason: fields.reason,
    query: fields.query,
    nextPageToken: fields.nextPageToken,
  };
  const structured: StructuredResponse = {
    success: fields.status !== "error",
    data: fields.videos,
    error: fields.reason,
    totalResults: fields.totalResults,
    query: fields.query,
    nextPageToken: fields.nextPageToken,
  };
  const meta = fields.meta ? { meta: fields.meta } : {};
  return res.status(statusCode).json({ ...legacy, ...structured, ...meta });
}

// ---------------------------------------------------------------------------
// Core YouTube fetch logic — shared between /api/youtube and /api/metrics
// ---------------------------------------------------------------------------

// The single-key implementation has moved to lib/youtube/fetchCore.ts and the
// multi-key rotation / failover lives in lib/youtube/collectionEngine.ts.
// `fetchYouTubeVideos` keeps its exact original signature and return shape, so
// every existing caller (metrics, mbi, talk, talk-metrics, dataIngestion) is
// unaffected — it now simply gains automatic multi-key rotation, retry, and
// graceful quota/rate-limit failover under the hood.

/**
 * Fetch one page of YouTube videos for a query string.
 *
 * Backward-compatible: same signature, same `{ videos, totalResults, error?,
 * nextPageToken? }` shape as before. Internally it rotates across every
 * configured API key (YOUTUBE_API_KEY + YOUTUBE_API_KEY_*) with retry and
 * exponential backoff, and never throws.
 */
export async function fetchYouTubeVideos(
  query: string,
  options: YouTubeFetchOptions = {}
) {
  return fetchPageWithFailover(query, options);
}

// ---------------------------------------------------------------------------
// API Route Handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const query = typeof req.query.q === "string" ? req.query.q : "";

  if (!query) {
    return buildResponse(res, 400, {
      status: "error",
      videos: [],
      totalResults: 0,
      reason: "Missing query parameter",
      query,
    });
  }

  // Optional per-page size override; resolved/clamped downstream to 1–50.
  const rawMax = typeof req.query.maxResults === "string" ? parseInt(req.query.maxResults, 10) : NaN;
  const maxResults = Number.isFinite(rawMax) ? rawMax : undefined;

  // -------------------------------------------------------------------------
  // DEEP COLLECTION MODE (opt-in, additive — default behaviour is unchanged)
  // Trigger with any of: ?deep=1 | ?mode=collect | ?expand=1
  // Returns a larger, de-duplicated, multi-key/multi-query/multi-page set in
  // the SAME response shape (videos / data arrays) the dashboard already reads.
  // -------------------------------------------------------------------------
  const deepRequested =
    req.query.deep === "1" ||
    req.query.deep === "true" ||
    req.query.expand === "1" ||
    req.query.mode === "collect";

  if (deepRequested) {
    const rawPages = typeof req.query.pages === "string" ? parseInt(req.query.pages, 10) : NaN;
    const maxPagesPerQuery = Number.isFinite(rawPages) ? Math.max(1, rawPages) : undefined;
    const rawQueries = typeof req.query.queries === "string" ? parseInt(req.query.queries, 10) : NaN;
    const maxQueries = Number.isFinite(rawQueries) ? Math.max(1, rawQueries) : undefined;

    const collection = await collectYouTubeVideos(query, {
      maxResults,
      maxPagesPerQuery,
      expansion: maxQueries ? { maxQueries } : undefined,
    });

    return buildResponse(res, 200, {
      status: collection.error ? "error" : "ok",
      videos: collection.videos,
      totalResults: collection.totalResults,
      reason: collection.error,
      query,
      meta: {
        mode: "deep",
        uniqueCount: collection.uniqueCount,
        queriesIssued: collection.queriesIssued,
        partialErrors: collection.partialErrors,
        pool: {
          total: collection.poolStats.total,
          available: collection.poolStats.available,
          cooling: collection.poolStats.cooling,
          failed: collection.poolStats.failed,
        },
      },
    });
  }

  // -------------------------------------------------------------------------
  // DEFAULT (single-page) MODE — unchanged contract, now multi-key resilient.
  // -------------------------------------------------------------------------
  const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
  const result = await fetchYouTubeVideos(query, { pageToken, maxResults });

  if (result.error) {
    return buildResponse(res, 200, {
      status: "error",
      videos: result.videos,
      totalResults: result.totalResults,
      reason: result.error,
      query,
      nextPageToken: result.nextPageToken,
    });
  }

  return buildResponse(res, 200, {
    status: "ok",
    videos: result.videos,
    totalResults: result.totalResults,
    query,
    nextPageToken: result.nextPageToken,
  });
}

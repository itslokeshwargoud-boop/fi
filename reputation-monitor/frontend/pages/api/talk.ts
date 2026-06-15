/**
 * /api/talk — Aggregates YouTube comments ("talk items") across all videos
 * for a given keyword, performs sentiment analysis, and returns paginated results.
 *
 * Query parameters:
 *   keyword   (required)  — search keyword to find videos
 *   page      (optional)  — page number, default 1
 *   limit     (optional)  — items per page, default 50
 *   sentiment (optional)  — filter: "positive" | "negative" | "neutral"
 *   search    (optional)  — text search within talk items
 *   sort      (optional)  — "newest" (default) | "oldest"
 *   startDate (optional)  — YYYY-MM-DD; activates Timeline Mode when paired with endDate
 *   endDate   (optional)  — YYYY-MM-DD; activates Timeline Mode when paired with startDate
 *
 * Response envelope:
 *   { success, data: { items, total, page, limit, totalPages, sentimentCounts, totalTalkItems }, error? }
 *
 * ── Timeline Mode behaviour ──────────────────────────────────────────────
 * When startDate + endDate are both supplied:
 *  1. YouTube videos are searched using publishedAfter/publishedBefore so we
 *     only retrieve videos published inside the window.
 *  2. Comments are fetched for those videos. Because YouTube returns comments
 *     newest-first we paginate until we either reach comments older than
 *     startDate (early-exit) or exhaust all pages.
 *  3. Comments are filtered server-side by their own publishedAt timestamp —
 *     NOT by the video's publishedAt date.
 *  4. Results are written to the local SQLite cache and served from there.
 * ────────────────────────────────────────────────────────────────────────
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { fetchYouTubeVideos } from "./youtube";
import type { YouTubeVideo } from "./youtube";
import { getSingleApiKey } from "@/lib/youtube/apiKeyPool";
import { collectYouTubeVideos } from "@/lib/youtube/collectionEngine";
import {
  getDb,
  upsertTalkItems,
  queryTalkItems,
  getVideoFetchStatus,
  upsertVideoFetchStatus,
  getTotalCachedItems,
  getLastFetchTime,
  setLastFetchTime,
  resetVideoFetchStatus,
  type TalkItemRow,
  type TalkQueryResult,
} from "@/lib/db/talkCache";
import { analyzeSentimentBatch, type SentimentLabel } from "@/lib/sentiment";
import {
  validateYouTubeCommentProofUrl,
  logProofRejection,
} from "@/lib/proofValidation";
import { scoreBotBatch, type BotLabel } from "@/lib/botDetection";

// ---------------------------------------------------------------------------
// YouTube Comment Thread fetching
// ---------------------------------------------------------------------------

interface YtComment {
  commentId: string;
  text: string;
  author: string;
  authorChannelId: string;  // UC... stable unique ID — used as dedup key for influencers
  authorChannelUrl: string;
  publishedAt: string;
  videoId: string;
}

interface CommentThreadPage {
  comments: YtComment[];
  nextPageToken: string | null;
}

/**
 * Fetch one page of comment threads for a video.
 * Uses the YouTube Data API v3 commentThreads.list endpoint.
 */
async function fetchCommentPage(
  videoId: string,
  apiKey: string,
  pageToken?: string | null
): Promise<CommentThreadPage> {
  const url = new URL("https://www.googleapis.com/youtube/v3/commentThreads");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("textFormat", "plainText");
  url.searchParams.set("order", "time"); // newest comments first — allows early-exit
  url.searchParams.set("key", apiKey);
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg =
        (errData as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      console.warn(`Comment fetch failed for ${videoId}: ${msg}`);
      return { comments: [], nextPageToken: null };
    }

    const data = (await res.json()) as {
      items?: Array<{
        snippet: {
          topLevelComment: {
            id: string;
            snippet: {
              textDisplay: string;
              authorDisplayName: string;
              authorChannelId?: { value: string }; // stable unique channel ID
              authorChannelUrl?: string;
              publishedAt: string;
            };
          };
        };
      }>;
      nextPageToken?: string;
    };

    const comments: YtComment[] = (data.items ?? []).map((item) => ({
      commentId: item.snippet.topLevelComment.id,
      text: item.snippet.topLevelComment.snippet.textDisplay,
      author: item.snippet.topLevelComment.snippet.authorDisplayName ?? "",
      authorChannelId: item.snippet.topLevelComment.snippet.authorChannelId?.value ?? "",
      authorChannelUrl: item.snippet.topLevelComment.snippet.authorChannelUrl ?? "",
      // ✅ FIX: use the comment's own publishedAt — NOT the video's publishedAt
      publishedAt: item.snippet.topLevelComment.snippet.publishedAt ?? "",
      videoId,
    }));

    return {
      comments,
      nextPageToken: data.nextPageToken ?? null,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`Comment fetch error for ${videoId}:`, err instanceof Error ? err.message : err);
    return { comments: [], nextPageToken: null };
  }
}

// ---------------------------------------------------------------------------
// Core aggregation logic
// ---------------------------------------------------------------------------

/**
 * Resolve the SAME set of videos the Feed/metrics dashboard uses, so the Talk
 * comment universe matches Feed exactly. Feed renders the deep multi-key
 * collection (query expansion + pagination + dedup); Talk must ingest comments
 * from that identical video set or the two counts can never reconcile.
 *
 * Falls back to the single-page fetch only if deep collection yields nothing.
 */
async function resolveVideosForKeyword(
  keyword: string,
  timelineWindow?: { startDate?: string; endDate?: string }
): Promise<{ videos: YouTubeVideo[]; error?: string }> {
  const collection = await collectYouTubeVideos(keyword, {
    startDate: timelineWindow?.startDate,
    endDate: timelineWindow?.endDate,
  });

  if (collection.videos.length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[api/talk] video set (deep) keyword="${keyword}" videos=${collection.videos.length} ` +
      `queries=${collection.queriesIssued.length} keys(avail/total)=` +
      `${collection.poolStats.available}/${collection.poolStats.total}`
    );
    return { videos: collection.videos };
  }

  // Fallback: legacy single-page (e.g. deep collector returned an error).
  const single = await fetchYouTubeVideos(keyword, {
    startDate: timelineWindow?.startDate,
    endDate: timelineWindow?.endDate,
  });
  // eslint-disable-next-line no-console
  console.info(
    `[api/talk] video set (single fallback) keyword="${keyword}" videos=${single.videos.length}`
  );
  return { videos: single.videos, error: collection.error ?? single.error };
}

/**
 * Max comment pages to fetch per video in real-time mode.
 * 100 per page × 5 = up to 500 comments per video.
 */
const MAX_PAGES_REALTIME = 5;

/**
 * Max comment pages per video in timeline mode.
 * Higher because historical data requires deeper pagination.
 * 100 per page × 50 = up to 5,000 comments per video.
 * Early-exit on publishedAt < startDate keeps this fast in practice.
 */
const MAX_PAGES_TIMELINE = 50;

/** Max total talk items to fetch across all videos in one request cycle */
const MAX_ITEMS_TARGET = 6000;

/** Batch size for sentiment analysis */
const SENTIMENT_BATCH_SIZE = 32;

/**
 * Fetch and cache talk items for all videos matching the keyword.
 *
 * In timeline mode:
 *  - paginates deeper (up to MAX_PAGES_TIMELINE pages per video)
 *  - stops pagination early when comment.publishedAt falls before startDate
 *    (comments are returned newest-first, so once we pass the window we're done)
 *  - only retains comments whose publishedAt falls within [startDate, endDate]
 *
 * In real-time mode:
 *  - skips videos that have already been fully fetched
 *  - caps at MAX_PAGES_REALTIME pages per video
 */
async function aggregateTalkItems(
  keyword: string,
  videos: YouTubeVideo[],
  timelineWindow?: { startDate: string; endDate: string }
): Promise<{
  fetched: number;
  stored: number;
  classified: number;
  droppedProof: number;
  errors: string[];
}> {
  // Multi-key resilient: pull the next available key from the pool, falling
  // back to the legacy YOUTUBE_API_KEY when no numbered keys are configured.
  const apiKey = getSingleApiKey();
  if (!apiKey) {
    return { fetched: 0, stored: 0, classified: 0, droppedProof: 0, errors: ["YouTube API key not configured"] };
  }

  const isTimeline = !!timelineWindow;
  const maxPages = isTimeline ? MAX_PAGES_TIMELINE : MAX_PAGES_REALTIME;

  // Pre-compute boundary timestamps for fast comparison in the inner loop
  const windowStart = isTimeline ? new Date(timelineWindow!.startDate).getTime() : 0;
  // End of the endDate day (inclusive)
  const windowEnd = isTimeline
    ? new Date(timelineWindow!.endDate + "T23:59:59Z").getTime()
    : Infinity;

  let totalFetched = getTotalCachedItems(keyword);
  const errors: string[] = [];
  const newComments: Array<YtComment & { videoTitle: string; channelTitle: string }> = [];

  for (const video of videos) {
    if (totalFetched >= MAX_ITEMS_TARGET) break;

    // In timeline mode always re-fetch (we need historical pagination).
    // In real-time mode skip already fully-fetched videos.
    const status = isTimeline ? null : getVideoFetchStatus(video.id, keyword);
    if (!isTimeline && status?.fullyFetched) continue;

    let pageToken: string | null = isTimeline ? null : (status?.nextPageToken ?? null);
    let pagesFetched = (!isTimeline && status) ? Math.ceil(status.totalFetched / 100) : 0;
    let videoItemsFetched = (!isTimeline && status) ? status.totalFetched : 0;
    let reachedBeforeWindow = false;

    while (pagesFetched < maxPages && totalFetched < MAX_ITEMS_TARGET && !reachedBeforeWindow) {
      const page = await fetchCommentPage(video.id, apiKey, pageToken);

      if (page.comments.length === 0) {
        // No more comments or error
        if (!isTimeline) {
          upsertVideoFetchStatus({
            videoId: video.id,
            keyword,
            nextPageToken: null,
            totalFetched: videoItemsFetched,
            lastFetchedAt: new Date().toISOString(),
            fullyFetched: 1,
          });
        }
        break;
      }

      for (const c of page.comments) {
        if (!c.publishedAt) continue;

        // ✅ FIX BUG 1: filter on the COMMENT's publishedAt, not the video's date
        const commentTime = new Date(c.publishedAt).getTime();

        if (isTimeline) {
          // Comments arrive newest-first. Once we pass below the window, all
          // subsequent comments are even older — safe to stop this video.
          if (commentTime < windowStart) {
            reachedBeforeWindow = true;
            break;
          }
          // Skip comments that are newer than the window's end date
          // (can happen if the video was published before endDate but got
          // new comments after it)
          if (commentTime > windowEnd) continue;
        }

        newComments.push({
          ...c,
          videoTitle: video.title,
          channelTitle: video.channelTitle,
        });
      }

      videoItemsFetched += page.comments.length;
      totalFetched += page.comments.length;
      pagesFetched++;
      pageToken = page.nextPageToken;

      if (!pageToken) {
        if (!isTimeline) {
          upsertVideoFetchStatus({
            videoId: video.id,
            keyword,
            nextPageToken: null,
            totalFetched: videoItemsFetched,
            lastFetchedAt: new Date().toISOString(),
            fullyFetched: 1,
          });
        }
        break;
      }

      // Save pagination progress for real-time mode only
      if (!isTimeline) {
        upsertVideoFetchStatus({
          videoId: video.id,
          keyword,
          nextPageToken: pageToken,
          totalFetched: videoItemsFetched,
          lastFetchedAt: new Date().toISOString(),
          fullyFetched: 0,
        });
      }
    }
  }

  // Run sentiment analysis on new comments in batches, then compute bot scores
  let classified = 0;
  let droppedProof = 0;
  if (newComments.length > 0) {
    const talkRows: TalkItemRow[] = [];

    for (let i = 0; i < newComments.length; i += SENTIMENT_BATCH_SIZE) {
      const batch = newComments.slice(i, i + SENTIMENT_BATCH_SIZE);
      const texts = batch.map((c) => c.text);

      let sentiments: SentimentLabel[];
      try {
        sentiments = await analyzeSentimentBatch(texts);
      } catch {
        sentiments = texts.map(() => "neutral" as SentimentLabel);
      }
      // Every comment in the batch receives a sentiment label (errors fall back
      // to "neutral"), so classification covers 100% of fetched comments.
      classified += batch.length;

      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const proofUrl = `https://www.youtube.com/watch?v=${c.videoId}&lc=${c.commentId}`;

        const proofResult = validateYouTubeCommentProofUrl(proofUrl);
        if (proofResult.status === "invalid") {
          logProofRejection("talk-api-ingest", proofUrl, proofResult);
          droppedProof++;
          continue;
        }

        talkRows.push({
          commentId: c.commentId,
          videoId: c.videoId,
          text: c.text,
          author: c.author,
          authorChannelId: c.authorChannelId ?? "",
          authorChannelUrl: c.authorChannelUrl,
          publishedAt: c.publishedAt,
          videoTitle: c.videoTitle,
          channelTitle: c.channelTitle,
          sentiment: sentiments[j],
          proofUrl,
          keyword,
          fetchedAt: new Date().toISOString(),
          botScore: 0,
          botLabel: "human",
          botReasons: "[]",
        });
      }
    }

    // Compute bot detection across the entire batch
    if (talkRows.length > 0) {
      const botInputs = talkRows.map((r) => ({
        commentId: r.commentId,
        videoId: r.videoId,
        text: r.text,
        publishedAt: r.publishedAt,
        keyword: r.keyword,
      }));
      const botResults = scoreBotBatch(botInputs);
      for (let i = 0; i < talkRows.length; i++) {
        talkRows[i].botScore = botResults[i].botScore;
        talkRows[i].botLabel = botResults[i].botLabel;
        talkRows[i].botReasons = JSON.stringify(botResults[i].botReasons);
      }
    }

    upsertTalkItems(talkRows);

    // eslint-disable-next-line no-console
    console.info(
      `[api/talk] ingest keyword="${keyword}" fetched=${newComments.length} ` +
      `classified=${classified} stored=${talkRows.length} droppedProof=${droppedProof} ` +
      `videos=${videos.length}`
    );

    return {
      fetched: newComments.length,
      stored: talkRows.length,
      classified,
      droppedProof,
      errors,
    };
  }

  return { fetched: newComments.length, stored: 0, classified, droppedProof, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely parse botReasons JSON string into a string array */
function parseBotReasons(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// API Response types
// ---------------------------------------------------------------------------

export interface TalkItem {
  commentId: string;
  text: string;
  author: string;
  publishedAt: string;
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  sentiment: SentimentLabel;
  proofUrl: string;
  botScore: number;
  botLabel: BotLabel;
  botReasons: string[];
}

export interface TalkApiResponse {
  success: boolean;
  data: {
    items: TalkItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    sentimentCounts: { positive: number; negative: number; neutral: number };
    totalTalkItems: number;
  };
  error?: string;
  /**
   * Optional, additive pipeline diagnostics. Lets the UI / tests assert that
   * the sentiment breakdown reconciles with the displayed total and shows how
   * many comments flowed through each stage. Existing consumers ignore it.
   */
  debug?: {
    videosConsidered: number;
    fetched: number;
    classified: number;
    stored: number;
    droppedProof: number;
    totalCached: number;
    sentimentSum: number;
    /** True when sentiment counts sum exactly to the unfiltered total. */
    reconciles: boolean;
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TalkApiResponse>
) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      data: {
        items: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
        sentimentCounts: { positive: 0, negative: 0, neutral: 0 },
        totalTalkItems: 0,
      },
      error: "Method not allowed",
    });
  }

  const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim() : "";
  if (!keyword) {
    return res.status(400).json({
      success: false,
      data: {
        items: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
        sentimentCounts: { positive: 0, negative: 0, neutral: 0 },
        totalTalkItems: 0,
      },
      error: "Missing keyword parameter",
    });
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const sentiment = (["positive", "negative", "neutral"] as const).includes(
    req.query.sentiment as "positive" | "negative" | "neutral"
  )
    ? (req.query.sentiment as SentimentLabel)
    : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
  const sort = req.query.sort === "oldest" ? "oldest" : "newest";

  // Timeline mode — both must be valid YYYY-MM-DD strings
  const rawStart = typeof req.query.startDate === "string" ? req.query.startDate.trim() : "";
  const rawEnd = typeof req.query.endDate === "string" ? req.query.endDate.trim() : "";
  const dateRx = /^\d{4}-\d{2}-\d{2}$/;
  const isTimelineMode = dateRx.test(rawStart) && dateRx.test(rawEnd);
  if (isTimelineMode && rawStart > rawEnd) {
    return res.status(400).json({
      success: false,
      data: { items: [], total: 0, page: 1, limit: 50, totalPages: 0, sentimentCounts: { positive: 0, negative: 0, neutral: 0 }, totalTalkItems: 0 },
      error: "startDate must be before or equal to endDate",
    });
  }
  const startDate = isTimelineMode ? rawStart : undefined;
  const endDate = isTimelineMode ? rawEnd : undefined;

  const BOT_LABELS = ["human", "suspicious", "bot"] as const;
  type BotLabelFilter = (typeof BOT_LABELS)[number];
  const botParam = req.query.bot as string | undefined;
  const bot: BotLabelFilter | undefined =
    botParam && BOT_LABELS.includes(botParam as BotLabelFilter)
      ? (botParam as BotLabelFilter)
      : undefined;

  // Cache headers
  res.setHeader("Cache-Control", "no-store, must-revalidate");

  try {
    // Ensure DB is initialized
    getDb();

    const cachedCount = getTotalCachedItems(keyword);
    const lastFetch = getLastFetchTime(keyword);
    const REFRESH_TTL_MS = 60_000;
    const staleSinceMs = lastFetch ? Date.now() - new Date(lastFetch).getTime() : Infinity;

    // Accumulates the most recent ingestion pass for the debug block.
    let aggAccum: { videosConsidered: number; fetched: number; classified: number; stored: number; droppedProof: number } | null = null;

    if (isTimelineMode) {
      // ── TIMELINE MODE ────────────────────────────────────────────────────
      // Always fetch videos scoped to the requested date window, then paginate
      // their comments until we've passed the window start (early-exit) or
      // exhausted all pages. This is the only way to get historical comments
      // because YouTube only returns the LATEST comments on page 1.

      const videoResult = await resolveVideosForKeyword(keyword, {
        startDate,   // ✅ pass the timeline window to the (deep) video search
        endDate,
      });

      if (videoResult.videos.length > 0) {
        // ✅ pass timelineWindow so aggregateTalkItems uses deeper
        // pagination + early-exit on comment.publishedAt < startDate
        const aggResult = await aggregateTalkItems(keyword, videoResult.videos, {
          startDate: startDate!,
          endDate: endDate!,
        });
        aggAccum = {
          videosConsidered: videoResult.videos.length,
          fetched: aggResult.fetched,
          classified: aggResult.classified,
          stored: aggResult.stored,
          droppedProof: aggResult.droppedProof,
        };
        if (aggResult.errors.length > 0) {
          console.warn("Talk timeline aggregation warnings:", aggResult.errors);
        }
      } else if (videoResult.error) {
        console.warn("Talk timeline video fetch failed:", videoResult.error);
      }
    } else {
      // ── REAL-TIME MODE ───────────────────────────────────────────────────
      // Refresh if no cached data yet, or last fetch was >60s ago.
      const needsRefresh = cachedCount === 0 || staleSinceMs > REFRESH_TTL_MS;

      if (needsRefresh) {
        const videoResult = await resolveVideosForKeyword(keyword);

        if (videoResult.error && videoResult.videos.length === 0) {
          if (cachedCount === 0) {
            return res.status(200).json({
              success: false,
              data: {
                items: [],
                total: 0,
                page,
                limit,
                totalPages: 0,
                sentimentCounts: { positive: 0, negative: 0, neutral: 0 },
                totalTalkItems: 0,
              },
              error: videoResult.error,
            });
          }
          console.warn("Talk refresh fetch failed, serving cached data:", videoResult.error);
        } else {
          // Reset fully-fetched flags so aggregateTalkItems picks up new comments
          resetVideoFetchStatus(keyword);
          const aggResult = await aggregateTalkItems(keyword, videoResult.videos);
          aggAccum = {
            videosConsidered: videoResult.videos.length,
            fetched: aggResult.fetched,
            classified: aggResult.classified,
            stored: aggResult.stored,
            droppedProof: aggResult.droppedProof,
          };
          if (aggResult.errors.length > 0) {
            console.warn("Talk aggregation warnings:", aggResult.errors);
          }
          setLastFetchTime(keyword);
        }
      }
    }

    // Query cached items with filters
    // ✅ In timeline mode startDate/endDate are passed here for the SQL WHERE clause
    //    which filters on comment.publishedAt (stored in the DB as the comment's own timestamp)
    const result: TalkQueryResult = queryTalkItems({
      keyword,
      sentiment,
      bot,
      search,
      sort: sort as "newest" | "oldest",
      page,
      limit,
      startDate,
      endDate,
    });

    const items: TalkItem[] = result.items
      .filter((item) => !!item.proofUrl)
      .map((item) => ({
        commentId: item.commentId,
        text: item.text,
        author: item.author,
        publishedAt: item.publishedAt,
        videoId: item.videoId,
        videoTitle: item.videoTitle,
        channelTitle: item.channelTitle,
        sentiment: item.sentiment,
        proofUrl: item.proofUrl,
        botScore: item.botScore ?? 0,
        botLabel: (item.botLabel ?? "human") as BotLabel,
        botReasons: parseBotReasons(item.botReasons),
      }));

    const totalCached = getTotalCachedItems(keyword);
    const sentimentSum =
      result.sentimentCounts.positive +
      result.sentimentCounts.negative +
      result.sentimentCounts.neutral;
    // Validation: with no row-limiting filters applied, the sentiment breakdown
    // must sum exactly to the displayed total. (When sentiment/bot/search
    // filters narrow the rows, `total` is the filtered subset while the
    // breakdown stays full-distribution by design — so only assert when
    // unfiltered.)
    const unfiltered = !sentiment && !bot && !search;
    const reconciles = !unfiltered || sentimentSum === result.total;
    if (unfiltered && !reconciles) {
      console.warn(
        `[api/talk] RECONCILE MISMATCH keyword="${keyword}" ` +
        `sentimentSum=${sentimentSum} total=${result.total}`
      );
    }
    // eslint-disable-next-line no-console
    console.info(
      `[api/talk] response keyword="${keyword}" total=${result.total} ` +
      `totalCached=${totalCached} sentimentSum=${sentimentSum} ` +
      `displayed=${items.length} reconciles=${reconciles}`
    );

    return res.status(200).json({
      success: true,
      data: {
        items,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        sentimentCounts: result.sentimentCounts,
        totalTalkItems: totalCached,
      },
      debug: {
        videosConsidered: aggAccum?.videosConsidered ?? 0,
        fetched: aggAccum?.fetched ?? 0,
        classified: aggAccum?.classified ?? 0,
        stored: aggAccum?.stored ?? 0,
        droppedProof: aggAccum?.droppedProof ?? 0,
        totalCached,
        sentimentSum,
        reconciles,
      },
    });
  } catch (err) {
    console.error("Talk API error:", err);
    return res.status(500).json({
      success: false,
      data: {
        items: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
        sentimentCounts: { positive: 0, negative: 0, neutral: 0 },
        totalTalkItems: 0,
      },
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
}

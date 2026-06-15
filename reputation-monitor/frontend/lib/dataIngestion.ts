/**
 * DATA INGESTION LAYER
 *
 * Centralizes access to the two real-time data sources (Talk + Feed)
 * and normalizes the data into a common format consumable by the
 * Reputation Engine processing layer.
 *
 * Talk source → YouTube comments (cached in SQLite with sentiment + bot scores)
 * Feed source → YouTube videos with engagement metrics
 */

import {
  getDb,
  getTotalCachedItems,
  type TalkItemRow,
} from "@/lib/db/talkCache";
import { fetchYouTubeVideos, type YouTubeVideo, type YouTubeFetchOptions } from "@/pages/api/youtube";
import { collectYouTubeVideos } from "@/lib/youtube/collectionEngine";
import { filterByWindow } from "@/lib/nc/dateWindow";
import { expandTarget } from "@/lib/nc/targetExpansion";
import { ANIL_DISPLAY_NAME } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Unified data types
// ---------------------------------------------------------------------------

export interface SentimentCounts {
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

/** A timestamped spoken segment from a video transcript (captions or Whisper). */
export interface TranscriptSegment {
  /** Start offset in seconds (for clickable deep-links). */
  start: number;
  /** Normalized spoken text for this segment. */
  text: string;
}

export interface BotCounts {
  human: number;
  suspicious: number;
  bot: number;
  total: number;
}

export interface ChannelStats {
  channelTitle: string;
  videoCount: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  commentSentiment: SentimentCounts;
}

/** Date range filter — both fields must be present to activate filtering. */
export interface DateFilter {
  startDate?: string; // YYYY-MM-DD (inclusive)
  endDate?: string;   // YYYY-MM-DD (inclusive, extended to end-of-day T23:59:59Z)
}

export interface IngestedData {
  keyword: string;
  /** YouTube videos with engagement stats */
  videos: YouTubeVideo[];
  /** All cached talk items for the keyword */
  talkItems: TalkItemRow[];
  /** Aggregated sentiment counts */
  sentimentCounts: SentimentCounts;
  /** Aggregated bot detection counts */
  botCounts: BotCounts;
  /** Per-channel aggregated stats */
  channelStats: ChannelStats[];
  /** Overall engagement metrics */
  engagement: {
    totalVideos: number;
    totalViews: number;
    totalLikes: number;
    totalComments: number;
    avgViewsPerVideo: number;
    engagementRate: number;
  };
  /** Timestamp of data ingestion */
  ingestedAt: string;
  /**
   * Optional per-video transcript segments (Issue 3). Keyed by video id.
   * Populated when a transcript source is available (YouTube captions, or the
   * backend caption→Whisper pipeline). Absent/empty → evidence falls back to
   * titles + comments, exactly as before.
   */
  transcripts?: Record<string, TranscriptSegment[]>;
  /**
   * Ingestion / processing metrics so analytics cards reflect the FULL feed
   * volume (not a sampled subset). Populated by deep (NC-scale) ingestion.
   */
  ingestionMeta?: {
    mode: "single_page" | "deep";
    collected: number;       // unique videos returned by the collector
    inWindow: number;        // videos kept after date filtering
    skippedOutOfWindow: number;
    queriesIssued?: string[];
    partialErrors?: string[];
    dateWindow?: { startDate: string; endDate: string } | null;
  };
}

// ---------------------------------------------------------------------------
// Talk data ingestion (from SQLite cache)
// ---------------------------------------------------------------------------

function ingestTalkData(keyword: string, dateFilter?: DateFilter): {
  items: TalkItemRow[];
  sentimentCounts: SentimentCounts;
  botCounts: BotCounts;
} {
  const db = getDb();

  const total = getTotalCachedItems(keyword);
  if (total === 0) {
    return {
      items: [],
      sentimentCounts: { positive: 0, negative: 0, neutral: 0, total: 0 },
      botCounts: { human: 0, suspicious: 0, bot: 0, total: 0 },
    };
  }

  // Build optional date clause — both dates must be present to filter.
  // endDate is extended to T23:59:59Z so the full end day is inclusive.
  const hasDateFilter = !!(dateFilter?.startDate && dateFilter?.endDate);
  const dateClause = hasDateFilter
    ? " AND publishedAt >= ? AND publishedAt <= ?"
    : "";
  // Bind params: keyword always first; date params appended when filtering
  const dateParams = hasDateFilter
    ? [dateFilter!.startDate!, dateFilter!.endDate! + "T23:59:59Z"]
    : [];

  // Fetch talk items — filtered by date when in timeline mode
  const items = db
    .prepare(
      `SELECT commentId, videoId, text, author, publishedAt, videoTitle, channelTitle,
              sentiment, proofUrl, keyword, fetchedAt, botScore, botLabel, botReasons,
              authorChannelId, authorChannelUrl
       FROM talk_items WHERE keyword = ?${dateClause} ORDER BY publishedAt DESC`
    )
    .all(keyword, ...dateParams) as TalkItemRow[];

  // Aggregate sentiment within the same date window
  const sentimentRows = db
    .prepare(
      `SELECT sentiment, COUNT(*) AS cnt FROM talk_items
       WHERE keyword = ?${dateClause} GROUP BY sentiment`
    )
    .all(keyword, ...dateParams) as Array<{ sentiment: string; cnt: number }>;

  const sentimentCounts: SentimentCounts = { positive: 0, negative: 0, neutral: 0, total: items.length };
  for (const row of sentimentRows) {
    if (row.sentiment === "positive") sentimentCounts.positive = row.cnt;
    else if (row.sentiment === "negative") sentimentCounts.negative = row.cnt;
    else if (row.sentiment === "neutral") sentimentCounts.neutral = row.cnt;
  }

  // Aggregate bot counts within the same date window
  const botRows = db
    .prepare(
      `SELECT botLabel, COUNT(*) AS cnt FROM talk_items
       WHERE keyword = ?${dateClause} GROUP BY botLabel`
    )
    .all(keyword, ...dateParams) as Array<{ botLabel: string; cnt: number }>;

  const botCounts: BotCounts = { human: 0, suspicious: 0, bot: 0, total: items.length };
  for (const row of botRows) {
    if (row.botLabel === "human") botCounts.human = row.cnt;
    else if (row.botLabel === "suspicious") botCounts.suspicious = row.cnt;
    else if (row.botLabel === "bot") botCounts.bot = row.cnt;
  }

  return { items, sentimentCounts, botCounts };
}

// ---------------------------------------------------------------------------
// Feed data ingestion (from YouTube API)
// ---------------------------------------------------------------------------

async function ingestFeedData(
  keyword: string,
  options: YouTubeFetchOptions = {},
  dateFilter?: DateFilter,
  deep = false
): Promise<{
  videos: YouTubeVideo[];
  meta: NonNullable<IngestedData["ingestionMeta"]>;
}> {
  const hasWindow = !!(dateFilter?.startDate && dateFilter?.endDate);
  const windowOpts: YouTubeFetchOptions = hasWindow
    ? { ...options, startDate: dateFilter!.startDate, endDate: dateFilter!.endDate }
    : options;

  if (deep) {
    // Reuse the SAME deep-collection engine Feed uses (multi-key, multi-query,
    // multi-page) so NC analyzes the full ingestion volume — not a single page.
    // NC additionally unions Telugu target-alias queries (Phase 1) so discovery
    // covers Telugu-script / transliterated / nickname references, then
    // classifies negativity AFTER collection (no English-negative pre-filter).
    const result = await collectYouTubeVideos(keyword, {
      ...windowOpts,
      startDate: dateFilter?.startDate,
      endDate: dateFilter?.endDate,
      extraQueries: expandTarget(keyword),
    });
    const collected = result.videos.length;
    const inWindow = filterVideosByDate(result.videos, dateFilter);
    return {
      videos: inWindow,
      meta: {
        mode: "deep",
        collected,
        inWindow: inWindow.length,
        skippedOutOfWindow: collected - inWindow.length,
        queriesIssued: result.queriesIssued,
        partialErrors: result.partialErrors,
        dateWindow: hasWindow
          ? { startDate: dateFilter!.startDate!, endDate: dateFilter!.endDate! }
          : null,
      },
    };
  }

  // Default (single-page) behaviour — unchanged contract for non-NC callers.
  const result = await fetchYouTubeVideos(keyword, windowOpts);
  const collected = result.videos.length;
  const inWindow = filterVideosByDate(result.videos, dateFilter);
  return {
    videos: inWindow,
    meta: {
      mode: "single_page",
      collected,
      inWindow: inWindow.length,
      skippedOutOfWindow: collected - inWindow.length,
      dateWindow: hasWindow
        ? { startDate: dateFilter!.startDate!, endDate: dateFilter!.endDate! }
        : null,
    },
  };
}

/**
 * Defensive, inclusive publishedAt window filter. The collector/API already
 * scopes by publishedAfter/publishedBefore, but query expansion can return
 * slightly out-of-window items, so NC re-applies the window locally to keep
 * clustering / scoring / cards strictly time-correct. Uses the shared pure
 * helper (lib/nc/dateWindow) so the logic is unit-tested in isolation.
 */
function filterVideosByDate(
  videos: YouTubeVideo[],
  dateFilter?: DateFilter
): YouTubeVideo[] {
  return filterByWindow(videos, dateFilter);
}

// ---------------------------------------------------------------------------
// Channel stats aggregation
// ---------------------------------------------------------------------------

function aggregateChannelStats(
  videos: YouTubeVideo[],
  talkItems: TalkItemRow[]
): ChannelStats[] {
  const map = new Map<
    string,
    {
      videoCount: number;
      totalViews: number;
      totalLikes: number;
      totalComments: number;
      positive: number;
      negative: number;
      neutral: number;
    }
  >();

  for (const v of videos) {
    const ch = v.channelTitle || "Unknown";
    const existing = map.get(ch) || {
      videoCount: 0,
      totalViews: 0,
      totalLikes: 0,
      totalComments: 0,
      positive: 0,
      negative: 0,
      neutral: 0,
    };
    existing.videoCount += 1;
    existing.totalViews += v.viewCount;
    existing.totalLikes += v.likeCount;
    existing.totalComments += v.commentCount;
    map.set(ch, existing);
  }

  // Overlay comment-level sentiment per channel
  for (const item of talkItems) {
    const ch = item.channelTitle || "Unknown";
    const existing = map.get(ch);
    if (existing) {
      if (item.sentiment === "positive") existing.positive++;
      else if (item.sentiment === "negative") existing.negative++;
      else existing.neutral++;
    }
  }

  return Array.from(map.entries())
    .map(([channelTitle, stats]) => ({
      channelTitle,
      videoCount: stats.videoCount,
      totalViews: stats.totalViews,
      totalLikes: stats.totalLikes,
      totalComments: stats.totalComments,
      commentSentiment: {
        positive: stats.positive,
        negative: stats.negative,
        neutral: stats.neutral,
        total: stats.positive + stats.negative + stats.neutral,
      },
    }))
    .sort((a, b) => b.totalViews - a.totalViews);
}

// ---------------------------------------------------------------------------
// Main ingestion function
// ---------------------------------------------------------------------------

/**
 * Ingest and normalize data from Talk (SQLite cache) and Feed (YouTube API).
 *
 * The keyword defaults to ANIL_DISPLAY_NAME if not provided, matching the
 * single-tenant architecture.
 */
export async function ingestData(
  keyword?: string,
  options: YouTubeFetchOptions = {},
  dateFilter?: DateFilter,
  ncOptions: { deep?: boolean } = {}
): Promise<IngestedData> {
  const kw = keyword || ANIL_DISPLAY_NAME;

  // Ingest from both sources in parallel.
  // dateFilter scopes BOTH talk items (SQLite) and videos (YouTube API window +
  // local re-filter). deep=true reuses Feed's full collection engine for NC.
  const [talkResult, feedResult] = await Promise.all([
    Promise.resolve(ingestTalkData(kw, dateFilter)),
    ingestFeedData(kw, options, dateFilter, ncOptions.deep ?? false),
  ]);

  const { items: talkItems, sentimentCounts, botCounts } = talkResult;
  const { videos, meta: ingestionMeta } = feedResult;

  // Compute engagement metrics from videos
  const totalVideos = videos.length;
  const totalViews = videos.reduce((s, v) => s + v.viewCount, 0);
  const totalLikes = videos.reduce((s, v) => s + v.likeCount, 0);
  const totalComments = videos.reduce((s, v) => s + v.commentCount, 0);
  const avgViewsPerVideo = totalVideos > 0 ? Math.round(totalViews / totalVideos) : 0;
  const engagementRate =
    totalViews > 0
      ? parseFloat(((totalLikes / totalViews) * 100).toFixed(2))
      : 0;

  // Aggregate channel stats
  const channelStats = aggregateChannelStats(videos, talkItems);

  return {
    keyword: kw,
    videos,
    talkItems,
    sentimentCounts,
    botCounts,
    channelStats,
    engagement: {
      totalVideos,
      totalViews,
      totalLikes,
      totalComments,
      avgViewsPerVideo,
      engagementRate,
    },
    ingestedAt: new Date().toISOString(),
    ingestionMeta,
  };
}

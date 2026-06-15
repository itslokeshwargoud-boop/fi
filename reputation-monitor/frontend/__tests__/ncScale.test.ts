/**
 * NC large-scale intelligence tests (Issues 1–3).
 *
 * Verifies the three production upgrades against real engine code:
 *   1. FULL-SCALE: every collected video is analyzed (no sampling / no LIMIT).
 *   2. TIME FILTER: the pure date-window helper scopes by publishedAt correctly.
 *   3. TRANSCRIPT EVIDENCE: timestamped spoken evidence is produced, carries
 *      clickable deep-links + narrative label + toxicity, and is prioritized
 *      over weaker title evidence.
 *
 * These run on synthetic data (no network / no model), so they validate the
 * logic and scaling behaviour, not real-world precision.
 */

import { describe, it, expect } from "vitest";
import { buildNCIntelligence, buildChannelEvidence, slug } from "@/lib/nc/ncEngine";
import { buildTranscriptEvidence } from "@/lib/nc/evidenceEngine";
import { isWithinWindow, filterByWindow } from "@/lib/nc/dateWindow";
import { parseTimedText } from "@/lib/nc/transcriptIngest";
import { scoreToxicity } from "@/lib/nc/toxicityLexicon";
import type { IngestedData, TranscriptSegment } from "@/lib/dataIngestion";
import type { TalkItemRow } from "@/lib/db/talkCache";
import type { YouTubeVideo } from "@/lib/youtube/fetchCore";

// --- synthetic data factory --------------------------------------------------

const TOXIC_TITLES = [
  "BOYCOTT this shameless cheat EXPOSED fraud",
  "fake fraud paid actor expose the truth boycott now",
  "anil fake behavior industry lo drama controversy",
];
const NEUTRAL_TITLES = [
  "Movie scene breakdown and analysis",
  "Latest update from the press meet",
  "Song promo launch event highlights",
];

function mkVideo(i: number, channel: string, toxic: boolean, publishedAt: string): YouTubeVideo {
  const title = toxic
    ? TOXIC_TITLES[i % TOXIC_TITLES.length]
    : NEUTRAL_TITLES[i % NEUTRAL_TITLES.length];
  return {
    id: `vid_${i}`,
    title,
    channelTitle: channel,
    publishedAt,
    thumbnailUrl: `https://img/${i}.jpg`,
    description: "",
    proofUrl: `https://www.youtube.com/watch?v=vid_${i}`,
    viewCount: toxic ? 50_000 + i * 13 : 1_000 + i,
    likeCount: 100 + i,
    commentCount: 10 + (i % 7),
  };
}

function mkComment(i: number, videoId: string, channel: string, toxic: boolean, publishedAt: string): TalkItemRow {
  return {
    commentId: `c_${videoId}_${i}`,
    videoId,
    text: toxic ? "boycott him shameless fraud cheat" : "nice video really enjoyed it",
    author: `u${i}`,
    authorChannelId: `UC${i}`,
    authorChannelUrl: "",
    publishedAt,
    videoTitle: "",
    channelTitle: channel,
    sentiment: toxic ? "negative" : "positive",
    proofUrl: `https://www.youtube.com/watch?v=${videoId}&lc=c_${i}`,
    keyword: "anil",
    fetchedAt: publishedAt,
    botScore: 0,
    botLabel: "human",
    botReasons: "[]",
  };
}

function emptyIngested(videos: YouTubeVideo[], talkItems: TalkItemRow[], extra: Partial<IngestedData> = {}): IngestedData {
  return {
    keyword: "anil",
    videos,
    talkItems,
    sentimentCounts: { positive: 0, negative: 0, neutral: 0, total: 0 },
    botCounts: { human: 0, suspicious: 0, bot: 0, total: 0 },
    channelStats: [],
    engagement: {
      totalVideos: videos.length, totalViews: 0, totalLikes: 0,
      totalComments: 0, avgViewsPerVideo: 0, engagementRate: 0,
    },
    ingestedAt: new Date().toISOString(),
    ...extra,
  };
}

function buildLargeDataset(n: number): IngestedData {
  const videos: YouTubeVideo[] = [];
  const talkItems: TalkItemRow[] = [];
  const channelCount = 30;
  const base = new Date("2026-05-01T00:00:00Z").getTime();
  for (let i = 0; i < n; i++) {
    const channel = `Channel ${i % channelCount}`;
    const toxic = i % 3 === 0; // ~1/3 carry negative-narrative signal
    const publishedAt = new Date(base + i * 3600_000).toISOString();
    videos.push(mkVideo(i, channel, toxic, publishedAt));
    // a few comments per video
    for (let k = 0; k < 3; k++) {
      talkItems.push(mkComment(k, `vid_${i}`, channel, toxic, publishedAt));
    }
  }
  return emptyIngested(videos, talkItems, {
    ingestionMeta: {
      mode: "deep", collected: n, inWindow: n, skippedOutOfWindow: 0,
      dateWindow: null,
    },
  });
}

// --- Issue 1: full-scale, no sampling ---------------------------------------

describe("Issue 1 — full-scale analysis (no sampling)", () => {
  it("analyzes ALL collected videos, not a subset", () => {
    const N = 800;
    const data = buildLargeDataset(N);
    const intel = buildNCIntelligence(data);

    expect(intel.processing).toBeDefined();
    expect(intel.processing!.collected).toBe(N);
    // EVERY video is analyzed — the core fix. No videos[:10] / LIMIT.
    expect(intel.processing!.analyzed).toBe(N);
    // The "only 1-2 flagged" symptom is gone: ~1/3 are toxic, so flagged is large.
    expect(intel.processing!.flagged).toBeGreaterThan(50);
    expect(intel.metrics.negativeVideosFound).toBe(intel.processing!.flagged);
  });

  it("scales: 800 videos process well under budget", () => {
    const data = buildLargeDataset(800);
    const t0 = Date.now();
    const intel = buildNCIntelligence(data);
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[bench] 800 videos analyzed in ${ms}ms, flagged=${intel.processing!.flagged}, channels=${intel.channels.length}`);
    expect(ms).toBeLessThan(8000);
    expect(intel.channels.length).toBeGreaterThan(0);
  });
});

// --- Issue 2: time-based filtering ------------------------------------------

describe("Issue 2 — date-window filtering", () => {
  const win = { startDate: "2026-05-10", endDate: "2026-05-12" };

  it("includes only in-window publishedAt", () => {
    expect(isWithinWindow("2026-05-11T08:00:00Z", win)).toBe(true);
    expect(isWithinWindow("2026-05-12T23:30:00Z", win)).toBe(true); // end-of-day inclusive
    expect(isWithinWindow("2026-05-09T23:59:59Z", win)).toBe(false);
    expect(isWithinWindow("2026-05-13T00:00:01Z", win)).toBe(false);
  });

  it("filters a mixed set down to the window", () => {
    const items = [
      { publishedAt: "2026-05-01T00:00:00Z" },
      { publishedAt: "2026-05-11T12:00:00Z" },
      { publishedAt: "2026-05-12T20:00:00Z" },
      { publishedAt: "2026-06-01T00:00:00Z" },
    ];
    expect(filterByWindow(items, win)).toHaveLength(2);
    expect(filterByWindow(items, undefined)).toHaveLength(4); // no window → passthrough
  });
});

// --- Issue 3: transcript evidence -------------------------------------------

describe("Issue 3 — transcript evidence", () => {
  const videos = [mkVideo(1, "Channel 1", true, "2026-05-11T00:00:00Z")];
  const transcripts: Record<string, TranscriptSegment[]> = {
    vid_1: [
      { start: 134, text: "industry lo fake behavior chestunnaru" },
      { start: 12, text: "normal intro thanks for watching" },
      { start: 220, text: "boycott this shameless fraud cheat" },
    ],
  };

  it("produces timestamped transcript evidence with clickable deep-links", () => {
    const ev = buildTranscriptEvidence(videos, transcripts);
    expect(ev.length).toBeGreaterThan(0);
    const seg = ev.find((e) => e.startSeconds === 134 || e.startSeconds === 220);
    expect(seg).toBeDefined();
    expect(seg!.type).toBe("transcript_segment");
    expect(seg!.timestamp).toMatch(/^\d+:\d{2}$/); // mm:ss
    expect(seg!.proofUrl).toContain("&t=");        // deep-link to exact second
    expect(seg!.proofUrl).toContain("vid_1");
    expect(typeof seg!.toxicity).toBe("number");
  });

  it("prioritizes transcript over title when transcript confidence is higher", () => {
    const bundle = buildChannelEvidence(
      emptyIngested(videos, [], { transcripts }),
      slug("Channel 1"),
    );
    expect(bundle).not.toBeNull();
    const trEv = bundle!.evidence.filter((e) => e.type === "transcript_segment");
    const titleEv = bundle!.evidence.filter((e) => e.type === "title_claim");
    expect(trEv.length).toBeGreaterThan(0);

    // Invariant (the documented semantics): a title_claim only survives for a
    // video when its toxicity exceeds the best transcript confidence for that
    // video — i.e. transcript evidence is prioritized whenever it is stronger.
    const titleById = new Map(videos.map((v) => [v.id, v.title]));
    for (const t of titleEv) {
      const bestTr = Math.max(
        0,
        ...trEv.filter((e) => e.videoId === t.videoId).map((e) => e.confidence),
      );
      const titleTox = scoreToxicity(titleById.get(t.videoId) ?? "").score;
      expect(titleTox).toBeGreaterThan(bestTr);
    }
  });

  it("orders transcript evidence before title evidence (drawer leads with speech)", () => {
    // A flagged video (toxic title ⇒ surfaces) that also has spoken evidence:
    // the drawer renders in array order, so transcript must precede title.
    const bundle = buildChannelEvidence(
      emptyIngested(videos, [], { transcripts }),
      slug("Channel 1"),
    );
    expect(bundle).not.toBeNull();
    const types = bundle!.evidence.map((e) => e.type);
    const firstTranscript = types.indexOf("transcript_segment");
    const firstTitle = types.indexOf("title_claim");
    expect(firstTranscript).toBeGreaterThanOrEqual(0);
    if (firstTitle >= 0) {
      expect(firstTranscript).toBeLessThan(firstTitle);
    }
  });
});

// --- caption parser ----------------------------------------------------------

describe("timedtext caption parser", () => {
  it("parses start offsets + text and de-duplicates", () => {
    const xml =
      '<transcript>' +
      '<text start="2.5" dur="3">industry lo fake behavior</text>' +
      '<text start="2.5" dur="3">industry lo fake behavior</text>' + // dup
      '<text start="10.0" dur="2">boycott &amp; expose</text>' +
      '</transcript>';
    const segs = parseTimedText(xml);
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBe(2.5);
    expect(segs[1].text).toContain("boycott");
  });

  it("returns [] for empty/non-caption payloads (graceful)", () => {
    expect(parseTimedText("")).toHaveLength(0);
    expect(parseTimedText("<html>nope</html>")).toHaveLength(0);
  });
});

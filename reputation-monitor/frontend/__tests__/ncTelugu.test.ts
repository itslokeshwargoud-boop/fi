/**
 * NC Telugu Narrative Intelligence — critical validation cases.
 *
 * Maps directly to the brief's three CRITICAL VALIDATION TEST CASEs. Runs on
 * synthetic data (no network / no model) so it validates the engine logic and
 * the transcript-primary behaviour, not real-world accuracy.
 */

import { describe, it, expect } from "vitest";
import { buildNCIntelligence, buildChannelEvidence, slug } from "@/lib/nc/ncEngine";
import { expandTarget, mentionsTarget, resolveAliases } from "@/lib/nc/targetExpansion";
import { weightedToxicity } from "@/lib/nc/signalWeights";
import { scoreToxicity } from "@/lib/nc/toxicityLexicon";
import { normalizeText } from "@/lib/nc/preprocess";
import { filterByWindow } from "@/lib/nc/dateWindow";
import type { IngestedData, TranscriptSegment } from "@/lib/dataIngestion";
import type { TalkItemRow } from "@/lib/db/talkCache";
import type { YouTubeVideo } from "@/lib/youtube/fetchCore";

function video(id: string, title: string, channel: string, publishedAt: string): YouTubeVideo {
  return {
    id, title, channelTitle: channel, publishedAt,
    thumbnailUrl: "", description: "", proofUrl: `https://www.youtube.com/watch?v=${id}`,
    viewCount: 10000, likeCount: 50, commentCount: 5,
  };
}
function comment(id: string, videoId: string, channel: string, text: string, sentiment: TalkItemRow["sentiment"]): TalkItemRow {
  return {
    commentId: id, videoId, text, author: "u", authorChannelId: "UCx", authorChannelUrl: "",
    publishedAt: "2026-06-10T00:00:00Z", videoTitle: "", channelTitle: channel,
    sentiment, proofUrl: "", keyword: "prabhas", fetchedAt: "", botScore: 0,
    botLabel: "human", botReasons: "[]",
  };
}
function ingested(videos: YouTubeVideo[], talkItems: TalkItemRow[], extra: Partial<IngestedData> = {}): IngestedData {
  return {
    keyword: "Prabhas", videos, talkItems,
    sentimentCounts: { positive: 0, negative: 0, neutral: 0, total: 0 },
    botCounts: { human: 0, suspicious: 0, bot: 0, total: 0 },
    channelStats: [],
    engagement: { totalVideos: videos.length, totalViews: 0, totalLikes: 0, totalComments: 0, avgViewsPerVideo: 0, engagementRate: 0 },
    ingestedAt: new Date().toISOString(),
    ...extra,
  };
}

// ── CRITICAL VALIDATION TEST CASE 1 — Telugu discovery ──────────────────────

describe("VALIDATION 1 — Telugu target discovery", () => {
  it("expands a target into Telugu / transliterated / alias queries", () => {
    const q = expandTarget("Prabhas");
    expect(q).toContain("Prabhas");
    expect(q).toContain("ప్రభాస్");      // Telugu script
    expect(q).toContain("Darling");       // alias
    expect(q).toContain("Rebel Star");    // alias
    expect(q).toContain("Prabhas Anna");  // nickname
    expect(resolveAliases("darling")?.canonical).toBe("Prabhas"); // reverse lookup
  });

  it("identifies the target across Telugu / mixed / transliterated titles", () => {
    const titles = [
      "ప్రభాస్ పై సంచలన వ్యాఖ్యలు",          // Telugu script
      "Prabhas pai mosam jariginda?",          // transliterated/mixed
      "Prabhas Latest Update | నిజం బయటపడింది", // mixed-language
    ];
    for (const t of titles) {
      expect(mentionsTarget(t, "Prabhas")).toBe(true);
    }
    // Telugu / code-mix detection works on these.
    expect(normalizeText(titles[0]).hasTelugu).toBe(true);
    expect(normalizeText(titles[2]).hasTelugu).toBe(true);
  });

  it("all three videos enter the NC analysis pipeline (no English pre-filter)", () => {
    const vids = [
      video("d1", "ప్రభాస్ పై సంచలన వ్యాఖ్యలు", "Ch A", "2026-06-10T00:00:00Z"),
      video("d2", "Prabhas pai mosam jariginda?", "Ch B", "2026-06-10T00:00:00Z"),
      video("d3", "Prabhas Latest Update | నిజం బయటపడింది", "Ch C", "2026-06-10T00:00:00Z"),
    ];
    const intel = buildNCIntelligence(ingested(vids, [], {
      ingestionMeta: { mode: "deep", collected: 3, inWindow: 3, skippedOutOfWindow: 0, dateWindow: null },
    }));
    // PASS CONDITION: all videos appear inside NC analysis (analyzed == collected).
    expect(intel.processing!.analyzed).toBe(3);
    expect(intel.processing!.collected).toBe(3);
  });
});

// ── CRITICAL VALIDATION TEST CASE 2 — spoken negativity ─────────────────────

describe("VALIDATION 2 — spoken negativity flags neutral-title video", () => {
  const channel = "TrollChannel";
  const vids = [video("s1", "Prabhas Latest Interview", channel, "2026-06-10T00:00:00Z")];
  const neutralComments = [
    comment("c1", "s1", channel, "thanks for the update", "neutral"),
    comment("c2", "s1", channel, "nice interview", "positive"),
  ];
  const transcripts: Record<string, TranscriptSegment[]> = {
    s1: [
      { start: 134, text: "audience ni mosam chestunnadu" },     // deception
      { start: 258, text: "industry lo fake behavior chestunnaru" },
      { start: 512, text: "fans ni cheat chestunnaru" },
    ],
  };

  it("title + comments are neutral on their own", () => {
    expect(scoreToxicity("Prabhas Latest Interview").score).toBeLessThan(0.4);
    const avgComment =
      neutralComments.reduce((s, c) => s + scoreToxicity(c.text).score, 0) / neutralComments.length;
    expect(avgComment).toBeLessThan(0.4);
  });

  it("spoken transcript is toxic and dominates the weighted signal", () => {
    const trTox = Math.max(...transcripts.s1.map((s) => scoreToxicity(s.text).score));
    expect(trTox).toBeGreaterThanOrEqual(0.45);
    // transcript-primary weighting pushes unified toxicity up even with a clean title
    const unified = weightedToxicity({ transcript: trTox, title: 0.1, comments: 0.05 });
    expect(unified).toBeGreaterThan(0.4);
  });

  it("PASS: channel is flagged from transcript even with neutral title/comments", () => {
    const data = ingested(vids, neutralComments, { transcripts });
    const intel = buildNCIntelligence(data);
    // The channel surfaces in the spreaders list...
    const ch = intel.channels.find((c) => c.channelKey === slug(channel));
    expect(ch).toBeDefined();
    expect(intel.processing!.flagged).toBeGreaterThan(0);

    // ...and the drawer shows timestamped transcript evidence.
    const bundle = buildChannelEvidence(data, slug(channel));
    expect(bundle).not.toBeNull();
    const trEv = bundle!.evidence.filter((e) => e.type === "transcript_segment");
    expect(trEv.length).toBeGreaterThan(0);
    expect(trEv[0].proofUrl).toContain("&t=");        // clickable timestamp
    expect(trEv[0].startSeconds).toBeGreaterThan(0);
    // Transcript evidence is ordered ahead of any title evidence.
    const types = bundle!.evidence.map((e) => e.type);
    if (types.includes("title_claim")) {
      expect(types.indexOf("transcript_segment")).toBeLessThan(types.indexOf("title_claim"));
    }
  });
});

// ── CRITICAL VALIDATION TEST CASE 3 — full-scale + time filter ──────────────

describe("VALIDATION 3 — 1000-video full-scale analysis + time filter", () => {
  it("analyzes ALL 1000 videos (Analyzed == Collected, no sampling)", () => {
    const N = 1000;
    const videos: YouTubeVideo[] = [];
    const base = new Date("2026-05-01T00:00:00Z").getTime();
    for (let i = 0; i < N; i++) {
      videos.push(video(`v${i}`, i % 3 === 0 ? "fake mosam cheat exposed" : "normal update", `Ch ${i % 40}`, new Date(base + i * 3600_000).toISOString()));
    }
    const t0 = Date.now();
    const intel = buildNCIntelligence(ingested(videos, [], {
      ingestionMeta: { mode: "deep", collected: N, inWindow: N, skippedOutOfWindow: 0, dateWindow: null },
    }));
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[bench] 1000 videos analyzed in ${ms}ms, flagged=${intel.processing!.flagged}`);
    expect(intel.processing!.analyzed).toBe(N);
    expect(intel.processing!.collected).toBe(N);
    expect(ms).toBeLessThan(10000);
  });

  it("time filter: keeps recent (2d) video, excludes old (20d) video", () => {
    const now = Date.now();
    const win = { startDate: new Date(now - 7 * 864e5).toISOString().slice(0, 10), endDate: new Date(now).toISOString().slice(0, 10) };
    const items = [
      { publishedAt: new Date(now - 2 * 864e5).toISOString() },  // Video A (2 days)
      { publishedAt: new Date(now - 20 * 864e5).toISOString() }, // Video B (20 days)
    ];
    const kept = filterByWindow(items, win);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(items[0]); // A kept, B excluded
  });
});

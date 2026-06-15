/**
 * Transcript-First audit harness verification.
 *
 * Verifies the audit correctly classifies discovery source, counts transcript
 * coverage, identifies transcript-only channels + speech-only videos, and
 * computes a defensible readiness level — on a synthetic dataset with KNOWN
 * ground truth. (Synthetic = mechanism validation, not real-world metrics.)
 */

import { describe, it, expect } from "vitest";
import {
  extractSignals,
  runFullAudit,
  SIGNAL_FLAG_THRESHOLD,
} from "@/lib/nc/transcriptAudit";
import { scoreToxicity } from "@/lib/nc/toxicityLexicon";
import type { IngestedData, TranscriptSegment } from "@/lib/dataIngestion";
import type { TalkItemRow } from "@/lib/db/talkCache";
import type { YouTubeVideo } from "@/lib/youtube/fetchCore";

function vid(id: string, title: string, channel: string): YouTubeVideo {
  return {
    id, title, channelTitle: channel, publishedAt: "2026-06-10T00:00:00Z",
    thumbnailUrl: "", description: "", proofUrl: `https://youtu.be/${id}`,
    viewCount: 10000, likeCount: 10, commentCount: 2,
  };
}
function cmt(id: string, videoId: string, channel: string, text: string): TalkItemRow {
  return {
    commentId: id, videoId, text, author: "u", authorChannelId: "UC", authorChannelUrl: "",
    publishedAt: "2026-06-10T00:00:00Z", videoTitle: "", channelTitle: channel,
    sentiment: "neutral", proofUrl: "", keyword: "k", fetchedAt: "", botScore: 0,
    botLabel: "human", botReasons: "[]",
  };
}
function data(videos: YouTubeVideo[], talkItems: TalkItemRow[], transcripts?: Record<string, TranscriptSegment[]>): IngestedData {
  return {
    keyword: "Prabhas", videos, talkItems,
    sentimentCounts: { positive: 0, negative: 0, neutral: 0, total: 0 },
    botCounts: { human: 0, suspicious: 0, bot: 0, total: 0 }, channelStats: [],
    engagement: { totalVideos: videos.length, totalViews: 0, totalLikes: 0, totalComments: 0, avgViewsPerVideo: 0, engagementRate: 0 },
    ingestedAt: "", transcripts,
  };
}

describe("audit — sanity of synthetic ground truth", () => {
  it("the synthetic toxic transcript clears the flag threshold and titles are clean", () => {
    expect(scoreToxicity("audience ni mosam chestunnadu").score).toBeGreaterThanOrEqual(SIGNAL_FLAG_THRESHOLD);
    expect(scoreToxicity("Prabhas Latest Interview").score).toBeLessThan(SIGNAL_FLAG_THRESHOLD);
    expect(scoreToxicity("fake fraud cheat exposed boycott").score).toBeGreaterThanOrEqual(SIGNAL_FLAG_THRESHOLD);
  });
});

describe("audit — discovery source classification", () => {
  // T1: transcript-only (neutral title, toxic speech)
  // T2: title-only (toxic title, no transcript)
  // T3: title+transcript
  // T4: clean everything (not flagged)
  const videos = [
    vid("t1", "Prabhas Latest Interview", "SpeechCh"),
    vid("t2", "fake fraud cheat exposed boycott", "TitleCh"),
    vid("t3", "fake fraud cheat exposed", "BothCh"),
    vid("t4", "Prabhas movie scene", "CleanCh"),
  ];
  const transcripts = {
    t1: [{ start: 134, text: "audience ni mosam chestunnadu" }],
    t3: [{ start: 60, text: "industry lo fake behavior cheat mosam" }],
    t4: [{ start: 20, text: "great movie loved the songs" }],
  };
  const audit = runFullAudit(data(videos, [], transcripts));

  it("classifies each video by the source that flags it", () => {
    const byId = new Map(audit.signals.map((s) => [s.videoId, s]));
    expect(byId.get("t1")!.discoverySource).toBe("TRANSCRIPT_ONLY");
    expect(byId.get("t2")!.discoverySource).toBe("TITLE_ONLY");
    expect(byId.get("t3")!.discoverySource).toBe("TITLE_AND_TRANSCRIPT");
    expect(byId.get("t4")!.flagged).toBe(false);
  });

  it("answers the primary question: discoveries title-only would miss", () => {
    expect(audit.discovery.totalFlagged).toBe(3);
    expect(audit.discovery.missedByTitleOnly).toBe(1);  // t1
    expect(audit.discovery.transcriptOnly).toBe(1);     // t1
    expect(audit.discovery.titleDriven).toBe(2);        // t2, t3
  });
});

describe("audit — coverage, transcript-only channels, speech-only", () => {
  const videos = [
    vid("a", "Prabhas Latest Interview", "ChA"),     // transcript-only
    vid("b", "Prabhas press meet update", "ChA"),     // clean
    vid("c", "fake fraud exposed boycott", "ChB"),    // title-only
  ];
  const transcripts = {
    a: [{ start: 90, text: "fans ni mosam chestunnaru cheat" }],
    b: [{ start: 10, text: "thanks for watching subscribe" }],
  };
  const audit = runFullAudit(data(videos, [], transcripts));

  it("transcript coverage counts videos with transcripts", () => {
    expect(audit.coverage.totalVideos).toBe(3);
    expect(audit.coverage.withTranscript).toBe(2);
    expect(audit.coverage.transcriptCoveragePct).toBeCloseTo(66.7, 0);
    expect(audit.coverage.captionTypeKnown).toBe(false); // no source map → backend-required
  });

  it("identifies transcript-only channels (unflagged if transcripts removed)", () => {
    // ChA is flagged ONLY via transcript (video a); ChB flagged via title.
    expect(audit.transcriptOnlyChannels.channels).toContain("cha");
    expect(audit.transcriptOnlyChannels.channels).not.toContain("chb");
    const row = audit.transcriptOnlyChannels.rows.find((r) => r.videoId === "a");
    expect(row).toBeDefined();
    expect(row!.timestamp).toBe(90);
    expect(row!.transcriptSnippet).toContain("mosam");
  });

  it("speech-only report finds neutral-title+comment, toxic-transcript videos", () => {
    expect(audit.speechOnly.count).toBe(1); // video a
    expect(audit.speechOnly.channelsAffected).toBe(1);
    expect(audit.speechOnly.examples[0].videoId).toBe("a");
  });
});

describe("audit — caption-type coverage when backend sources supplied", () => {
  const videos = [vid("x", "t", "C"), vid("y", "t", "C"), vid("z", "t", "C")];
  const transcripts = { x: [{ start: 1, text: "a" }], y: [{ start: 1, text: "b" }] };
  const sources = { x: "official_caption", y: "whisper", z: "none" } as const;
  const audit = runFullAudit(data(videos, [], transcripts), sources);

  it("breaks down coverage by caption type", () => {
    expect(audit.coverage.captionTypeKnown).toBe(true);
    expect(audit.coverage.byType!.official_caption).toBe(1);
    expect(audit.coverage.byType!.whisper).toBe(1);
    expect(audit.coverage.byType!.none).toBe(1);
  });
});

describe("audit — false positives + readiness", () => {
  it("flags title-only-with-no-transcript-support as FP candidates", () => {
    const videos = [vid("fp", "fake fraud cheat exposed boycott", "ClickbaitCh")];
    const audit = runFullAudit(data(videos, [])); // no transcript
    expect(audit.falsePositives.count).toBe(1);
    expect(audit.falsePositives.candidates[0].reason).toContain("no transcript");
  });

  it("readiness level reflects coverage + transcript-driven share (conservative)", () => {
    // All transcript-only discoveries, full coverage → high readiness.
    const videos = [vid("a", "Prabhas interview", "A"), vid("b", "Prabhas update", "B")];
    const transcripts = {
      a: [{ start: 1, text: "mosam cheat fake behavior" }],
      b: [{ start: 1, text: "fans ni mosam chestunnaru cheat" }],
    };
    const audit = runFullAudit(data(videos, [], transcripts));
    expect(audit.coverage.transcriptCoveragePct).toBe(100);
    expect(audit.readiness.transcriptDrivenShare).toBe(100);
    expect(audit.readiness.level).toBeGreaterThanOrEqual(4); // transcript-first
  });
});

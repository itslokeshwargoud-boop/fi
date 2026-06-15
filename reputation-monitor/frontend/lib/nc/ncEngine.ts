/**
 * NC engine — orchestrator.
 *
 * Transforms the platform's unified IngestedData (the same input every other
 * Reputation-OS module consumes) into the NC intelligence payload: channel
 * profiles, narrative clusters, threat timeline, shorts tracker and headline
 * metrics. Also builds the per-channel evidence bundle for the drawer.
 *
 * Everything here runs on data that genuinely exists in the live pipeline
 * (videos + comments + sentiment + bot scores). Transcript/OCR enrichment from
 * the Python layer is merged in when available but is never required.
 */

import type { IngestedData } from "@/lib/dataIngestion";
import type { TalkItemRow } from "@/lib/db/talkCache";
import type { YouTubeVideo } from "@/lib/youtube/fetchCore";
import { scoreToxicity } from "./toxicityLexicon";
import { clusterNarratives, type NarrativeDoc } from "./narrativeEngine";
import { scoreVideoRisk, scoreChannelRisk } from "./riskEngine";
import { buildEvidence } from "./evidenceEngine";
import { weightedToxicity, type SignalWeights } from "./signalWeights";
import type {
  NarrativeType,
  NCChannel,
  NCChannelEvidence,
  NCFlaggedVideo,
  NCIntelligence,
  NCMetrics,
  NCShort,
  NCTimelinePoint,
  RiskLevel,
} from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function sentimentToNum(s: TalkItemRow["sentiment"]): number {
  return s === "positive" ? 1 : s === "negative" ? -1 : 0;
}

function isShortVideo(v: YouTubeVideo): boolean {
  return /\/shorts\//i.test(v.proofUrl) || /#shorts?\b/i.test(v.title);
}

interface VideoAnalysis {
  video: YouTubeVideo;
  channelKey: string;
  sentiment: number; // -1..1
  toxicity: number; // 0..1 (weighted, transcript-primary)
  narrativeType: NarrativeType;
  narrativeIntensity: number; // 0..1
  riskScore: number;
  riskLevel: RiskLevel;
  isShort: boolean;
  commentCount: number;
  /** Per-source toxicity (0..1) for transparency + evidence prioritization. */
  transcriptToxicity: number;
  titleToxicity: number;
  hasTranscript: boolean;
}

/** Analyse every video using transcript (primary) + title + comments. */
function analyzeVideos(
  data: IngestedData,
  narrativeByText: (text: string) => { type: NarrativeType; intensity: number },
  weights?: SignalWeights,
): VideoAnalysis[] {
  const commentsByVideo = new Map<string, TalkItemRow[]>();
  for (const c of data.talkItems) {
    const arr = commentsByVideo.get(c.videoId) ?? [];
    arr.push(c);
    commentsByVideo.set(c.videoId, arr);
  }

  return data.videos.map((v) => {
    const comments = commentsByVideo.get(v.id) ?? [];

    // sentiment: mean of comment sentiment (fallback neutral)
    const sentiment =
      comments.length > 0
        ? comments.reduce((s, c) => s + sentimentToNum(c.sentiment), 0) /
          comments.length
        : 0;

    // Per-source toxicity signals.
    const titleTox = scoreToxicity(v.title).score;
    const descTox = v.description ? scoreToxicity(v.description).score : undefined;
    const commentTox =
      comments.length > 0
        ? comments.reduce((s, c) => s + scoreToxicity(c.text).score, 0) /
          comments.length
        : undefined;

    // Transcript (PRIMARY signal). Present only when a transcript source has
    // populated data.transcripts for this video.
    const segments = data.transcripts?.[v.id] ?? [];
    const hasTranscript = segments.length > 0;
    const transcriptText = segments.map((s) => s.text).join(" ");
    const transcriptTox = hasTranscript
      ? Math.max(
          scoreToxicity(transcriptText).score,
          // peak-segment signal: a single highly-toxic line is strong evidence
          ...segments.map((s) => scoreToxicity(s.text).score),
        )
      : undefined;

    // Weighted, transcript-primary unified toxicity (renormalized over present
    // signals). Title-only videos behave as before; spoken toxicity dominates.
    const toxicity = weightedToxicity(
      {
        transcript: transcriptTox,
        comments: commentTox,
        title: titleTox,
        description: descTox,
      },
      weights,
    );

    // Narrative: prioritize spoken content when present, else title+comments.
    const narrSource = hasTranscript
      ? `${transcriptText} ${v.title}`
      : `${v.title} ${comments.slice(0, 20).map((c) => c.text).join(" ")}`;
    const narr = narrativeByText(narrSource);

    const { score, level } = scoreVideoRisk({
      sentiment,
      toxicity,
      narrativeIntensity: narr.intensity,
      views: v.viewCount,
      repeatedTargeting: 0, // set later per-channel
    });

    return {
      video: v,
      channelKey: slug(v.channelTitle),
      sentiment,
      toxicity,
      narrativeType: narr.type,
      narrativeIntensity: narr.intensity,
      riskScore: score,
      riskLevel: level,
      isShort: isShortVideo(v),
      commentCount: comments.length,
      transcriptToxicity: transcriptTox ?? 0,
      titleToxicity: titleTox,
      hasTranscript,
    };
  });
}

/**
 * A video is "flagged" when it carries meaningful negative-narrative signal.
 * Transcript-primary: strongly toxic SPOKEN content flags a video even when its
 * title and comments are neutral (the core Telugu-intelligence upgrade).
 */
function isFlagged(a: VideoAnalysis): boolean {
  // Spoken-content gate: toxic transcript is sufficient on its own.
  if (a.hasTranscript && a.transcriptToxicity >= 0.45) return true;
  return (a.toxicity >= 0.4 || a.sentiment <= -0.3) && a.narrativeType !== "other"
    ? true
    : a.toxicity >= 0.55 || a.riskScore >= 45;
}

function modeNarrative(types: NarrativeType[]): NarrativeType {
  if (types.length === 0) return "other";
  const counts = new Map<NarrativeType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Amplification: upload bursts + shorts farming. 0..100. */
function amplification(videos: YouTubeVideo[], shorts: number): number {
  if (videos.length === 0) return 0;
  const times = videos
    .map((v) => new Date(v.publishedAt).getTime())
    .sort((a, b) => a - b);
  let bursts = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < MS_PER_DAY) bursts++;
  }
  const burstFactor = Math.min(1, bursts / Math.max(1, videos.length - 1));
  const shortsFactor = Math.min(1, shorts / videos.length);
  return parseFloat(((burstFactor * 0.6 + shortsFactor * 0.4) * 100).toFixed(1));
}

function buildTimeline(analyses: VideoAnalysis[]): NCTimelinePoint[] {
  const byDay = new Map<string, { flagged: number; toxSum: number; n: number }>();
  for (const a of analyses) {
    if (!isFlagged(a)) continue;
    const day = a.video.publishedAt.slice(0, 10);
    const b = byDay.get(day) ?? { flagged: 0, toxSum: 0, n: 0 };
    b.flagged++;
    b.toxSum += a.toxicity;
    b.n++;
    byDay.set(day, b);
  }
  const points = [...byDay.entries()]
    .map(([date, b]) => ({
      date,
      flaggedVideos: b.flagged,
      toxicity: parseFloat((b.toxSum / b.n).toFixed(3)),
      threatVelocity: 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].flaggedVideos || 1;
    points[i].threatVelocity = parseFloat(
      (((points[i].flaggedVideos - prev) / prev) * 100).toFixed(1),
    );
  }
  return points;
}

/** Build channel profiles from per-video analyses. */
function buildChannels(analyses: VideoAnalysis[]): NCChannel[] {
  const byChannel = new Map<string, VideoAnalysis[]>();
  for (const a of analyses) {
    const arr = byChannel.get(a.channelKey) ?? [];
    arr.push(a);
    byChannel.set(a.channelKey, arr);
  }

  const channels: NCChannel[] = [];
  for (const [channelKey, vids] of byChannel) {
    const flagged = vids.filter(isFlagged);
    if (flagged.length === 0) continue; // only surface channels with signal

    const flaggedRatio = flagged.length / vids.length;
    const avgVideoRisk =
      flagged.reduce((s, a) => s + a.riskScore, 0) / flagged.length;
    const audienceToxicity =
      flagged.reduce((s, a) => s + a.toxicity, 0) / flagged.length;
    const shortsCount = flagged.filter((a) => a.isShort).length;
    const ampScore = amplification(flagged.map((a) => a.video), shortsCount);

    const types = flagged.map((a) => a.narrativeType);
    const dominant = modeNarrative(types);
    const narrativeRepetition =
      types.filter((t) => t === dominant).length / types.length;

    const { score, level } = scoreChannelRisk({
      flaggedRatio,
      avgVideoRisk,
      audienceToxicity,
      amplificationScore: ampScore,
      narrativeRepetition,
    });

    const reach = flagged.reduce((s, a) => s + a.video.viewCount, 0);
    const lastActive = flagged
      .map((a) => a.video.publishedAt)
      .sort()
      .reverse()[0];

    // confidence scales with evidence volume (more flagged videos = surer call)
    const confidence = parseFloat(
      Math.min(0.95, 0.5 + Math.log10(flagged.length + 1) / 3).toFixed(2),
    );

    channels.push({
      channelKey,
      channelName: flagged[0].video.channelTitle,
      channelUrl: "",
      riskScore: score,
      riskLevel: level,
      confidence,
      dominantNarrative: dominant,
      narrativeTypes: [...new Set(types)],
      flaggedVideoCount: flagged.length,
      totalVideoCount: vids.length,
      reach,
      repeatedTargetingCount: flagged.length, // each flagged upload re-targets subject
      amplificationScore: ampScore,
      audienceToxicity: parseFloat(audienceToxicity.toFixed(3)),
      shortsCount,
      lastActive,
    });
  }

  return channels.sort((a, b) => b.riskScore - a.riskScore);
}

function buildShorts(analyses: VideoAnalysis[]): NCShort[] {
  return analyses
    .filter((a) => a.isShort && isFlagged(a))
    .map((a) => ({
      videoId: a.video.id,
      title: a.video.title,
      thumbnailUrl: a.video.thumbnailUrl,
      proofUrl: a.video.proofUrl,
      publishedAt: a.video.publishedAt,
      views: a.video.viewCount,
      burstId: null,
      riskLevel: a.riskLevel,
      narrativeType: a.narrativeType,
    }))
    .sort((a, b) => b.views - a.views);
}

function computeMetrics(
  analyses: VideoAnalysis[],
  channels: NCChannel[],
  clusterCount: number,
  timeline: NCTimelinePoint[],
): NCMetrics {
  const flagged = analyses.filter(isFlagged);
  const toxicityScore =
    flagged.length > 0
      ? (flagged.reduce((s, a) => s + a.toxicity, 0) / flagged.length) * 100
      : 0;
  const amplificationScore =
    channels.length > 0
      ? channels.reduce((s, c) => s + c.amplificationScore, 0) / channels.length
      : 0;
  const threatVelocity =
    timeline.length > 0 ? timeline[timeline.length - 1].threatVelocity : 0;

  return {
    negativeVideosFound: flagged.length,
    highRiskChannels: channels.filter(
      (c) => c.riskLevel === "HIGH" || c.riskLevel === "CRITICAL",
    ).length,
    narrativeClusters: clusterCount,
    toxicityScore: parseFloat(toxicityScore.toFixed(1)),
    threatVelocity,
    amplificationScore: parseFloat(amplificationScore.toFixed(1)),
  };
}

/** Make a text→narrative resolver from the cluster set (for per-video typing). */
function makeNarrativeResolver(
  docs: NarrativeDoc[],
): (text: string) => { type: NarrativeType; intensity: number } {
  const clusters = clusterNarratives(docs);
  // intensity proxy: presence of cluster key terms in the text.
  return (text: string) => {
    const lower = text.toLowerCase();
    let best: { type: NarrativeType; intensity: number } = {
      type: "other",
      intensity: 0,
    };
    for (const c of clusters) {
      const hits = c.keyTerms.filter((t) => lower.includes(t)).length;
      if (hits === 0) continue;
      const intensity = Math.min(1, hits / Math.max(1, c.keyTerms.length));
      if (intensity > best.intensity) best = { type: c.type, intensity };
    }
    return best;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildNCIntelligence(data: IngestedData): NCIntelligence {
  // Narrative corpus = titles + comments.
  const docs: NarrativeDoc[] = [
    ...data.videos.map((v) => ({
      id: `v_${v.id}`,
      text: v.title,
      sentiment: 0,
      toxicity: scoreToxicity(v.title).score,
      channel: v.channelTitle,
      publishedAt: v.publishedAt,
    })),
    ...data.talkItems.map((c) => ({
      id: `c_${c.commentId}`,
      text: c.text,
      sentiment: sentimentToNum(c.sentiment),
      toxicity: scoreToxicity(c.text).score,
      channel: c.channelTitle,
      publishedAt: c.publishedAt,
    })),
  ];

  const narratives = clusterNarratives(docs);
  const resolver = makeNarrativeResolver(docs);
  const analyses = analyzeVideos(data, resolver);

  const channels = buildChannels(analyses);
  const timeline = buildTimeline(analyses);
  const shorts = buildShorts(analyses);
  const metrics = computeMetrics(analyses, channels, narratives.length, timeline);

  const flaggedCount = analyses.filter(isFlagged).length;
  const withTranscript = data.transcripts
    ? analyses.filter((a) => (data.transcripts![a.video.id]?.length ?? 0) > 0).length
    : 0;
  const im = data.ingestionMeta;

  return {
    keyword: data.keyword,
    metrics,
    channels,
    narratives,
    timeline,
    shorts,
    generatedAt: new Date().toISOString(),
    processing: {
      mode: im?.mode ?? "single_page",
      collected: im?.collected ?? data.videos.length,
      analyzed: analyses.length,
      flagged: flaggedCount,
      skipped: im?.skippedOutOfWindow ?? 0,
      withTranscript,
      dateWindow: im?.dateWindow ?? null,
    },
  };
}

/** Per-channel evidence bundle for the drawer. */
export function buildChannelEvidence(
  data: IngestedData,
  channelKey: string,
): NCChannelEvidence | null {
  const resolver = makeNarrativeResolver([
    ...data.videos.map((v) => ({
      id: `v_${v.id}`,
      text: v.title,
      sentiment: 0,
      toxicity: scoreToxicity(v.title).score,
      channel: v.channelTitle,
      publishedAt: v.publishedAt,
    })),
    ...data.talkItems.map((c) => ({
      id: `c_${c.commentId}`,
      text: c.text,
      sentiment: sentimentToNum(c.sentiment),
      toxicity: scoreToxicity(c.text).score,
      channel: c.channelTitle,
      publishedAt: c.publishedAt,
    })),
  ]);

  const analyses = analyzeVideos(data, resolver).filter(
    (a) => a.channelKey === channelKey,
  );
  if (analyses.length === 0) return null;

  const channels = buildChannels(analyses);
  const channel = channels.find((c) => c.channelKey === channelKey);
  if (!channel) return null;

  const flaggedAnalyses = analyses.filter(isFlagged);
  const flaggedVideos: NCFlaggedVideo[] = flaggedAnalyses.map((a) => ({
    videoId: a.video.id,
    title: a.video.title,
    thumbnailUrl: a.video.thumbnailUrl,
    proofUrl: a.video.proofUrl,
    publishedAt: a.video.publishedAt,
    isShort: a.isShort,
    views: a.video.viewCount,
    likes: a.video.likeCount,
    comments: a.video.commentCount,
    sentimentScore: parseFloat(a.sentiment.toFixed(3)),
    toxicityScore: parseFloat(a.toxicity.toFixed(3)),
    narrativeType: a.narrativeType,
    riskScore: a.riskScore,
    riskLevel: a.riskLevel,
  }));

  const flaggedVideoIds = new Set(flaggedAnalyses.map((a) => a.video.id));
  const channelComments = data.talkItems.filter((c) => flaggedVideoIds.has(c.videoId));
  // Scope transcripts to this channel's flagged videos (Issue 3).
  const channelTranscripts: Record<string, import("@/lib/dataIngestion").TranscriptSegment[]> = {};
  if (data.transcripts) {
    for (const id of flaggedVideoIds) {
      if (data.transcripts[id]) channelTranscripts[id] = data.transcripts[id];
    }
  }
  const evidence = buildEvidence(
    flaggedAnalyses.map((a) => a.video),
    channelComments,
    { transcripts: channelTranscripts, narrativeByText: resolver },
  );

  const riskBreakdown = {
    sentiment: parseFloat(
      (flaggedAnalyses.reduce((s, a) => s + (1 - (a.sentiment + 1) / 2), 0) /
        flaggedAnalyses.length).toFixed(3),
    ),
    toxicity: channel.audienceToxicity,
    narrativeIntensity: parseFloat(
      (flaggedAnalyses.reduce((s, a) => s + a.narrativeIntensity, 0) /
        flaggedAnalyses.length).toFixed(3),
    ),
    virality: parseFloat(
      Math.min(1, Math.log10(channel.reach + 1) / 7).toFixed(3),
    ),
    repeatedTargeting: Math.min(1, channel.repeatedTargetingCount / 8),
  };

  return {
    channel,
    flaggedVideos,
    evidence,
    narrativeTimeline: buildTimeline(analyses),
    shorts: buildShorts(analyses),
    riskBreakdown,
  };
}

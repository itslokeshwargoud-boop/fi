/**
 * Transcript-First Validation Audit (validation-only phase).
 *
 * Computes the 10 validation reports from ACTUAL engine signals over an
 * IngestedData payload. It re-derives, per video, the independent negativity of
 * each source (title / comments / transcript) using the same toxicity scorer
 * and the same spoken-content threshold (0.45) the engine's flagging uses, then
 * classifies discovery source and aggregates per channel.
 *
 * It does NOT fabricate anything: every number is a function of the data passed
 * in. On synthetic data it demonstrates the mechanism; on real backend data
 * (transcripts populated from nc_transcript_segments) it yields real metrics.
 *
 * Caption-type coverage (official vs auto vs whisper) is only known when a
 * `transcriptSources` map is supplied (from the backend); otherwise the audit
 * reports available-vs-none and marks the breakdown as backend-required.
 */

import { scoreToxicity } from "./toxicityLexicon";
import type { IngestedData, TranscriptSegment } from "@/lib/dataIngestion";
import type { TalkItemRow } from "@/lib/db/talkCache";

/** A source is "independently negative" at/above this toxicity (mirrors the
 *  engine's spoken-content gate). Documented so reports can state the rule. */
export const SIGNAL_FLAG_THRESHOLD = 0.45;
/** Neutrality ceiling for the speech-only audit. */
export const NEUTRAL_CEILING = 0.4;

export type DiscoverySource =
  | "TITLE_ONLY"
  | "COMMENT_ONLY"
  | "TRANSCRIPT_ONLY"
  | "TITLE_AND_TRANSCRIPT"
  | "COMMENT_AND_TRANSCRIPT"
  | "TITLE_AND_COMMENT"
  | "TITLE_COMMENT_TRANSCRIPT";

export type TranscriptAvailability =
  | "official_caption"
  | "auto_caption"
  | "whisper"
  | "none";

export interface VideoSignals {
  videoId: string;
  channelKey: string;
  channelTitle: string;
  title: string;
  titleTox: number;
  commentTox: number;
  transcriptTox: number;
  hasTranscript: boolean;
  titleFlag: boolean;
  commentFlag: boolean;
  transcriptFlag: boolean;
  flagged: boolean;
  discoverySource: DiscoverySource | null;
  /** strongest spoken segment, for transcript-only evidence. */
  topSegment?: { start: number; text: string; tox: number };
}

function slugKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function meanCommentTox(comments: TalkItemRow[]): number {
  if (comments.length === 0) return 0;
  return comments.reduce((s, c) => s + scoreToxicity(c.text).score, 0) / comments.length;
}

function peakSegment(segments: TranscriptSegment[]): { start: number; text: string; tox: number } | undefined {
  let best: { start: number; text: string; tox: number } | undefined;
  for (const s of segments) {
    const tox = scoreToxicity(s.text).score;
    if (!best || tox > best.tox) best = { start: s.start, text: s.text, tox };
  }
  return best;
}

function classify(titleFlag: boolean, commentFlag: boolean, transcriptFlag: boolean): DiscoverySource | null {
  if (!titleFlag && !commentFlag && !transcriptFlag) return null;
  if (titleFlag && commentFlag && transcriptFlag) return "TITLE_COMMENT_TRANSCRIPT";
  if (titleFlag && transcriptFlag) return "TITLE_AND_TRANSCRIPT";
  if (commentFlag && transcriptFlag) return "COMMENT_AND_TRANSCRIPT";
  if (titleFlag && commentFlag) return "TITLE_AND_COMMENT";
  if (transcriptFlag) return "TRANSCRIPT_ONLY";
  if (titleFlag) return "TITLE_ONLY";
  return "COMMENT_ONLY";
}

/** Per-video signal extraction + discovery-source classification. */
export function extractSignals(data: IngestedData): VideoSignals[] {
  const commentsByVideo = new Map<string, TalkItemRow[]>();
  for (const c of data.talkItems) {
    const arr = commentsByVideo.get(c.videoId) ?? [];
    arr.push(c);
    commentsByVideo.set(c.videoId, arr);
  }

  return data.videos.map((v) => {
    const comments = commentsByVideo.get(v.id) ?? [];
    const segments = data.transcripts?.[v.id] ?? [];
    const titleTox = scoreToxicity(v.title).score;
    const commentTox = meanCommentTox(comments);
    const top = peakSegment(segments);
    const transcriptTox = top?.tox ?? 0;
    const hasTranscript = segments.length > 0;

    const titleFlag = titleTox >= SIGNAL_FLAG_THRESHOLD;
    const commentFlag = commentTox >= SIGNAL_FLAG_THRESHOLD;
    const transcriptFlag = hasTranscript && transcriptTox >= SIGNAL_FLAG_THRESHOLD;
    const discoverySource = classify(titleFlag, commentFlag, transcriptFlag);

    return {
      videoId: v.id,
      channelKey: slugKey(v.channelTitle),
      channelTitle: v.channelTitle,
      title: v.title,
      titleTox: round(titleTox),
      commentTox: round(commentTox),
      transcriptTox: round(transcriptTox),
      hasTranscript,
      titleFlag,
      commentFlag,
      transcriptFlag,
      flagged: discoverySource !== null,
      discoverySource,
      topSegment: top,
    };
  });
}

function round(n: number): number {
  return parseFloat(n.toFixed(3));
}

// ── Report builders ──────────────────────────────────────────────────────────

export interface CoverageReport {
  totalVideos: number;
  withTranscript: number;
  withoutTranscript: number;
  transcriptCoveragePct: number;
  // Only populated when transcriptSources is supplied (backend).
  byType?: Record<TranscriptAvailability, number>;
  byTypePct?: Record<TranscriptAvailability, number>;
  captionTypeKnown: boolean;
}

export function transcriptCoverageReport(
  data: IngestedData,
  transcriptSources?: Record<string, TranscriptAvailability>,
): CoverageReport {
  const total = data.videos.length;
  let withT = 0;
  const byType: Record<TranscriptAvailability, number> = {
    official_caption: 0, auto_caption: 0, whisper: 0, none: 0,
  };
  for (const v of data.videos) {
    const has = (data.transcripts?.[v.id]?.length ?? 0) > 0;
    if (has) withT++;
    if (transcriptSources) {
      byType[transcriptSources[v.id] ?? "none"]++;
    }
  }
  const pct = (n: number) => (total ? parseFloat(((n / total) * 100).toFixed(1)) : 0);
  const report: CoverageReport = {
    totalVideos: total,
    withTranscript: withT,
    withoutTranscript: total - withT,
    transcriptCoveragePct: pct(withT),
    captionTypeKnown: !!transcriptSources,
  };
  if (transcriptSources) {
    report.byType = byType;
    report.byTypePct = {
      official_caption: pct(byType.official_caption),
      auto_caption: pct(byType.auto_caption),
      whisper: pct(byType.whisper),
      none: pct(byType.none),
    };
  }
  return report;
}

export interface DiscoverySourceReport {
  totalFlagged: number;
  bySource: Record<DiscoverySource, number>;
  titleDriven: number;        // would flag on title alone
  transcriptDriven: number;   // flagged & needs transcript (title wouldn't catch)
  transcriptOnly: number;     // flagged ONLY by transcript
  missedByTitleOnly: number;  // flagged & title would NOT catch (the primary question)
  combined: number;
}

export function discoverySourceReport(signals: VideoSignals[]): DiscoverySourceReport {
  const flagged = signals.filter((s) => s.flagged);
  const bySource = {
    TITLE_ONLY: 0, COMMENT_ONLY: 0, TRANSCRIPT_ONLY: 0,
    TITLE_AND_TRANSCRIPT: 0, COMMENT_AND_TRANSCRIPT: 0,
    TITLE_AND_COMMENT: 0, TITLE_COMMENT_TRANSCRIPT: 0,
  } as Record<DiscoverySource, number>;
  for (const s of flagged) if (s.discoverySource) bySource[s.discoverySource]++;

  return {
    totalFlagged: flagged.length,
    bySource,
    titleDriven: flagged.filter((s) => s.titleFlag).length,
    transcriptDriven: flagged.filter((s) => s.transcriptFlag && !s.titleFlag).length,
    transcriptOnly: bySource.TRANSCRIPT_ONLY,
    missedByTitleOnly: flagged.filter((s) => !s.titleFlag).length,
    combined:
      bySource.TITLE_AND_TRANSCRIPT +
      bySource.COMMENT_AND_TRANSCRIPT +
      bySource.TITLE_AND_COMMENT +
      bySource.TITLE_COMMENT_TRANSCRIPT,
  };
}

export interface TranscriptOnlyChannelRow {
  channelKey: string;
  channelTitle: string;
  videoId: string;
  title: string;
  timestamp: number;
  transcriptSnippet: string;
  transcriptTox: number;
}

/** Channels that would NOT be flagged at all if transcript intelligence were
 *  removed (every flagged video is transcript-driven, no title/comment flag). */
export function transcriptOnlyChannelReport(signals: VideoSignals[]): {
  channels: string[];
  rows: TranscriptOnlyChannelRow[];
} {
  const byChannel = new Map<string, VideoSignals[]>();
  for (const s of signals) {
    if (!s.flagged) continue;
    const arr = byChannel.get(s.channelKey) ?? [];
    arr.push(s);
    byChannel.set(s.channelKey, arr);
  }
  const channels: string[] = [];
  const rows: TranscriptOnlyChannelRow[] = [];
  for (const [key, vids] of byChannel) {
    const anyTitleOrComment = vids.some((v) => v.titleFlag || v.commentFlag);
    if (anyTitleOrComment) continue; // would still be flagged without transcripts
    channels.push(key);
    for (const v of vids) {
      if (v.topSegment) {
        rows.push({
          channelKey: key,
          channelTitle: v.channelTitle,
          videoId: v.videoId,
          title: v.title,
          timestamp: v.topSegment.start,
          transcriptSnippet: v.topSegment.text,
          transcriptTox: round(v.topSegment.tox),
        });
      }
    }
  }
  return { channels, rows };
}

export interface SpeechOnlyReport {
  count: number;
  percentOfFlagged: number;
  channelsAffected: number;
  examples: TranscriptOnlyChannelRow[];
}

/** Videos with neutral title AND neutral comments but a negative transcript. */
export function speechOnlyReport(signals: VideoSignals[]): SpeechOnlyReport {
  const flagged = signals.filter((s) => s.flagged);
  const speechOnly = signals.filter(
    (s) =>
      s.transcriptFlag &&
      s.titleTox < NEUTRAL_CEILING &&
      s.commentTox < NEUTRAL_CEILING,
  );
  const channels = new Set(speechOnly.map((s) => s.channelKey));
  return {
    count: speechOnly.length,
    percentOfFlagged: flagged.length
      ? parseFloat(((speechOnly.length / flagged.length) * 100).toFixed(1))
      : 0,
    channelsAffected: channels.size,
    examples: speechOnly
      .filter((s) => s.topSegment)
      .slice(0, 25)
      .map((s) => ({
        channelKey: s.channelKey, channelTitle: s.channelTitle, videoId: s.videoId,
        title: s.title, timestamp: s.topSegment!.start,
        transcriptSnippet: s.topSegment!.text, transcriptTox: round(s.topSegment!.tox),
      })),
  };
}

export interface TitleVsTranscriptReport {
  comparisons: {
    videoId: string;
    titleRisk: number;        // titleTox*100
    transcriptRisk: number;   // transcriptTox*100
    delta: number;
  }[];
  falseNegativesPrevented: number; // transcript caught what title missed
  falsePositiveCandidates: number; // title-flagged but no transcript support
  avgDelta: number;
}

export function titleVsTranscriptReport(signals: VideoSignals[]): TitleVsTranscriptReport {
  const flagged = signals.filter((s) => s.flagged);
  const comparisons = flagged.map((s) => ({
    videoId: s.videoId,
    titleRisk: round(s.titleTox * 100),
    transcriptRisk: round(s.transcriptTox * 100),
    delta: round((s.transcriptTox - s.titleTox) * 100),
  }));
  const falseNegativesPrevented = flagged.filter(
    (s) => s.transcriptFlag && !s.titleFlag,
  ).length;
  const falsePositiveCandidates = flagged.filter(
    (s) => s.titleFlag && s.hasTranscript && s.transcriptTox < NEUTRAL_CEILING,
  ).length;
  const avgDelta = comparisons.length
    ? round(comparisons.reduce((a, c) => a + c.delta, 0) / comparisons.length)
    : 0;
  return { comparisons, falseNegativesPrevented, falsePositiveCandidates, avgDelta };
}

export interface FalsePositiveReport {
  candidates: {
    videoId: string;
    channelTitle: string;
    title: string;
    titleTox: number;
    hasTranscript: boolean;
    transcriptTox: number;
    reason: string;
  }[];
  count: number;
}

/** Flagged primarily by a sensational title with NO supporting transcript. */
export function falsePositiveReport(signals: VideoSignals[]): FalsePositiveReport {
  const candidates = signals
    .filter((s) => s.flagged && s.titleFlag && !s.transcriptFlag)
    .map((s) => ({
      videoId: s.videoId,
      channelTitle: s.channelTitle,
      title: s.title,
      titleTox: s.titleTox,
      hasTranscript: s.hasTranscript,
      transcriptTox: s.transcriptTox,
      reason: s.hasTranscript
        ? "title-flagged; transcript present but not negative"
        : "title-flagged; no transcript available to corroborate",
    }));
  return { candidates, count: candidates.length };
}

// ── Readiness assessment (Phase 10) ─────────────────────────────────────────

export interface ReadinessAssessment {
  level: 1 | 2 | 3 | 4 | 5;
  label: string;
  transcriptCoveragePct: number;
  transcriptDrivenShare: number; // % of flagged that needed transcript
  justification: string;
  gaps: string[];
}

export function readinessAssessment(
  coverage: CoverageReport,
  discovery: DiscoverySourceReport,
): ReadinessAssessment {
  const share =
    discovery.totalFlagged > 0
      ? parseFloat(((discovery.transcriptDriven / discovery.totalFlagged) * 100).toFixed(1))
      : 0;

  // Level logic is conservative and evidence-based.
  let level: ReadinessAssessment["level"] = 1;
  if (coverage.totalVideos > 0) level = 2; // title+comment baseline present
  if (coverage.withTranscript > 0 && share > 0) level = 3; // transcript-assisted
  if (coverage.transcriptCoveragePct >= 50 && share >= 30) level = 4; // transcript-first
  if (coverage.transcriptCoveragePct >= 70 && share >= 50) level = 5; // full platform

  const labels = {
    1: "Title Intelligence",
    2: "Title + Comment Intelligence",
    3: "Transcript-Assisted Intelligence",
    4: "Transcript-First Narrative Intelligence",
    5: "Full Narrative Intelligence Platform",
  } as const;

  const gaps: string[] = [];
  if (coverage.transcriptCoveragePct < 70)
    gaps.push(`transcript coverage ${coverage.transcriptCoveragePct}% (<70% target)`);
  if (share < 50)
    gaps.push(`transcript-driven discoveries ${share}% of flagged (<50% target)`);
  if (!coverage.captionTypeKnown)
    gaps.push("caption-type breakdown requires backend nc_transcript_segments.source");

  return {
    level,
    label: labels[level],
    transcriptCoveragePct: coverage.transcriptCoveragePct,
    transcriptDrivenShare: share,
    justification:
      `${discovery.transcriptDriven}/${discovery.totalFlagged} flagged videos needed ` +
      `transcript signal (${share}%); ${coverage.withTranscript}/${coverage.totalVideos} ` +
      `videos had transcripts (${coverage.transcriptCoveragePct}%).`,
    gaps,
  };
}

/** One-shot: compute every report from IngestedData. */
export function runFullAudit(
  data: IngestedData,
  transcriptSources?: Record<string, TranscriptAvailability>,
) {
  const signals = extractSignals(data);
  const coverage = transcriptCoverageReport(data, transcriptSources);
  const discovery = discoverySourceReport(signals);
  return {
    signals,
    coverage,
    discovery,
    transcriptOnlyChannels: transcriptOnlyChannelReport(signals),
    speechOnly: speechOnlyReport(signals),
    titleVsTranscript: titleVsTranscriptReport(signals),
    falsePositives: falsePositiveReport(signals),
    readiness: readinessAssessment(coverage, discovery),
  };
}

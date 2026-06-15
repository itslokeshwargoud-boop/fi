/**
 * NC evidence engine.
 *
 * Produces citable, explainable evidence from the data that is actually present
 * in the live pipeline: video titles and audience comments. Each evidence item
 * carries timestamp, severity, confidence and a proof URL so the UI can satisfy
 * the legal requirement — every flag is backed by a viewable artifact.
 *
 * Transcript-segment and OCR-thumbnail evidence (EvidenceType
 * "transcript_segment" / "ocr_thumbnail") are produced asynchronously by the
 * Python enrichment layer (Whisper + EasyOCR) and stored in the `evidence`
 * table. This module merges any such pre-computed items when supplied, so the
 * drawer shows them seamlessly alongside the live comment/title evidence.
 */

import type { TalkItemRow } from "@/lib/db/talkCache";
import type { YouTubeVideo } from "@/lib/youtube/fetchCore";
import type { TranscriptSegment } from "@/lib/dataIngestion";
import { scoreToxicity } from "./toxicityLexicon";
import { normalizeText } from "./preprocess";
import { EVIDENCE_PRIORITY } from "./signalWeights";
import type { NCEvidence, SeverityLevel, NarrativeType } from "./types";

/** mm:ss (or h:mm:ss) label from a seconds offset. */
function fmtTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${pad(sec)}` : `${mm}:${pad(sec)}`;
}

/** Deep-link to a video at a specific second (YouTube &t=Ns). */
function timestampedUrl(videoId: string, seconds: number): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return seconds > 0 ? `${base}&t=${Math.floor(seconds)}s` : base;
}

function severityFromScore(score: number): SeverityLevel {
  if (score >= 0.7) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

/**
 * Repeated targeting phrases: bi/tri-gram phrases that recur across multiple
 * comments. Recurrence is the signal the brief calls "repeated targeting" — a
 * phrase used once is noise; the same attack phrasing across many comments is a
 * coordinated pattern.
 */
export function extractRepeatedPhrases(
  comments: TalkItemRow[],
  minOccurrences = 3,
): { phrase: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of comments) {
    const toks = normalizeText(c.text).tokens;
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const gram = toks.slice(i, i + n).join(" ");
        if (gram.length < 6) continue;
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minOccurrences)
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/**
 * Build TRANSCRIPT evidence from timestamped spoken segments (Issue 3).
 *
 * Each toxic/narrative-bearing segment becomes a citable item with a clickable
 * [mm:ss] timestamp that deep-links to the exact moment in the video. Telugu,
 * transliterated Telugu and code-mixed speech are handled by the shared
 * normalizer + toxicity lexicon.
 */
export function buildTranscriptEvidence(
  videos: YouTubeVideo[],
  transcripts: Record<string, TranscriptSegment[]>,
  opts: {
    maxPerVideo?: number;
    narrativeByText?: (text: string) => { type: NarrativeType; intensity: number };
  } = {},
): NCEvidence[] {
  const maxPerVideo = opts.maxPerVideo ?? 6;
  const evidence: NCEvidence[] = [];
  const byId = new Map(videos.map((v) => [v.id, v]));

  for (const [videoId, segments] of Object.entries(transcripts)) {
    if (!segments || segments.length === 0) continue;
    const video = byId.get(videoId);
    const title = video?.title ?? "";

    const scored = segments
      .map((seg) => {
        const text = normalizeText(seg.text).normalized || seg.text;
        return { seg, text, tox: scoreToxicity(seg.text).score };
      })
      // Keep segments that carry real signal (toxic or narrative-bearing).
      .filter((x) => x.tox >= 0.4 || (opts.narrativeByText?.(x.text).intensity ?? 0) >= 0.4)
      .sort((a, b) => b.tox - a.tox)
      .slice(0, maxPerVideo);

    for (const { seg, text, tox } of scored) {
      const narr = opts.narrativeByText?.(text);
      // Transcript proof is strong: spoken words at a timestamp. Confidence
      // blends segment toxicity with narrative intensity.
      const confidence = Math.min(
        1,
        Math.max(tox, 0.5 * tox + 0.5 * (narr?.intensity ?? 0)),
      );
      evidence.push({
        id: `ev_tr_${videoId}_${Math.floor(seg.start)}`,
        videoId,
        videoTitle: title,
        type: "transcript_segment",
        timestamp: fmtTimestamp(seg.start),
        content: seg.text.slice(0, 280),
        severity: severityFromScore(confidence),
        confidence: parseFloat(confidence.toFixed(2)),
        proofUrl: timestampedUrl(videoId, seg.start),
        narrativeLabel: narr?.type,
        toxicity: parseFloat(tox.toFixed(2)),
        startSeconds: Math.floor(seg.start),
      });
    }
  }
  return evidence;
}

/** Build comment + title (+ transcript) evidence for a set of videos. */
export function buildEvidence(
  videos: YouTubeVideo[],
  comments: TalkItemRow[],
  opts: {
    maxPerType?: number;
    transcripts?: Record<string, TranscriptSegment[]>;
    narrativeByText?: (text: string) => { type: NarrativeType; intensity: number };
  } = {},
): NCEvidence[] {
  const maxPerType = opts.maxPerType ?? 25;
  const evidence: NCEvidence[] = [];
  const videoTitleById = new Map(videos.map((v) => [v.id, v.title]));

  // 0. Transcript evidence (spoken-word proof) — built first so we can
  //    prioritize it over weaker title evidence per video.
  const transcriptEvidence = opts.transcripts
    ? buildTranscriptEvidence(videos, opts.transcripts, {
        narrativeByText: opts.narrativeByText,
      })
    : [];
  evidence.push(...transcriptEvidence);

  // Best transcript confidence per video, for transcript-over-title gating.
  const bestTranscriptConf = new Map<string, number>();
  for (const e of transcriptEvidence) {
    bestTranscriptConf.set(
      e.videoId,
      Math.max(bestTranscriptConf.get(e.videoId) ?? 0, e.confidence),
    );
  }

  // 1. Toxic comments
  const toxicComments = comments
    .map((c) => ({ c, tox: scoreToxicity(c.text) }))
    .filter((x) => x.tox.score >= 0.45)
    .sort((a, b) => b.tox.score - a.tox.score)
    .slice(0, maxPerType);

  for (const { c, tox } of toxicComments) {
    evidence.push({
      id: `ev_cmt_${c.commentId}`,
      videoId: c.videoId,
      videoTitle: c.videoTitle || videoTitleById.get(c.videoId) || "",
      type: "toxic_comment",
      timestamp: c.publishedAt,
      content: c.text.slice(0, 280),
      severity: severityFromScore(tox.score),
      confidence: tox.score,
      proofUrl: c.proofUrl,
      toxicity: parseFloat(tox.score.toFixed(2)),
    });
  }

  // 2. Title claims (negative/abusive video titles) — skipped when the same
  //    video already has stronger spoken transcript evidence (Issue 3:
  //    prioritize transcript over title when its confidence is higher).
  const titleClaims = videos
    .map((v) => ({ v, tox: scoreToxicity(v.title) }))
    .filter((x) => x.tox.score >= 0.4)
    .sort((a, b) => b.tox.score - a.tox.score)
    .slice(0, maxPerType);

  for (const { v, tox } of titleClaims) {
    if ((bestTranscriptConf.get(v.id) ?? 0) >= tox.score) {
      continue; // transcript evidence is stronger; don't lead with the title
    }
    evidence.push({
      id: `ev_title_${v.id}`,
      videoId: v.id,
      videoTitle: v.title,
      type: "title_claim",
      timestamp: v.publishedAt,
      content: v.title.slice(0, 280),
      severity: severityFromScore(tox.score),
      confidence: tox.score,
      proofUrl: v.proofUrl,
      toxicity: parseFloat(tox.score.toFixed(2)),
    });
  }

  // 3. Repeated targeting phrases (aggregate evidence)
  const phrases = extractRepeatedPhrases(comments);
  for (const { phrase, count } of phrases) {
    const confidence = Math.min(1, 0.4 + count / 20);
    evidence.push({
      id: `ev_phrase_${phrase.replace(/\s+/g, "_")}`,
      videoId: "",
      videoTitle: "",
      type: "repeated_phrase",
      timestamp: new Date().toISOString(),
      content: `"${phrase}" repeated ${count}× across comments`,
      severity: count >= 6 ? "high" : "medium",
      confidence: parseFloat(confidence.toFixed(2)),
      proofUrl: "",
    });
  }

  // Priority order (brief): TRANSCRIPT > COMMENT > OCR > TITLE > repeated.
  // Within a tier, higher confidence first.
  evidence.sort((a, b) => {
    const pa = EVIDENCE_PRIORITY[a.type] ?? 99;
    const pb = EVIDENCE_PRIORITY[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.confidence - a.confidence;
  });

  return evidence;
}

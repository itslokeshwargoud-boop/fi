/**
 * NC — Narrative Control / Negative Channels Intelligence
 * Shared type contracts for the NC processing layer and UI.
 *
 * These types are the single source of truth shared by:
 *   - the TS intelligence engine (lib/nc/*)
 *   - the Next.js API routes (pages/api/.../nc/*)
 *   - the React hook + components (hooks/useNc.ts, components/reputation-os/nc/*)
 *
 * IMPORTANT (legal): the UI must never assert that a channel "spreads lies".
 * Every surfaced judgement is framed as an AI-detected *pattern* and is always
 * paired with a confidence score and underlying evidence. See evidenceEngine.ts.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Coarse narrative families detected by the semantic clusterer. */
export type NarrativeType =
  | "controversy_amplification"
  | "troll_targeting"
  | "fan_war"
  | "harassment"
  | "authenticity_attack" // e.g. "fake singer", "lip sync", "paid"
  | "industry_politics"
  | "overaction_criticism"
  | "other";

export type EvidenceType =
  | "transcript_segment"
  | "ocr_thumbnail"
  | "toxic_comment"
  | "repeated_phrase"
  | "title_claim";

export type SeverityLevel = "low" | "medium" | "high";

/**
 * A single, citable piece of evidence behind a flag. `timestamp` is a media
 * position string ("02:14") when the evidence is a transcript segment, otherwise
 * an ISO datetime for the source item. `confidence` is 0..1.
 */
export interface NCEvidence {
  id: string;
  videoId: string;
  videoTitle: string;
  type: EvidenceType;
  /** "02:14" for transcript segments; ISO string for comments/titles. */
  timestamp: string;
  /** Verbatim (already-normalized) snippet shown to the analyst. */
  content: string;
  severity: SeverityLevel;
  /** 0..1 model/heuristic confidence. */
  confidence: number;
  proofUrl: string;
  /** Narrative family this evidence supports (transcript/title evidence). */
  narrativeLabel?: NarrativeType;
  /** 0..1 toxicity of this specific snippet (transcript/comment evidence). */
  toxicity?: number;
  /** Start offset in seconds for clickable transcript timestamps (deep-link). */
  startSeconds?: number;
}

/** A flagged video belonging to a channel. */
export interface NCFlaggedVideo {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  proofUrl: string;
  publishedAt: string;
  isShort: boolean;
  views: number;
  likes: number;
  comments: number;
  sentimentScore: number; // -1..1 (negative..positive)
  toxicityScore: number; // 0..1
  narrativeType: NarrativeType;
  riskScore: number; // 0..100
  riskLevel: RiskLevel;
}

/** Channel-level intelligence profile (a "negative spreader" candidate). */
export interface NCChannel {
  channelKey: string; // stable grouping key (channelTitle slug)
  channelName: string;
  channelUrl: string;
  riskScore: number; // 0..100
  riskLevel: RiskLevel;
  /** 0..1 confidence in the aggregate channel assessment. */
  confidence: number;
  dominantNarrative: NarrativeType;
  narrativeTypes: NarrativeType[];
  flaggedVideoCount: number;
  totalVideoCount: number;
  /** Estimated negative reach = sum of views on flagged videos. */
  reach: number;
  /** How often this channel re-targets the same subject. */
  repeatedTargetingCount: number;
  /** Amplification 0..100 — burst uploads + shorts farming + reposting. */
  amplificationScore: number;
  /** Audience toxicity 0..1 derived from comments on the channel's videos. */
  audienceToxicity: number;
  shortsCount: number;
  lastActive: string; // ISO
}

export interface NCNarrativeCluster {
  id: string;
  label: string;
  type: NarrativeType;
  /** Number of items (videos + comments) grouped into this narrative. */
  size: number;
  /** Share of all flagged items, 0..100. */
  percentage: number;
  /** -1..1 average sentiment of the cluster. */
  sentiment: number;
  /** 0..1 average toxicity of the cluster. */
  toxicity: number;
  trend: "growing" | "stable" | "declining";
  /** Top terms that define the cluster (for explainability). */
  keyTerms: string[];
  sampleTexts: string[];
  relatedChannels: string[];
}

export interface NCTimelinePoint {
  date: string; // YYYY-MM-DD
  flaggedVideos: number;
  toxicity: number; // 0..1 avg that day
  threatVelocity: number; // rate of change vs previous bucket
}

export interface NCShort {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  proofUrl: string;
  publishedAt: string;
  views: number;
  /** Detected repost/clip-farm burst membership. */
  burstId: string | null;
  riskLevel: RiskLevel;
  narrativeType: NarrativeType;
}

export interface NCMetrics {
  negativeVideosFound: number;
  highRiskChannels: number; // HIGH + CRITICAL
  narrativeClusters: number;
  toxicityScore: number; // 0..100 aggregate
  threatVelocity: number; // signed % change in flagged volume
  amplificationScore: number; // 0..100 aggregate
}

/** Full-scale ingestion / processing metrics so cards reflect total volume. */
export interface NCProcessingMeta {
  mode: "single_page" | "deep";
  collected: number;        // videos returned by the collector
  analyzed: number;         // videos NC actually scored (== in-window)
  flagged: number;          // videos surfaced as negative-narrative signal
  skipped: number;          // out-of-window / dropped before analysis
  withTranscript: number;   // analyzed videos that had transcript evidence
  dateWindow?: { startDate: string; endDate: string } | null;
}

/** Top-level NC intelligence payload assembled by ncEngine. */
export interface NCIntelligence {
  keyword: string;
  metrics: NCMetrics;
  channels: NCChannel[];
  narratives: NCNarrativeCluster[];
  timeline: NCTimelinePoint[];
  shorts: NCShort[];
  generatedAt: string;
  processing?: NCProcessingMeta;
}

/** Full evidence bundle for a single channel (drawer payload). */
export interface NCChannelEvidence {
  channel: NCChannel;
  flaggedVideos: NCFlaggedVideo[];
  evidence: NCEvidence[];
  narrativeTimeline: NCTimelinePoint[];
  shorts: NCShort[];
  riskBreakdown: {
    sentiment: number;
    toxicity: number;
    narrativeIntensity: number;
    virality: number;
    repeatedTargeting: number;
  };
}

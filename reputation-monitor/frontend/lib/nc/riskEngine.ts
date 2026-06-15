/**
 * NC risk engine — configurable weighted scoring.
 *
 * Two scorers:
 *   - scoreVideoRisk: per-video 0..100 from sentiment, toxicity, narrative
 *     intensity, virality, repeated targeting.
 *   - scoreChannelRisk: aggregates a channel's flagged videos + audience
 *     toxicity + shorts amplification + narrative repetition.
 *
 * Weights are centralized in RISK_WEIGHTS so they can be tuned (or loaded from
 * config) without touching call sites. Levels are derived from thresholds.
 */

import type { RiskLevel } from "./types";

export interface VideoRiskWeights {
  sentiment: number; // contribution of negativity
  toxicity: number;
  narrativeIntensity: number;
  virality: number;
  repeatedTargeting: number;
}

export interface ChannelRiskWeights {
  flaggedRatio: number;
  avgVideoRisk: number;
  audienceToxicity: number;
  amplification: number;
  narrativeRepetition: number;
}

export const RISK_WEIGHTS: {
  video: VideoRiskWeights;
  channel: ChannelRiskWeights;
} = {
  video: {
    sentiment: 0.2,
    toxicity: 0.3,
    narrativeIntensity: 0.2,
    virality: 0.15,
    repeatedTargeting: 0.15,
  },
  channel: {
    flaggedRatio: 0.25,
    avgVideoRisk: 0.3,
    audienceToxicity: 0.2,
    amplification: 0.15,
    narrativeRepetition: 0.1,
  },
};

export interface VideoRiskInput {
  /** -1..1, lower = more negative. */
  sentiment: number;
  /** 0..1 */
  toxicity: number;
  /** 0..1 strength of negative narrative membership. */
  narrativeIntensity: number;
  /** raw view count (log-scaled internally). */
  views: number;
  /** how many times the channel has targeted this subject (count). */
  repeatedTargeting: number;
}

function levelFromScore(score: number): RiskLevel {
  if (score >= 75) return "CRITICAL";
  if (score >= 55) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

/** Log-scale virality into 0..1 (1M+ views ≈ 1.0). */
function viralityFactor(views: number): number {
  if (views <= 0) return 0;
  return Math.min(1, Math.log10(views + 1) / 6);
}

/** Map repeated targeting count into 0..1 (saturates ~8 repeats). */
function repeatFactor(count: number): number {
  return Math.min(1, count / 8);
}

export function scoreVideoRisk(
  input: VideoRiskInput,
  weights: VideoRiskWeights = RISK_WEIGHTS.video,
): { score: number; level: RiskLevel } {
  // negativity: map sentiment -1..1 → 1..0 (negative = high risk)
  const negativity = (1 - (input.sentiment + 1) / 2);
  const components =
    negativity * weights.sentiment +
    input.toxicity * weights.toxicity +
    input.narrativeIntensity * weights.narrativeIntensity +
    viralityFactor(input.views) * weights.virality +
    repeatFactor(input.repeatedTargeting) * weights.repeatedTargeting;

  const score = parseFloat((Math.min(1, components) * 100).toFixed(1));
  return { score, level: levelFromScore(score) };
}

export interface ChannelRiskInput {
  flaggedRatio: number; // 0..1 flagged/total videos
  avgVideoRisk: number; // 0..100 mean of flagged video risk
  audienceToxicity: number; // 0..1
  amplificationScore: number; // 0..100
  narrativeRepetition: number; // 0..1 (how concentrated into one narrative)
}

export function scoreChannelRisk(
  input: ChannelRiskInput,
  weights: ChannelRiskWeights = RISK_WEIGHTS.channel,
): { score: number; level: RiskLevel } {
  const components =
    input.flaggedRatio * weights.flaggedRatio +
    (input.avgVideoRisk / 100) * weights.avgVideoRisk +
    input.audienceToxicity * weights.audienceToxicity +
    (input.amplificationScore / 100) * weights.amplification +
    input.narrativeRepetition * weights.narrativeRepetition;

  const score = parseFloat((Math.min(1, components) * 100).toFixed(1));
  return { score, level: levelFromScore(score) };
}

export { levelFromScore };

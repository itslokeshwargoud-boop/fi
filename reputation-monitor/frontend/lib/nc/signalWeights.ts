/**
 * NC signal weighting (transcript-primary).
 *
 * The brief makes spoken transcript content the STRONGEST narrative signal.
 * This module centralizes the configurable source weights and the weighted
 * combiner used by the engine so a neutral-title video with highly negative
 * spoken content is still flagged.
 *
 * Default weights (configurable):
 *   transcript 60% · comments 15% · title 10% · description 5% · ocr 5% · channelHistory 5%
 *
 * The combiner renormalizes over the signals that are actually present, so when
 * no transcript exists the remaining sources still produce a sensible score
 * (preserving prior title+comment behaviour) — and when a transcript exists it
 * dominates.
 */

export interface SignalWeights {
  transcript: number;
  comments: number;
  title: number;
  description: number;
  ocr: number;
  channelHistory: number;
}

export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  transcript: 0.6,
  comments: 0.15,
  title: 0.1,
  description: 0.05,
  ocr: 0.05,
  channelHistory: 0.05,
};

export type SignalInputs = Partial<Record<keyof SignalWeights, number>>;

/**
 * Weighted toxicity/negativity over present signals (each 0..1), renormalized
 * by the weights of the signals actually supplied. Returns 0 when none present.
 */
export function weightedToxicity(
  signals: SignalInputs,
  weights: SignalWeights = DEFAULT_SIGNAL_WEIGHTS,
): number {
  let sum = 0;
  let wsum = 0;
  (Object.keys(weights) as (keyof SignalWeights)[]).forEach((k) => {
    const v = signals[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v * weights[k];
      wsum += weights[k];
    }
  });
  return wsum > 0 ? Math.min(1, sum / wsum) : 0;
}

/** Evidence-source priority for ordering the drawer (lower = shown first). */
export const EVIDENCE_PRIORITY: Record<string, number> = {
  transcript_segment: 0,
  toxic_comment: 1,
  ocr_thumbnail: 2,
  title_claim: 3,
  repeated_phrase: 4,
};

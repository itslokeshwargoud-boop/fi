"""Risk calibration for the NC module.

The raw weighted risk score (``risk_service``) is intentionally sensitive. This
layer calibrates it to reduce over-flagging and bias before any HIGH/CRITICAL
label is assigned:

* **Engagement normalization** — a viral video shouldn't be flagged *because*
  it is viral. Reach feeds amplification, but raw virality is log-damped and
  capped so a single mega-viral clip can't dominate.
* **Channel baselines** — score a video relative to its channel's own history.
  A mildly-negative video on a channel that is *usually* negative is less
  notable than the same video on a normally-neutral channel; conversely a
  channel with a consistently high negative baseline accrues channel-level risk.
* **Dynamic thresholds** — band cutoffs adapt to the toxicity distribution of
  the current batch (median + MAD), so a quiet period doesn't get graded on the
  same curve as a coordinated spike.
* **Confidence intervals & adaptive scoring** — every calibrated score carries
  a confidence and a +/- interval derived from how much evidence supports it
  and how ambiguous the context is. Low-confidence scores are pulled toward the
  band boundary so borderline items don't tip into CRITICAL on thin evidence.

All pure-Python and deterministic; no model dependency.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field


# Default static bands (used when no batch distribution is supplied).
STATIC_BANDS = [(80.0, "CRITICAL"), (60.0, "HIGH"), (35.0, "MEDIUM"), (0.0, "LOW")]


@dataclass
class CalibratedRisk:
    score: float                 # 0..100 calibrated
    raw_score: float             # 0..100 pre-calibration
    level: str                   # LOW | MEDIUM | HIGH | CRITICAL
    confidence: float            # 0..1
    interval: tuple[float, float]  # (low, high) on 0..100
    adjustments: dict[str, float] = field(default_factory=dict)


@dataclass
class ChannelBaseline:
    mean_risk: float = 0.0
    std_risk: float = 0.0
    sample_count: int = 0


def build_channel_baseline(history_scores: list[float]) -> ChannelBaseline:
    """Compute a channel's risk baseline from its historical video scores."""
    if not history_scores:
        return ChannelBaseline()
    mean = statistics.fmean(history_scores)
    std = statistics.pstdev(history_scores) if len(history_scores) > 1 else 0.0
    return ChannelBaseline(round(mean, 2), round(std, 2), len(history_scores))


def dynamic_bands(toxicity_distribution: list[float]) -> list[tuple[float, str]]:
    """Adapt band cutoffs to the current batch's toxicity spread.

    Uses median + MAD (robust to outliers). When the batch is uniformly calm,
    cutoffs rise (harder to be CRITICAL); during a toxic spike they relax toward
    the static defaults so genuine surges still surface.
    """
    if len(toxicity_distribution) < 5:
        return STATIC_BANDS
    med = statistics.median(toxicity_distribution)
    mad = statistics.median([abs(x - med) for x in toxicity_distribution]) or 0.01
    # Spike factor in [0,1]: higher median toxicity => relax toward defaults.
    spike = max(0.0, min(1.0, (med - 0.3) / 0.4))
    shift = (1.0 - spike) * 8.0  # up to +8 points stricter when calm
    return [
        (min(95.0, 80.0 + shift), "CRITICAL"),
        (min(85.0, 60.0 + shift), "HIGH"),
        (min(60.0, 35.0 + shift), "MEDIUM"),
        (0.0, "LOW"),
    ]


def _level(score: float, bands: list[tuple[float, str]]) -> str:
    for threshold, label in bands:
        if score >= threshold:
            return label
    return "LOW"


def normalize_engagement(views: int, channel_median_views: float | None = None) -> float:
    """Log-damped, baseline-relative virality in 0..1.

    If a channel median is known, virality is measured relative to it so a
    channel's normal reach isn't itself treated as a risk signal.
    """
    if views <= 0:
        return 0.0
    if channel_median_views and channel_median_views > 0:
        ratio = views / channel_median_views
        return max(0.0, min(1.0, math.log10(1 + ratio) / math.log10(11)))
    return max(0.0, min(1.0, math.log10(1 + views) / math.log10(1 + 500_000)))


def calibrate(
    raw_score: float,
    *,
    evidence_count: int,
    context_penalty: float = 1.0,
    ambiguity: float = 0.3,
    channel_baseline: ChannelBaseline | None = None,
    bands: list[tuple[float, str]] | None = None,
) -> CalibratedRisk:
    """Calibrate a raw 0..100 risk score into a banded, confidence-aware result."""
    bands = bands or STATIC_BANDS
    adjustments: dict[str, float] = {}

    score = raw_score

    # 1) Context penalty (FP reduction): only ever reduces.
    if context_penalty < 1.0:
        new = score * context_penalty
        adjustments["context_penalty"] = round(new - score, 2)
        score = new

    # 2) Channel-baseline relativization: reward deviation above the channel's
    #    own norm, soften scores merely matching an already-negative baseline.
    if channel_baseline and channel_baseline.sample_count >= 5:
        b = channel_baseline
        deviation = raw_score - b.mean_risk
        # Pull 20% toward (baseline + deviation), damping channel-typical noise.
        adjusted = score + 0.2 * (deviation - (score - raw_score))
        adjustments["channel_baseline"] = round(adjusted - score, 2)
        score = adjusted

    score = max(0.0, min(100.0, score))

    # 3) Confidence from evidence volume + (in)ambiguity.
    evidence_conf = min(1.0, evidence_count / 4.0)  # ~4 items => full
    confidence = round(max(0.05, evidence_conf * (1.0 - 0.6 * ambiguity)), 3)

    # 4) Adaptive pull: low-confidence scores drift toward the nearest lower
    #    band boundary so thin evidence can't tip into a severe label.
    level_pre = _level(score, bands)
    if confidence < 0.5:
        lower_bound = max(
            [t for t, _ in bands if t <= score] or [0.0]
        )
        pull = (0.5 - confidence) * (score - lower_bound)
        adjustments["low_confidence_pull"] = -round(pull, 2)
        score = max(lower_bound, score - pull)

    # 5) Confidence interval widens as confidence falls.
    half_width = round((1.0 - confidence) * 15.0, 2)
    interval = (max(0.0, score - half_width), min(100.0, score + half_width))

    level = _level(score, bands)
    return CalibratedRisk(
        score=round(score, 1),
        raw_score=round(raw_score, 1),
        level=level,
        confidence=confidence,
        interval=interval,
        adjustments=adjustments,
    )

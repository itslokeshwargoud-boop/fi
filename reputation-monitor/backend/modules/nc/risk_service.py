"""Risk scoring for the NC module.

Implements the configurable weighted scoring the brief specifies, for both
videos and channels, and maps scores to LOW / MEDIUM / HIGH / CRITICAL bands.

This is pure, deterministic logic (no model dependency) so it always runs and
is fully testable. Weights live in module-level dicts and can be overridden per
call, so the scoring policy is tunable without code changes. The same weighting
philosophy is mirrored in the frontend ``lib/nc/riskEngine.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass

# Video-level weights (must sum to ~1.0). Tunable.
VIDEO_WEIGHTS: dict[str, float] = {
    "sentiment": 0.20,        # how negative the framing is
    "toxicity": 0.30,         # abusive/harassing language
    "narrative_intensity": 0.25,  # strength of negative-narrative match
    "virality": 0.15,         # reach amplifies harm
    "repeated_targeting": 0.10,   # same subject hit again and again
}

# Channel-level weights (must sum to ~1.0). Tunable.
CHANNEL_WEIGHTS: dict[str, float] = {
    "repeated_negative_uploads": 0.30,
    "upload_frequency": 0.15,
    "audience_toxicity": 0.20,
    "shorts_amplification": 0.15,
    "narrative_repetition": 0.20,
}

# Thresholds for band mapping on a 0..100 scale.
BANDS = [
    (80.0, "CRITICAL"),
    (60.0, "HIGH"),
    (35.0, "MEDIUM"),
    (0.0, "LOW"),
]


def level_from_score(score: float) -> str:
    for threshold, label in BANDS:
        if score >= threshold:
            return label
    return "LOW"


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


@dataclass
class VideoRiskInput:
    negative_sentiment: float   # 0..1 (1 = fully negative)
    toxicity: float             # 0..1
    narrative_intensity: float  # 0..1
    virality: float             # 0..1 (normalized reach/velocity)
    repeated_targeting: float   # 0..1


@dataclass
class ChannelRiskInput:
    repeated_negative_uploads: float  # 0..1
    upload_frequency: float           # 0..1
    audience_toxicity: float          # 0..1
    shorts_amplification: float       # 0..1
    narrative_repetition: float       # 0..1


def score_video(inp: VideoRiskInput, weights: dict[str, float] | None = None) -> float:
    """Return a 0..100 video risk score."""
    w = weights or VIDEO_WEIGHTS
    raw = (
        w["sentiment"] * _clamp01(inp.negative_sentiment)
        + w["toxicity"] * _clamp01(inp.toxicity)
        + w["narrative_intensity"] * _clamp01(inp.narrative_intensity)
        + w["virality"] * _clamp01(inp.virality)
        + w["repeated_targeting"] * _clamp01(inp.repeated_targeting)
    )
    return round(raw * 100.0, 1)


def score_channel(
    inp: ChannelRiskInput, weights: dict[str, float] | None = None
) -> float:
    """Return a 0..100 channel risk score aggregating its behaviour."""
    w = weights or CHANNEL_WEIGHTS
    raw = (
        w["repeated_negative_uploads"] * _clamp01(inp.repeated_negative_uploads)
        + w["upload_frequency"] * _clamp01(inp.upload_frequency)
        + w["audience_toxicity"] * _clamp01(inp.audience_toxicity)
        + w["shorts_amplification"] * _clamp01(inp.shorts_amplification)
        + w["narrative_repetition"] * _clamp01(inp.narrative_repetition)
    )
    return round(raw * 100.0, 1)


def normalize_virality(views: int, reference: int = 500_000) -> float:
    """Log-scaled virality 0..1 so a few mega-viral videos don't dominate."""
    import math

    if views <= 0:
        return 0.0
    return _clamp01(math.log10(1 + views) / math.log10(1 + reference))

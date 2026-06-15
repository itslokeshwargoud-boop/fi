"""Channel intelligence aggregation for the NC module.

Rolls per-video signals up into a channel-level intelligence profile: aggregate
risk, repeated-targeting count, narrative repetition, shorts amplification and
estimated negative reach. Persists/updates the :class:`NCChannel` row.

Pure aggregation logic over already-scored videos — deterministic and always
available. Heavy model work happens upstream in the per-video pipeline.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from modules.nc.risk_service import (
    ChannelRiskInput,
    score_channel,
    level_from_score,
)


@dataclass
class VideoSignal:
    risk_score: float          # 0..100
    toxicity: float            # 0..1
    narrative_label: str | None
    views: int
    is_short: bool
    is_negative: bool


@dataclass
class ChannelProfile:
    avg_risk_score: float
    risk_level: str
    repeated_targeting_count: int
    negative_reach_score: float
    dominant_narrative: str
    narrative_repetition: float
    shorts_amplification: float
    audience_toxicity: float
    flagged_video_count: int
    total_video_count: int


def build_channel_profile(
    videos: list[VideoSignal], subject_terms: list[str] | None = None
) -> ChannelProfile:
    total = len(videos)
    if total == 0:
        return ChannelProfile(
            0.0, "LOW", 0, 0.0, "general_negative", 0.0, 0.0, 0.0, 0, 0
        )

    negatives = [v for v in videos if v.is_negative]
    flagged = len(negatives)
    shorts = [v for v in videos if v.is_short]

    # Repeated targeting: how many negative videos beyond the first (re-hits).
    repeated_targeting_count = max(0, flagged - 1)

    # Narrative repetition: share of the single most common narrative label.
    labels = Counter(v.narrative_label for v in negatives if v.narrative_label)
    if labels:
        dominant_narrative, top_count = labels.most_common(1)[0]
        narrative_repetition = top_count / max(1, flagged)
    else:
        dominant_narrative, narrative_repetition = "general_negative", 0.0

    # Shorts amplification: how much of the negative output is shorts (fast repost).
    neg_shorts = sum(1 for v in shorts if v.is_negative)
    shorts_amplification = neg_shorts / max(1, flagged) if flagged else 0.0

    # Audience toxicity proxy: mean toxicity across negative videos.
    audience_toxicity = (
        sum(v.toxicity for v in negatives) / flagged if flagged else 0.0
    )

    # Upload frequency proxy: negatives relative to total output.
    upload_frequency = flagged / total

    # Estimated negative reach = views on flagged videos (log-damped at API layer).
    negative_reach_score = float(sum(v.views for v in negatives))

    channel_risk = score_channel(
        ChannelRiskInput(
            repeated_negative_uploads=min(1.0, flagged / max(1, total)),
            upload_frequency=upload_frequency,
            audience_toxicity=audience_toxicity,
            shorts_amplification=shorts_amplification,
            narrative_repetition=narrative_repetition,
        )
    )

    return ChannelProfile(
        avg_risk_score=channel_risk,
        risk_level=level_from_score(channel_risk),
        repeated_targeting_count=repeated_targeting_count,
        negative_reach_score=negative_reach_score,
        dominant_narrative=dominant_narrative,
        narrative_repetition=round(narrative_repetition, 4),
        shorts_amplification=round(shorts_amplification, 4),
        audience_toxicity=round(audience_toxicity, 4),
        flagged_video_count=flagged,
        total_video_count=total,
    )

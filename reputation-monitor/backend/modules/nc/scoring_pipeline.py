"""Unified scoring pipeline for the NC module.

Single entry point that composes every layer into one explainable, calibrated,
legally-gated assessment for a video:

    raw signals
      -> sentiment (XLM-R or valence fallback)         [5 dimensions]
      -> unified toxicity (Detoxify + lexicon + audience)
      -> narrative intensity (embeddings/TF-IDF)
      -> context classification (FP reduction)          [penalty]
      -> weighted risk (risk_service)
      -> calibration (engagement/baseline/dynamic bands/confidence interval)
      -> safety gate (evidence + confidence requirements; non-defamatory label)

Everything degrades gracefully: each model-backed signal has a deterministic
fallback, so the pipeline always returns a complete assessment. This is the
function the Celery worker calls per video, replacing the old toxicity-proxy.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from modules.nc import sentiment_service
from modules.nc.toxicity_service import ToxicityService
from modules.nc.context_classifier import classify_context, ContextAssessment
from modules.nc.risk_service import VideoRiskInput, score_video
from modules.nc import risk_calibration as cal
from modules.nc import safety_gate
from modules.nc.observability import incr, log_event


@dataclass
class VideoAssessment:
    risk_score: float
    risk_level: str
    confidence: float
    interval: tuple[float, float]
    sentiment: dict
    toxicity: float
    audience_toxicity: float
    narrative_intensity: float
    narrative_label: str | None
    context_label: str
    is_abusive: bool
    statement: str                      # non-defamatory finding text
    uncertainty_markers: list[str]
    gated: bool
    adjustments: dict = field(default_factory=dict)


def unified_toxicity(content_tox: float, audience_tox: float) -> float:
    """Combine content + audience toxicity into one 0..1 signal.

    Content dominates (it's the channel's own output) but a highly toxic
    audience meaningfully raises the amplification signal.
    """
    return round(min(1.0, 0.7 * content_tox + 0.3 * audience_tox), 4)


def assess_video(
    *,
    title: str,
    description: str = "",
    transcript: str = "",
    comments: list[str] | None = None,
    views: int = 0,
    narrative_intensity: float = 0.0,
    narrative_label: str | None = None,
    evidence_items: list | None = None,
    channel_history_scores: list[float] | None = None,
    channel_median_views: float | None = None,
    batch_toxicity_distribution: list[float] | None = None,
    use_models: bool = True,
) -> VideoAssessment:
    comments = comments or []
    evidence_items = evidence_items or []

    tox_engine = ToxicityService.get_instance()
    primary_text = "\n".join([t for t in (title, description, transcript) if t]) or title

    # --- Sentiment (real multidimensional) ---
    sent = sentiment_service.analyze(primary_text, use_model=use_models)

    # --- Toxicity: content + audience -> unified ---
    content_tox = tox_engine.score(primary_text, use_model=use_models).score
    if comments:
        audience_tox = sum(
            tox_engine.score(c, use_model=use_models).score for c in comments
        ) / len(comments)
    else:
        audience_tox = 0.0
    toxicity = unified_toxicity(content_tox, audience_tox)

    # --- Context classification (false-positive reduction) ---
    ctx: ContextAssessment = classify_context(primary_text, toxicity=content_tox)

    # --- Weighted raw risk ---
    virality = cal.normalize_engagement(views, channel_median_views)
    raw = score_video(
        VideoRiskInput(
            negative_sentiment=sent.negativity,
            toxicity=toxicity,
            narrative_intensity=narrative_intensity,
            virality=virality,
            repeated_targeting=0.0,  # set at channel aggregation
        )
    )

    # --- Calibration ---
    baseline = (
        cal.build_channel_baseline(channel_history_scores)
        if channel_history_scores
        else None
    )
    bands = (
        cal.dynamic_bands(batch_toxicity_distribution)
        if batch_toxicity_distribution
        else None
    )
    calibrated = cal.calibrate(
        raw,
        evidence_count=len(evidence_items),
        context_penalty=ctx.risk_penalty,
        ambiguity=ctx.ambiguity,
        channel_baseline=baseline,
        bands=bands,
    )

    # --- Safety gate (evidence/confidence before HIGH/CRITICAL) ---
    ev_summary = safety_gate.summarize_evidence(evidence_items)
    gated = safety_gate.apply_gate(
        calibrated.level,
        confidence=calibrated.confidence,
        ambiguity=ctx.ambiguity,
        evidence=ev_summary,
        narrative_label=narrative_label,
    )

    incr("nc.assess_video")
    if gated.gated:
        incr("nc.safety_downgrade")
    if not ctx.is_abusive and ctx.risk_penalty < 1.0:
        incr(f"nc.context.{ctx.label}")

    log_event(
        "nc_video_assessed",
        raw=raw,
        calibrated=calibrated.score,
        risk_level=gated.level,
        context=ctx.label,
        confidence=calibrated.confidence,
        gated=gated.gated,
    )

    return VideoAssessment(
        risk_score=calibrated.score,
        risk_level=gated.level,
        confidence=calibrated.confidence,
        interval=calibrated.interval,
        sentiment={
            "positive": sent.positive,
            "neutral": sent.neutral,
            "negative": sent.negative,
            "aggressive": sent.aggressive,
            "inflammatory": sent.inflammatory,
            "source": sent.source,
        },
        toxicity=toxicity,
        audience_toxicity=round(audience_tox, 4),
        narrative_intensity=narrative_intensity,
        narrative_label=narrative_label,
        context_label=ctx.label,
        is_abusive=ctx.is_abusive,
        statement=gated.statement,
        uncertainty_markers=gated.uncertainty_markers,
        gated=gated.gated,
        adjustments=calibrated.adjustments,
    )

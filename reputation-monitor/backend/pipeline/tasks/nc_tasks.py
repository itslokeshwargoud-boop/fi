"""Celery tasks for the NC (Narrative Control) enrichment pipeline.

These tasks run the heavy, non-blocking work off the request path:

  process_video_nc   -> transcribe (Whisper) + OCR (EasyOCR) + toxicity +
                        sentiment + narrative scoring -> persist NCVideo +
                        NCEvidence, mark processed_status.
  recompute_channel  -> aggregate a channel's videos into NCChannel.
  cluster_narratives -> semantic clustering across recent flagged videos ->
                        upsert NCNarrative rows.

Every task is idempotent (keyed by platform video/channel id), uses retries,
and tolerates missing heavy models because the underlying services degrade
gracefully. Tasks never raise model-absence as a hard failure — they record
what they could compute and move on.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone

from celery import shared_task
from sqlalchemy import select

from database.connection import AsyncSessionLocal
from models.nc_channel import NCChannel
from models.nc_video import NCVideo
from models.nc_evidence import NCEvidence
from models.nc_narrative import NCNarrative

from modules.nc.preprocessing import detect_language
from modules.nc.ocr_service import OCRService
from modules.nc import evidence_service
from modules.nc import narrative_service
from modules.nc.channel_intelligence_service import (
    VideoSignal,
    build_channel_profile,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-video processing
# ---------------------------------------------------------------------------

@shared_task(
    name="pipeline.tasks.nc_tasks.process_video_nc", bind=True, max_retries=3
)
def process_video_nc(self, payload: dict):
    """Process a single video end-to-end. ``payload`` carries metadata.

    Expected keys: video_id, channel_id (platform), channel_name, title,
    description, views, likes, comments, comment_texts (list[str]),
    video_url, thumbnail_path (optional), is_short (bool).
    """
    try:
        asyncio.run(_process_video_async(payload))
    except Exception as exc:  # pragma: no cover
        logger.error("process_video_nc failed: %s", exc)
        raise self.retry(exc=exc, countdown=30)


async def _process_video_async(p: dict) -> None:
    title = p.get("title", "")
    description = p.get("description", "")
    comment_texts = p.get("comment_texts", []) or []
    views = int(p.get("views", 0) or 0)

    # --- Transcript: official caption -> auto caption -> Whisper fallback ---
    from modules.nc.youtube_transcript_service import ingest_transcript

    ingested = ingest_transcript(
        p["video_id"], video_url=p.get("video_url"), allow_whisper=True
    )
    transcript_text = ingested.full_text if ingested.available else ""
    # Adapt ingestion segments to the evidence engine's TranscriptResult shape.
    transcript_result = None
    if ingested.available and ingested.segments:
        from modules.nc.transcript_service import TranscriptResult, TranscriptSegment

        transcript_result = TranscriptResult(
            video_id=p["video_id"],
            language=ingested.language,
            available=True,
            segments=[
                TranscriptSegment(start=s["start"], end=s["start"], text=s["text"])
                for s in ingested.segments
            ],
            full_text=transcript_text,
            confidence=ingested.confidence,
            source=ingested.source,
        )

    # --- OCR (model-optional) ---
    ocr_result = None
    thumb = p.get("thumbnail_path")
    if thumb and os.path.exists(thumb):
        ocr_result = OCRService.get_instance().extract(thumb, p["video_id"])

    # --- Narrative intensity via semantic clustering signal ---
    narr_clusters, _ = narrative_service.cluster_narratives(
        [title, description, transcript_text] + comment_texts[:20], min_samples=1
    )
    narrative_label = narr_clusters[0].narrative_type if narr_clusters else None
    narrative_intensity = min(1.0, (narr_clusters[0].size / 5.0)) if narr_clusters else 0.0

    # --- Evidence (built first so the safety gate can require it) ---
    evidence_items = []
    if transcript_result:
        evidence_items += evidence_service.from_transcript(transcript_result)
    if ocr_result:
        evidence_items += evidence_service.from_ocr(ocr_result)
    evidence_items += evidence_service.from_comments(comment_texts)
    evidence_items += evidence_service.from_title(title)

    # --- Unified assessment: sentiment + toxicity + context + calibration + gate ---
    from modules.nc.scoring_pipeline import assess_video

    assessment = assess_video(
        title=title,
        description=description,
        transcript=transcript_text,
        comments=comment_texts,
        views=views,
        narrative_intensity=narrative_intensity,
        narrative_label=narrative_label,
        evidence_items=evidence_items,
        channel_history_scores=p.get("channel_history_scores"),
        channel_median_views=p.get("channel_median_views"),
        batch_toxicity_distribution=p.get("batch_toxicity_distribution"),
        use_models=p.get("use_models", True),
    )
    risk = assessment.risk_score

    analysis_metadata = {
        "sentiment": assessment.sentiment,
        "context_label": assessment.context_label,
        "is_abusive": assessment.is_abusive,
        "statement": assessment.statement,
        "uncertainty_markers": assessment.uncertainty_markers,
        "gated": assessment.gated,
        "risk_interval": list(assessment.interval),
        "adjustments": assessment.adjustments,
        "audience_toxicity": assessment.audience_toxicity,
        "transcript": {
            "source": ingested.source,
            "confidence": ingested.confidence,
            "language": ingested.language,
        },
        "ocr": (
            {"confidence": ocr_result.confidence, "boxes": ocr_result.boxes[:10]}
            if ocr_result and ocr_result.available
            else None
        ),
    }

    async with AsyncSessionLocal() as db:
        # Upsert channel shell.
        channel = (
            await db.execute(
                select(NCChannel).where(NCChannel.channel_id == p["channel_id"])
            )
        ).scalar_one_or_none()
        if channel is None:
            channel = NCChannel(
                channel_id=p["channel_id"],
                channel_name=p.get("channel_name", p["channel_id"]),
                subscribers=int(p.get("subscribers", 0) or 0),
            )
            db.add(channel)
            await db.flush()

        # Upsert video.
        video = (
            await db.execute(
                select(NCVideo).where(NCVideo.video_id == p["video_id"])
            )
        ).scalar_one_or_none()
        if video is None:
            video = NCVideo(video_id=p["video_id"], channel_id=channel.id)
            db.add(video)

        video.title = title
        video.description = description
        video.transcript = transcript_text or None
        video.views = views
        video.likes = int(p.get("likes", 0) or 0)
        video.comments = int(p.get("comments", 0) or 0)
        video.sentiment_score = round(assessment.sentiment["negative"], 4)
        video.toxicity_score = round(assessment.toxicity, 4)
        video.narrative_score = round(narrative_intensity, 4)
        video.risk_score = risk
        video.narrative_label = narrative_label
        video.confidence = assessment.confidence
        video.context_label = assessment.context_label
        video.transcript_source = ingested.source
        video.transcript_confidence = round(ingested.confidence, 4)
        video.analysis_metadata = analysis_metadata
        video.language = detect_language(f"{title} {transcript_text}")
        video.is_short = bool(p.get("is_short", False))
        video.processed_status = "processed"
        await db.flush()

        # Replace evidence for this video.
        existing = (
            await db.execute(
                select(NCEvidence).where(NCEvidence.video_id == video.id)
            )
        ).scalars().all()
        for e in existing:
            await db.delete(e)
        for item in evidence_items:
            db.add(
                NCEvidence(
                    video_id=video.id,
                    timestamp=item.timestamp,
                    evidence_type=item.evidence_type,
                    content=item.content,
                    severity=item.severity,
                    confidence_score=item.confidence_score,
                )
            )
        await db.commit()
    logger.info(
        "NC processed video %s (risk=%s level=%s conf=%.2f ctx=%s tox=%.3f)",
        p["video_id"], risk, assessment.risk_level, assessment.confidence,
        assessment.context_label, assessment.toxicity,
    )


# ---------------------------------------------------------------------------
# Channel aggregation
# ---------------------------------------------------------------------------

@shared_task(name="pipeline.tasks.nc_tasks.recompute_channel", bind=True, max_retries=2)
def recompute_channel(self, channel_id: str):
    try:
        asyncio.run(_recompute_channel_async(channel_id))
    except Exception as exc:  # pragma: no cover
        logger.error("recompute_channel failed: %s", exc)
        raise self.retry(exc=exc, countdown=20)


async def _recompute_channel_async(channel_id: str) -> None:
    async with AsyncSessionLocal() as db:
        channel = (
            await db.execute(
                select(NCChannel).where(NCChannel.channel_id == channel_id)
            )
        ).scalar_one_or_none()
        if channel is None:
            return
        videos = (
            await db.execute(
                select(NCVideo).where(NCVideo.channel_id == channel.id)
            )
        ).scalars().all()

        signals = [
            VideoSignal(
                risk_score=v.risk_score,
                toxicity=v.toxicity_score,
                narrative_label=v.narrative_label,
                views=v.views,
                is_short=v.is_short,
                is_negative=v.risk_score >= 35.0,
            )
            for v in videos
        ]
        profile = build_channel_profile(signals)

        channel.avg_risk_score = profile.avg_risk_score
        channel.repeated_targeting_count = profile.repeated_targeting_count
        channel.negative_reach_score = profile.negative_reach_score
        channel.updated_at = datetime.now(timezone.utc)
        await db.commit()
    logger.info("NC recomputed channel %s (risk=%s)", channel_id, profile.avg_risk_score)


# ---------------------------------------------------------------------------
# Narrative clustering (cross-channel)
# ---------------------------------------------------------------------------

@shared_task(name="pipeline.tasks.nc_tasks.cluster_narratives", bind=True, max_retries=2)
def cluster_narratives_task(self, limit: int = 500):
    try:
        asyncio.run(_cluster_narratives_async(limit))
    except Exception as exc:  # pragma: no cover
        logger.error("cluster_narratives failed: %s", exc)
        raise self.retry(exc=exc, countdown=60)


async def _cluster_narratives_async(limit: int) -> None:
    async with AsyncSessionLocal() as db:
        videos = (
            await db.execute(
                select(NCVideo)
                .where(NCVideo.risk_score >= 35.0)
                .order_by(NCVideo.created_at.desc())
                .limit(limit)
            )
        ).scalars().all()
        if not videos:
            return

        texts = [f"{v.title} {v.transcript or ''}" for v in videos]
        clusters, backend = narrative_service.cluster_narratives(texts)
        logger.info("NC narrative clustering backend=%s clusters=%d", backend, len(clusters))

        # Refresh narrative table (simple full replace for the recomputed set).
        existing = (await db.execute(select(NCNarrative))).scalars().all()
        for n in existing:
            await db.delete(n)

        for c in clusters:
            member_videos = [videos[m] for m in c.members if m < len(videos)]
            related = sorted({str(v.channel_id) for v in member_videos})
            avg_tox = (
                sum(v.toxicity_score for v in member_videos) / len(member_videos)
                if member_videos
                else 0.0
            )
            db.add(
                NCNarrative(
                    narrative_name=c.label,
                    narrative_type=c.narrative_type,
                    embedding=c.centroid or None,
                    key_terms=c.key_terms,
                    related_channels=related,
                    frequency=c.size,
                    avg_toxicity=round(avg_tox, 4),
                    sample_text=c.sample_text,
                )
            )
        await db.commit()

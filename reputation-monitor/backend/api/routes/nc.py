"""NC (Narrative Control) API router.

Namespaced under ``/api/nc`` per spec. Serves the channel/evidence/narrative/
timeline/shorts intelligence persisted by the NC offline pipeline, with
pagination, filtering and sorting. Read endpoints are async and lightweight; the
heavy AI work happens in Celery workers, never in request handlers.

Note on architecture: the live dashboard computes NC intelligence on demand via
the Next.js engine (so the console works without the worker stack). These
endpoints expose the *persisted* enrichment layer (transcripts/OCR/embeddings)
for clients that consume the FastAPI surface, and return empty, well-formed
payloads when the pipeline has not yet populated the tables.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc, asc
from sqlalchemy.ext.asyncio import AsyncSession

from database.connection import get_db
from models.nc_channel import NCChannel
from models.nc_video import NCVideo
from models.nc_evidence import NCEvidence
from models.nc_narrative import NCNarrative
from modules.nc.risk_service import level_from_score

router = APIRouter(prefix="/api/nc", tags=["nc"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class Page(BaseModel):
    total: int
    limit: int
    offset: int


class NCChannelOut(BaseModel):
    id: str
    channel_id: str
    channel_name: str
    subscribers: int
    avg_risk_score: float
    risk_level: str
    repeated_targeting_count: int
    negative_reach_score: float


class NCChannelsResponse(BaseModel):
    page: Page
    items: list[NCChannelOut]


class NCEvidenceOut(BaseModel):
    id: str
    video_id: str
    timestamp: str | None
    evidence_type: str
    content: str
    severity: str
    confidence_score: float


class NCEvidenceResponse(BaseModel):
    page: Page
    items: list[NCEvidenceOut]


class NCNarrativeOut(BaseModel):
    id: str
    narrative_name: str
    narrative_type: str
    frequency: int
    avg_toxicity: float
    key_terms: list[str] | None
    related_channels: list[str] | None


class NCNarrativesResponse(BaseModel):
    page: Page
    items: list[NCNarrativeOut]


class NCTimelinePointOut(BaseModel):
    date: str
    flagged_videos: int
    avg_toxicity: float


class NCShortOut(BaseModel):
    id: str
    video_id: str
    title: str
    views: int
    risk_score: float
    risk_level: str
    narrative_label: str | None


class NCShortsResponse(BaseModel):
    page: Page
    items: list[NCShortOut]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CHANNEL_SORT = {
    "risk": NCChannel.avg_risk_score,
    "reach": NCChannel.negative_reach_score,
    "targeting": NCChannel.repeated_targeting_count,
    "name": NCChannel.channel_name,
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/channels", response_model=NCChannelsResponse)
async def list_channels(
    db: AsyncSession = Depends(get_db),
    risk_level: str | None = Query(None, description="LOW|MEDIUM|HIGH|CRITICAL"),
    min_risk: float = Query(0.0, ge=0.0, le=100.0),
    sort: Literal["risk", "reach", "targeting", "name"] = "risk",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Paginated, filterable, sortable negative-spreader channels."""
    stmt = select(NCChannel).where(NCChannel.avg_risk_score >= min_risk)
    count_stmt = select(func.count(NCChannel.id)).where(
        NCChannel.avg_risk_score >= min_risk
    )

    sort_col = _CHANNEL_SORT[sort]
    stmt = stmt.order_by(asc(sort_col) if order == "asc" else desc(sort_col))
    stmt = stmt.limit(limit).offset(offset)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (await db.execute(stmt)).scalars().all()

    items = []
    for c in rows:
        lvl = level_from_score(c.avg_risk_score)
        if risk_level and lvl != risk_level.upper():
            continue
        items.append(
            NCChannelOut(
                id=str(c.id),
                channel_id=c.channel_id,
                channel_name=c.channel_name,
                subscribers=c.subscribers,
                avg_risk_score=c.avg_risk_score,
                risk_level=lvl,
                repeated_targeting_count=c.repeated_targeting_count,
                negative_reach_score=c.negative_reach_score,
            )
        )

    return NCChannelsResponse(
        page=Page(total=total, limit=limit, offset=offset), items=items
    )


@router.get("/evidence", response_model=NCEvidenceResponse)
async def list_evidence(
    db: AsyncSession = Depends(get_db),
    video_id: str | None = Query(None, description="Filter by NCVideo UUID"),
    evidence_type: str | None = Query(None),
    severity: str | None = Query(None, description="low|medium|high"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Paginated evidence items for the drawer / Evidence Explorer."""
    stmt = select(NCEvidence)
    count_stmt = select(func.count(NCEvidence.id))

    if video_id:
        stmt = stmt.where(NCEvidence.video_id == video_id)
        count_stmt = count_stmt.where(NCEvidence.video_id == video_id)
    if evidence_type:
        stmt = stmt.where(NCEvidence.evidence_type == evidence_type)
        count_stmt = count_stmt.where(NCEvidence.evidence_type == evidence_type)
    if severity:
        stmt = stmt.where(NCEvidence.severity == severity)
        count_stmt = count_stmt.where(NCEvidence.severity == severity)

    stmt = stmt.order_by(desc(NCEvidence.confidence_score)).limit(limit).offset(offset)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (await db.execute(stmt)).scalars().all()

    return NCEvidenceResponse(
        page=Page(total=total, limit=limit, offset=offset),
        items=[
            NCEvidenceOut(
                id=str(e.id),
                video_id=str(e.video_id),
                timestamp=e.timestamp,
                evidence_type=e.evidence_type,
                content=e.content,
                severity=e.severity,
                confidence_score=e.confidence_score,
            )
            for e in rows
        ],
    )


@router.get("/narratives", response_model=NCNarrativesResponse)
async def list_narratives(
    db: AsyncSession = Depends(get_db),
    narrative_type: str | None = Query(None),
    min_frequency: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Paginated semantic narrative clusters."""
    stmt = select(NCNarrative).where(NCNarrative.frequency >= min_frequency)
    count_stmt = select(func.count(NCNarrative.id)).where(
        NCNarrative.frequency >= min_frequency
    )
    if narrative_type:
        stmt = stmt.where(NCNarrative.narrative_type == narrative_type)
        count_stmt = count_stmt.where(NCNarrative.narrative_type == narrative_type)

    stmt = stmt.order_by(desc(NCNarrative.frequency)).limit(limit).offset(offset)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (await db.execute(stmt)).scalars().all()

    return NCNarrativesResponse(
        page=Page(total=total, limit=limit, offset=offset),
        items=[
            NCNarrativeOut(
                id=str(n.id),
                narrative_name=n.narrative_name,
                narrative_type=n.narrative_type,
                frequency=n.frequency,
                avg_toxicity=n.avg_toxicity,
                key_terms=n.key_terms,
                related_channels=n.related_channels,
            )
            for n in rows
        ],
    )


@router.get("/timeline", response_model=list[NCTimelinePointOut])
async def get_timeline(
    db: AsyncSession = Depends(get_db),
    days: int = Query(30, ge=1, le=365),
):
    """Daily flagged-volume + toxicity timeline (risk timeline)."""
    # Group flagged videos by day. SQLite/Postgres-portable via func.date.
    day = func.date(NCVideo.published_at)
    stmt = (
        select(
            day.label("d"),
            func.count(NCVideo.id).label("flagged"),
            func.avg(NCVideo.toxicity_score).label("tox"),
        )
        .where(NCVideo.risk_score >= 35.0)
        .group_by(day)
        .order_by(day)
    )
    rows = (await db.execute(stmt)).all()
    out = []
    for d, flagged, tox in rows[-days:]:
        out.append(
            NCTimelinePointOut(
                date=str(d),
                flagged_videos=int(flagged or 0),
                avg_toxicity=round(float(tox or 0.0), 4),
            )
        )
    return out


@router.get("/shorts", response_model=NCShortsResponse)
async def list_shorts(
    db: AsyncSession = Depends(get_db),
    min_risk: float = Query(0.0, ge=0.0, le=100.0),
    sort: Literal["risk", "views"] = "risk",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """Paginated viral-shorts tracker feed."""
    stmt = select(NCVideo).where(
        NCVideo.is_short.is_(True), NCVideo.risk_score >= min_risk
    )
    count_stmt = select(func.count(NCVideo.id)).where(
        NCVideo.is_short.is_(True), NCVideo.risk_score >= min_risk
    )
    sort_col = NCVideo.risk_score if sort == "risk" else NCVideo.views
    stmt = stmt.order_by(asc(sort_col) if order == "asc" else desc(sort_col))
    stmt = stmt.limit(limit).offset(offset)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (await db.execute(stmt)).scalars().all()

    return NCShortsResponse(
        page=Page(total=total, limit=limit, offset=offset),
        items=[
            NCShortOut(
                id=str(v.id),
                video_id=v.video_id,
                title=v.title,
                views=v.views,
                risk_score=v.risk_score,
                risk_level=level_from_score(v.risk_score),
                narrative_label=v.narrative_label,
            )
            for v in rows
        ],
    )


# ---------------------------------------------------------------------------
# Operational endpoints: model health + pipeline metrics
# ---------------------------------------------------------------------------

@router.get("/health")
async def nc_health():
    """Model registry health + device + per-model load/inference state."""
    from modules.nc import model_registry

    return model_registry.health()


@router.get("/metrics")
async def nc_metrics():
    """In-process NC pipeline metrics (counters + inference timers)."""
    from modules.nc.observability import snapshot

    return snapshot()

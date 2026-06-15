from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Index,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from database.connection import Base

# JSONB on Postgres, generic JSON on SQLite (dev/test).
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class NCVideo(Base):
    """A single analysed video belonging to an :class:`NCChannel`.

    Holds raw metadata (title/description/transcript/engagement) alongside the
    AI-derived scores produced by the NC pipeline. ``processed_status`` lets the
    Celery workers process videos idempotently and resume after failures.
    """

    __tablename__ = "nc_videos"
    __table_args__ = (
        # Common filters: by channel, by risk, and by processing backlog.
        Index("ix_nc_videos_channel_risk", "channel_id", "risk_score"),
        Index("ix_nc_videos_processed_status", "processed_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Platform-native video identifier (YouTube videoId), unique.
    video_id: Mapped[str] = mapped_column(
        String(255), nullable=False, unique=True, index=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("nc_channels.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)

    views: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    likes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    comments: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # AI-derived scores (0..1 unless noted).
    sentiment_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    toxicity_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    narrative_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    risk_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    narrative_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Calibrated risk confidence (0..1) and FP-reduction context label.
    confidence: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    context_label: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Transcript provenance (official_caption | auto_caption | whisper | none).
    transcript_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    transcript_confidence: Mapped[float] = mapped_column(
        Float, default=0.0, nullable=False
    )
    # Rich assessment metadata: sentiment dims, OCR boxes, uncertainty markers,
    # calibration adjustments, processing diagnostics.
    analysis_metadata: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)

    language: Mapped[str] = mapped_column(String(20), default="te", nullable=False)
    # one of: pending | transcribing | processed | failed
    processed_status: Mapped[str] = mapped_column(
        String(32), default="pending", nullable=False
    )

    is_short: Mapped[bool] = mapped_column(default=False, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    channel: Mapped["NCChannel"] = relationship(  # noqa: F821
        "NCChannel", back_populates="videos"
    )
    evidence_items: Mapped[list["NCEvidence"]] = relationship(  # noqa: F821
        "NCEvidence", back_populates="video", cascade="all, delete-orphan"
    )

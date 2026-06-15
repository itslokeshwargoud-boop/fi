from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, String, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database.connection import Base


class NCEvidence(Base):
    """A single explainable evidence item supporting a video's risk score.

    Evidence is what the dashboard drawer renders: a transcript segment with a
    timestamp, an OCR thumbnail phrase, a toxic comment, or a repeated-targeting
    phrase. Every item carries its own confidence + severity so the UI can
    justify findings rather than assert conclusions.
    """

    __tablename__ = "nc_evidence"
    __table_args__ = (
        Index("ix_nc_evidence_video_type", "video_id", "evidence_type"),
        Index("ix_nc_evidence_severity", "severity"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    video_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("nc_videos.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Media timestamp like "02:14" for transcript/OCR evidence; null for comments.
    timestamp: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # one of: transcript_segment | ocr_text | toxic_comment |
    #         repeated_phrase | title_claim
    evidence_type: Mapped[str] = mapped_column(String(40), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # one of: low | medium | high
    severity: Mapped[str] = mapped_column(String(16), default="low", nullable=False)
    confidence_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    video: Mapped["NCVideo"] = relationship(  # noqa: F821
        "NCVideo", back_populates="evidence_items"
    )

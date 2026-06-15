from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, String, Text, Integer, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from database.connection import Base


class NCTranscriptSegment(Base):
    """A timestamped spoken segment from a video transcript (Phase 2 storage).

    Produced by the faster-whisper / caption pipeline. These rows are the raw
    material for TRANSCRIPT_EVIDENCE: each carries a start/end offset (seconds),
    the spoken text, a confidence and a detected language. Indexed by
    (video_id, start_seconds) for fast timeline reconstruction and deep-linking.
    """

    __tablename__ = "nc_transcript_segments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The external YouTube video id (matches NCVideo.video_id).
    video_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    start_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    end_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    transcript_text: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    language: Mapped[str] = mapped_column(String(20), nullable=False, default="te")
    # Provenance: faster-whisper | whisper | official_caption | auto_caption.
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="faster-whisper")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    __table_args__ = (
        Index("ix_nc_transcript_segments_video_start", "video_id", "start_seconds"),
    )

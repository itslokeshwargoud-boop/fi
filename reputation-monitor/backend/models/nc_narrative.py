from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Integer, String, Text, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from database.connection import Base

# Use JSONB on Postgres, fall back to generic JSON on SQLite (dev/test).
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class NCNarrative(Base):
    """A semantically-clustered recurring narrative across channels.

    Produced by the narrative service (sentence-transformer embeddings +
    DBSCAN). The centroid ``embedding`` is stored so new videos can be matched
    to existing narratives via vector similarity without re-clustering, and
    ``related_channels`` records which channels amplify it.
    """

    __tablename__ = "nc_narratives"
    __table_args__ = (
        Index("ix_nc_narratives_frequency", "frequency"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    narrative_name: Mapped[str] = mapped_column(String(512), nullable=False)
    # one of the NarrativeType values shared with the frontend.
    narrative_type: Mapped[str] = mapped_column(
        String(64), default="general_negative", nullable=False
    )

    # Centroid embedding vector (list[float]) for similarity matching.
    embedding: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    # Representative key terms for explainability (list[str]).
    key_terms: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)
    # Channel ids amplifying this narrative (list[str]).
    related_channels: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True)

    frequency: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    avg_toxicity: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    sample_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

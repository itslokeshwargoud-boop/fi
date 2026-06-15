from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Integer, String, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database.connection import Base


class NCChannel(Base):
    """A YouTube channel tracked by the NC (Narrative Control) module.

    Stores the aggregate, AI-derived intelligence profile for a channel:
    rolling risk, how often it re-targets the same subject, and an estimated
    negative reach. Per-video detail lives in :class:`NCVideo`.
    """

    __tablename__ = "nc_channels"
    __table_args__ = (
        # Hot path: rank channels by risk for the Negative Spreaders table.
        Index("ix_nc_channels_avg_risk_score", "avg_risk_score"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Platform-native channel identifier (e.g. YouTube channelId), unique.
    channel_id: Mapped[str] = mapped_column(
        String(255), nullable=False, unique=True, index=True
    )
    channel_name: Mapped[str] = mapped_column(String(512), nullable=False)
    subscribers: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    avg_risk_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    repeated_targeting_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    negative_reach_score: Mapped[float] = mapped_column(
        Float, default=0.0, nullable=False
    )

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

    videos: Mapped[list["NCVideo"]] = relationship(  # noqa: F821
        "NCVideo", back_populates="channel", cascade="all, delete-orphan"
    )

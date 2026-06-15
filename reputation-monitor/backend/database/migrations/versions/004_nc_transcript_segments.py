"""NC transcript segments storage (Phase 2).

Revision ID: 004
Revises: 003
Create Date: 2026-06-08 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "nc_transcript_segments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("video_id", sa.String(255), nullable=False),
        sa.Column("start_seconds", sa.Float(), nullable=False),
        sa.Column("end_seconds", sa.Float(), nullable=False, server_default="0"),
        sa.Column("transcript_text", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("language", sa.String(20), nullable=False, server_default="'te'"),
        sa.Column("source", sa.String(32), nullable=False, server_default="'faster-whisper'"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_nc_transcript_segments_video_id", "nc_transcript_segments", ["video_id"])
    op.create_index(
        "ix_nc_transcript_segments_video_start",
        "nc_transcript_segments",
        ["video_id", "start_seconds"],
    )


def downgrade() -> None:
    op.drop_index("ix_nc_transcript_segments_video_start", table_name="nc_transcript_segments")
    op.drop_index("ix_nc_transcript_segments_video_id", table_name="nc_transcript_segments")
    op.drop_table("nc_transcript_segments")

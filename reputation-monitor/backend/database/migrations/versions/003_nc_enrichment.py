"""NC enrichment: video confidence, context, transcript provenance, metadata.

Revision ID: 003
Revises: 002
Create Date: 2026-06-08 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '003'
down_revision = '002'
branch_labels = None
depends_on = None

_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), 'sqlite')


def upgrade() -> None:
    op.add_column('nc_videos', sa.Column('confidence', sa.Float(), nullable=False, server_default='0'))
    op.add_column('nc_videos', sa.Column('context_label', sa.String(40), nullable=True))
    op.add_column('nc_videos', sa.Column('transcript_source', sa.String(32), nullable=True))
    op.add_column('nc_videos', sa.Column('transcript_confidence', sa.Float(), nullable=False, server_default='0'))
    op.add_column('nc_videos', sa.Column('analysis_metadata', _JSON, nullable=True))


def downgrade() -> None:
    op.drop_column('nc_videos', 'analysis_metadata')
    op.drop_column('nc_videos', 'transcript_confidence')
    op.drop_column('nc_videos', 'transcript_source')
    op.drop_column('nc_videos', 'context_label')
    op.drop_column('nc_videos', 'confidence')

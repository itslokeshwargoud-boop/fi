"""NC (Narrative Control) module: channels, videos, evidence, narratives.

Revision ID: 002
Revises: 001
Create Date: 2026-06-08 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = '002'
down_revision = '001'
branch_labels = None
depends_on = None

# JSONB on Postgres, JSON elsewhere (dev/test SQLite).
_JSON = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), 'sqlite')


def upgrade() -> None:
    # === nc_channels ===
    op.create_table(
        'nc_channels',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('channel_id', sa.String(255), nullable=False),
        sa.Column('channel_name', sa.String(512), nullable=False),
        sa.Column('subscribers', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('avg_risk_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('repeated_targeting_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('negative_reach_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('channel_id', name='uq_nc_channels_channel_id'),
    )
    op.create_index('ix_nc_channels_channel_id', 'nc_channels', ['channel_id'])
    op.create_index('ix_nc_channels_avg_risk_score', 'nc_channels', ['avg_risk_score'])

    # === nc_videos ===
    op.create_table(
        'nc_videos',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('video_id', sa.String(255), nullable=False),
        sa.Column('channel_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False, server_default="''"),
        sa.Column('transcript', sa.Text(), nullable=True),
        sa.Column('views', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('likes', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('comments', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sentiment_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('toxicity_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('narrative_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('risk_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('narrative_label', sa.String(255), nullable=True),
        sa.Column('language', sa.String(20), nullable=False, server_default="'te'"),
        sa.Column('processed_status', sa.String(32), nullable=False, server_default="'pending'"),
        sa.Column('is_short', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['channel_id'], ['nc_channels.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('video_id', name='uq_nc_videos_video_id'),
    )
    op.create_index('ix_nc_videos_video_id', 'nc_videos', ['video_id'])
    op.create_index('ix_nc_videos_channel_id', 'nc_videos', ['channel_id'])
    op.create_index('ix_nc_videos_published_at', 'nc_videos', ['published_at'])
    op.create_index('ix_nc_videos_channel_risk', 'nc_videos', ['channel_id', 'risk_score'])
    op.create_index('ix_nc_videos_processed_status', 'nc_videos', ['processed_status'])

    # === nc_evidence ===
    op.create_table(
        'nc_evidence',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('video_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('timestamp', sa.String(16), nullable=True),
        sa.Column('evidence_type', sa.String(40), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('severity', sa.String(16), nullable=False, server_default="'low'"),
        sa.Column('confidence_score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['video_id'], ['nc_videos.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_nc_evidence_video_id', 'nc_evidence', ['video_id'])
    op.create_index('ix_nc_evidence_video_type', 'nc_evidence', ['video_id', 'evidence_type'])
    op.create_index('ix_nc_evidence_severity', 'nc_evidence', ['severity'])

    # === nc_narratives ===
    op.create_table(
        'nc_narratives',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('narrative_name', sa.String(512), nullable=False),
        sa.Column('narrative_type', sa.String(64), nullable=False, server_default="'general_negative'"),
        sa.Column('embedding', _JSON, nullable=True),
        sa.Column('key_terms', _JSON, nullable=True),
        sa.Column('related_channels', _JSON, nullable=True),
        sa.Column('frequency', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('avg_toxicity', sa.Float(), nullable=False, server_default='0'),
        sa.Column('sample_text', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_nc_narratives_frequency', 'nc_narratives', ['frequency'])


def downgrade() -> None:
    op.drop_index('ix_nc_narratives_frequency', table_name='nc_narratives')
    op.drop_table('nc_narratives')

    op.drop_index('ix_nc_evidence_severity', table_name='nc_evidence')
    op.drop_index('ix_nc_evidence_video_type', table_name='nc_evidence')
    op.drop_index('ix_nc_evidence_video_id', table_name='nc_evidence')
    op.drop_table('nc_evidence')

    op.drop_index('ix_nc_videos_processed_status', table_name='nc_videos')
    op.drop_index('ix_nc_videos_channel_risk', table_name='nc_videos')
    op.drop_index('ix_nc_videos_published_at', table_name='nc_videos')
    op.drop_index('ix_nc_videos_channel_id', table_name='nc_videos')
    op.drop_index('ix_nc_videos_video_id', table_name='nc_videos')
    op.drop_table('nc_videos')

    op.drop_index('ix_nc_channels_avg_risk_score', table_name='nc_channels')
    op.drop_index('ix_nc_channels_channel_id', table_name='nc_channels')
    op.drop_table('nc_channels')

"""DM email fallback + active-reading detection.

Sprint 28 / DMs Phase 2B. Two new columns on
conversation_members:

  - `last_email_sent_at` — for the email cooldown. We send an
    "unread messages in Trivu" email when a message arrives AND
    >2h have passed since the last email for that member of
    that conversation. NULL = never emailed.

  - `last_read_at` — when the mark-read endpoint was last
    called for this membership. Used in tandem with
    `last_read_message_id` to detect "the user is actively
    watching this conversation right now" — when they marked
    read in the last ~5 min, we skip the email (they don't
    need a notification for something they just saw).

Both default NULL. The send-message endpoint applies the
cooldown + active-read check synchronously; failures in SMTP
are swallowed (same pattern as other notification paths).

Revision ID: 0056_dm_email_fallback
Revises: 0055_dms
Create Date: 2026-05-23
"""

import sqlalchemy as sa
from alembic import op


revision = "0056_dm_email_fallback"
down_revision = "0055_dms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_members",
        sa.Column(
            "last_email_sent_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "conversation_members",
        sa.Column(
            "last_read_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversation_members", "last_read_at")
    op.drop_column("conversation_members", "last_email_sent_at")

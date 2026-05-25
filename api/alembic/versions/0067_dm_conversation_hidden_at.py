"""Per-user "delete conversation" via hidden_at on conversation_members.

DMs Phase 2C. Same WhatsApp / Slack pattern: deleting a
conversation removes it from *your* list, but the other
participant still sees it and their history is intact. If they
send you a new message later, the conversation re-appears on
your side (because the filter is "show if hidden_at IS NULL OR
last_message_at > hidden_at" — a new message bumps
last_message_at past the marker).

Why a per-user marker instead of a hard delete:
  - Hard delete would nuke the conversation for both sides.
    Asymmetric and surprising — the other person loses history
    they didn't ask to.
  - A "hide for both" with consent flow is heavyweight for a
    1:1 chat.
  - The per-user marker is dirt-cheap (one timestamp column,
    one filter clause) and matches the mental model people
    bring from WhatsApp.

Symmetry with messages.deleted_at:
  - messages.deleted_at already exists from migration 0055. The
    DELETE message endpoint (added in this sprint) sets it and
    NULLs the body so the content is gone but the row stays for
    stable id tracking.
  - hidden_at is the conversation-level analogue but per-user,
    which is why it lives on conversation_members and not on
    conversations.

Revision ID: 0067_dm_conversation_hidden_at
Revises: 0066_meeting_reminders
Create Date: 2026-05-25
"""

import sqlalchemy as sa
from alembic import op


revision = "0067_dm_conversation_hidden_at"
down_revision = "0066_meeting_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_members",
        sa.Column(
            "hidden_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversation_members", "hidden_at")

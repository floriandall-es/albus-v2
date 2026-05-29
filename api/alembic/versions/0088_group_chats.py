"""Group chats — extend conversations to support N>2 members.

The Phase 2A DM data model already permits N members structurally
(`conversation_members` has no count constraint), so this migration
is small:

  - Widen the `kind` CHECK to include 'group'.
  - Add `conversations.title` (nullable for DMs, required for groups
    via a partial CHECK).
  - Add `conversations.created_by_person_id` so the "only the
    creator can remove someone else" route guard has the data it
    needs.

Member-management routes, the create-group route, and the
serializer fork all live in code (routes/dms.py). No member-side
schema changes — `ConversationMember` already carries everything
needed (last_read, hidden_at, joined_at).

Permission model spelled out elsewhere (see
routes/dms.py::create_group_chat et al.): any member can add or
rename, only the creator can remove someone else, anyone can leave
themselves. Group size is uncapped — when groups get big the
fan-out is bounded by the unread-email cooldown anyway.

Revision ID: 0088_group_chats
Revises: 0087_admin_promotion_requests
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0088_group_chats"
down_revision = "0087_admin_promotion_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("title", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "created_by_person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Widen kind. Postgres requires drop+recreate to relax a CHECK.
    op.drop_constraint(
        "ck_conversations_kind", "conversations", type_="check"
    )
    op.create_check_constraint(
        "ck_conversations_kind",
        "conversations",
        "kind IN ('dm', 'group')",
    )
    # Groups must carry a title; DMs must NOT (defensive — keeps the
    # data shape obvious so future readers don't have to guess what
    # an empty-titled group means).
    op.create_check_constraint(
        "ck_conversations_title_per_kind",
        "conversations",
        "(kind = 'dm' AND title IS NULL) "
        "OR (kind = 'group' AND title IS NOT NULL AND length(title) > 0)",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_conversations_title_per_kind",
        "conversations",
        type_="check",
    )
    op.drop_constraint(
        "ck_conversations_kind", "conversations", type_="check"
    )
    op.create_check_constraint(
        "ck_conversations_kind",
        "conversations",
        "kind IN ('dm')",
    )
    op.drop_column("conversations", "created_by_person_id")
    op.drop_column("conversations", "title")

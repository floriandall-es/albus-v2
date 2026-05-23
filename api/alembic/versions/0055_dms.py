"""Hospital-scoped 1:1 direct messages (DMs Phase 2A).

The directory's contact methods solved discovery. This adds the
in-app channel so clinicians can DM each other without exposing
phone numbers — the key product argument: people are cautious
sharing phone, and email is too slow for clinical questions.

Phase 2A is deliberately the smallest playable build:
  - 1:1 DMs only (no channels, no groups).
  - Text only (no voice notes — deferred to Phase 3).
  - No realtime (no WebSockets); UI polls and refreshes on focus.
  - No email fallback yet (Phase 2B); recipient must open the app.

Schema notes:
  - conversations.hospital_id is the scope boundary. Both
    participants must have an active membership at this hospital
    — enforced at the route level (no cross-hospital DMs).
  - DM uniqueness invariant: for a (person_a, person_b) pair in
    one hospital, exactly one kind='dm' conversation. Enforced
    by the find-or-create endpoint with an advisory lock on the
    sorted pair so two simultaneous requests can't fork.
  - No RLS on these tables — the privacy gate is
    "ctx.person.id ∈ conversation_members". Conversations cross
    tenants by design, so per-tenant RLS doesn't apply.

Revision ID: 0055_dms
Revises: 0054_share_email_default_on
Create Date: 2026-05-23
"""

import sqlalchemy as sa
from alembic import op


revision = "0055_dms"
down_revision = "0054_share_email_default_on"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "hospital_id",
            sa.Integer,
            sa.ForeignKey("hospitals.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Denormalized last_message_at so we can sort the
        # conversation list cheaply (the active conversation
        # bubbles to the top). Updated by the send endpoint and
        # initialised to created_at.
        sa.Column(
            "last_message_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('dm')",
            name="ck_conversations_kind",
        ),
    )

    op.create_table(
        "conversation_members",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "conversation_id",
            sa.Integer,
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # High-water mark for unread counts. NULL = never opened
        # (everything is unread). Updated by POST .../read.
        sa.Column(
            "last_read_message_id",
            sa.Integer,
            nullable=True,
        ),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "conversation_id",
            "person_id",
            name="uq_conversation_members_pair",
        ),
    )
    # Composite index for the "my conversations" lookup — the
    # primary query pattern is "for ctx.person.id, what are their
    # conversation_ids" → fast JOIN with conversations.
    op.create_index(
        "ix_conversation_members_person_conv",
        "conversation_members",
        ["person_id", "conversation_id"],
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "conversation_id",
            sa.Integer,
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # author can be NULL if the Person row is deleted later
        # (ON DELETE SET NULL). The message body still shows; the
        # author label renders as "(eliminado)".
        sa.Column(
            "author_person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        # Soft-delete: row stays so message ids remain stable for
        # last_read tracking. UI renders "mensaje borrado".
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_messages_conv_created",
        "messages",
        ["conversation_id", sa.text("created_at DESC")],
    )

    # Grants — all three tables are app-managed (no RLS, no
    # SECURITY DEFINER functions needed since the gate lives in
    # the route layer).
    for table in ("conversations", "conversation_members", "messages"):
        op.execute(
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO albus_app"
        )
        op.execute(
            f"GRANT USAGE, SELECT ON SEQUENCE {table}_id_seq TO albus_app"
        )


def downgrade() -> None:
    op.drop_index("ix_messages_conv_created", table_name="messages")
    op.drop_table("messages")
    op.drop_index(
        "ix_conversation_members_person_conv",
        table_name="conversation_members",
    )
    op.drop_table("conversation_members")
    op.drop_table("conversations")

"""Conversation → Trivu-entity context link.

Lets a conversation optionally reference a meeting, bloqueo
(availability_block) or shift-swap offer, so chat can be woven into
the scheduling domain instead of being a detached messenger:

  - meeting  → a group chat auto-membered from the meeting's audience
  - bloqueo  → a DM in the context of a time-off request
  - swap     → a DM in the context of a coverage/swap offer

One generic mechanism, three uses. The thread renders a context
header + deep link back to the entity (frontend).

Columns on `conversations`:
  - context_kind  TEXT NULL   ('meeting' | 'bloqueo' | 'swap')
  - context_id    INT  NULL   (the meeting / availability_block /
                               shift_swap_offer id; not an FK because
                               it's polymorphic — integrity is enforced
                               at the route layer, and a deleted entity
                               just leaves an orphan header)

Constraints:
  - both NULL or both set (a context_kind without an id is meaningless)
  - kind in the allowed set
  - at most ONE conversation per meeting (partial unique) — the
    meeting chat is find-or-create. bloqueo/swap DMs dedupe on
    (member pair + context) in code, so no unique index there.

No RLS: `conversations` is hospital-scoped and reached through the
AdminSessionLocal path with explicit hospital filtering (see
routes/dms.py), like the rest of this table.

Revision ID: 0092_conversation_context
Revises: 0091_pulse_question_overrides
Create Date: 2026-06-01
"""

from alembic import op


revision = "0092_conversation_context"
down_revision = "0091_pulse_question_overrides"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE conversations
            ADD COLUMN context_kind VARCHAR(16),
            ADD COLUMN context_id INTEGER;

        ALTER TABLE conversations
            ADD CONSTRAINT ck_conversations_context_pair
            CHECK (
                (context_kind IS NULL AND context_id IS NULL)
                OR (context_kind IS NOT NULL AND context_id IS NOT NULL)
            );

        ALTER TABLE conversations
            ADD CONSTRAINT ck_conversations_context_kind
            CHECK (
                context_kind IS NULL
                OR context_kind IN ('meeting', 'bloqueo', 'swap')
            );

        -- Fast lookup "is there a conversation for this entity?"
        CREATE INDEX ix_conversations_context
            ON conversations (context_kind, context_id);

        -- At most one group chat per meeting.
        CREATE UNIQUE INDEX uq_conversations_meeting
            ON conversations (context_id)
            WHERE context_kind = 'meeting';
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS uq_conversations_meeting;
        DROP INDEX IF EXISTS ix_conversations_context;
        ALTER TABLE conversations
            DROP CONSTRAINT IF EXISTS ck_conversations_context_kind;
        ALTER TABLE conversations
            DROP CONSTRAINT IF EXISTS ck_conversations_context_pair;
        ALTER TABLE conversations
            DROP COLUMN IF EXISTS context_id,
            DROP COLUMN IF EXISTS context_kind;
        """
    )

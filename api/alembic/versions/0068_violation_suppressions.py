"""Per-schedule "hide" markers for individual rule violations.

The violations engine (services/violations.py) recomputes every
breach from the schedule's current assignments on each request —
there is no Violation table to flag. So "hide" can't be a column
on a violation row; we need a separate table that records "this
particular conflict on this schedule should not be flagged."

Identity model
--------------
A violation is uniquely identified by:

  - schedule_id
  - kind (incompatibility / succession / frequency / time_overlap /
    post_rest)
  - the set of (date, slot_id, person_id) tuples for its cells
  - rule_id (optional — implicit checks don't have one)

`assignment_id` deliberately NOT in the identity: assignment ids
churn when the schedule is regenerated, but if the same person
ends up on the same date/slot pair the conflict re-appears with a
new assignment_id. Keying on (date, slot_id, person_id) means the
admin's "hide" sticks across regeneration whenever the same
conflict reappears — and silently lapses if it doesn't.

We hash that tuple to a 64-char sha256 hex `signature` so the
unique key is fixed-width and cheap to compare. The serializer
computes the signature server-side and includes it in
`ViolationOut`; the suppress endpoint takes that signature
verbatim. Frontend just echoes back what GET returned.

Per-schedule, not per-tenant: hiding a conflict on January's
plan shouldn't silently hide it on February's. If the admin
wants the rule itself relaxed they edit the rule.

Tenant-scoped RLS + GRANTs follow the boilerplate (see
migration 0002 for the canonical pattern).

Revision ID: 0068_violation_suppressions
Revises: 0067_dm_conversation_hidden_at
Create Date: 2026-05-25
"""

import sqlalchemy as sa
from alembic import op


revision = "0068_violation_suppressions"
down_revision = "0067_dm_conversation_hidden_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "violation_suppressions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "schedule_id",
            sa.Integer,
            sa.ForeignKey("schedules.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # sha256 hex over canonical JSON of (kind, sorted cells,
        # rule_id). 64 chars; fixed-width for cheap unique index.
        sa.Column("signature", sa.String(length=64), nullable=False),
        # Stored for audit / debug. Same value the violations engine
        # emits (one of incompatibility/succession/frequency/
        # time_overlap/post_rest).
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column(
            "suppressed_by_membership_id",
            sa.Integer,
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "suppressed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "schedule_id",
            "signature",
            name="uq_violation_suppressions_sig",
        ),
    )

    # RLS — tenant isolation, same pattern as incidents (0034).
    op.execute("ALTER TABLE violation_suppressions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE violation_suppressions FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY violation_suppressions_tenant_isolation
        ON violation_suppressions
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON violation_suppressions "
        "TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE violation_suppressions_id_seq "
        "TO albus_app"
    )


def downgrade() -> None:
    op.execute("REVOKE ALL ON violation_suppressions FROM albus_app")
    op.drop_table("violation_suppressions")

"""Drop Guardias / Exención fields; add memberships.disabled_at.

Migration 0030 collapsed pools+skills into per-slot allow-lists.
The remaining "who can do which shift" filters on Membership —
`does_guardias`, `guardia_types`, `exemption_type`, `exemption_until` —
are now redundant:

- Guardia eligibility is covered by the slot's allow-list (and a
  category match per role). The dedicated guardia filter was the
  pre-Sprint 22 way to do the same thing.
- Exemption was a half-built concept (stored, never read by the
  solver). Availability Blocks (Bloqueos) cover the real use case
  — maternity leave, illness, training — with dates, an approval
  flow, and an audit trail.

In place of both we add a single `disabled_at` column. A non-null
value means the membership is paused: the solver skips it,
admins see a "Desactivado" badge, but past assignments and the
person's login remain untouched (they can still see their history
in /me). Re-enabling clears `disabled_at`.

We keep `slots.guardia_type` (still used by the solver's
"two-guardias-too-close" spread objective — purely a fairness
signal, no longer an eligibility one).

Revision ID: 0032_member_disabled_at
Revises: 0031_slot_allowed_persons_rls
Create Date: 2026-05-19
"""

import sqlalchemy as sa
from alembic import op

revision = "0032_member_disabled_at"
down_revision = "0031_slot_allowed_persons_rls"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "memberships",
        sa.Column(
            "disabled_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )

    # Drop the exemption-type CHECK before the columns (the constraint
    # references one of them).
    op.drop_constraint(
        "ck_memberships_exemption_type", "memberships", type_="check"
    )
    op.drop_column("memberships", "exemption_until")
    op.drop_column("memberships", "exemption_type")
    op.drop_column("memberships", "guardia_types")
    op.drop_column("memberships", "does_guardias")


def downgrade() -> None:
    # Re-add the columns as nullable / with defaults matching their
    # pre-migration shapes. We can't restore the data that was in
    # `guardia_types` or the exemption fields; downgrade just makes
    # the schema usable again.
    op.add_column(
        "memberships",
        sa.Column(
            "does_guardias",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "memberships",
        sa.Column(
            "guardia_types",
            sa.ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
    )
    op.add_column(
        "memberships",
        sa.Column("exemption_type", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "memberships",
        sa.Column("exemption_until", sa.Date(), nullable=True),
    )
    op.create_check_constraint(
        "ck_memberships_exemption_type",
        "memberships",
        "exemption_type IS NULL OR exemption_type IN ('permanent','temporary')",
    )
    op.drop_column("memberships", "disabled_at")

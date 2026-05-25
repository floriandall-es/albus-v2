"""Per-offer response-kind preference on shift swap requests.

Previously every offer was a "pedir cobertura" but the responder
could pick either cover (do the shift, no payback) or swap
(trade for one of their own). For real-world flow that's not
always what the requester wants — sometimes they specifically
need a swap (they have to be free that day; only an exchange
helps) and sometimes they specifically want coverage (they're
going on holiday and won't be around to do a return shift).

New column `accepts` says which response kinds the requester
will entertain:

  - 'either'      — responder picks (legacy behaviour; DEFAULT
                    so existing rows preserve current semantics)
  - 'cover_only'  — responder may only offer cover
  - 'swap_only'   — responder may only offer a swap

The route layer enforces it on POST .../respond; the frontend
hides the disallowed button.

Revision ID: 0064_swap_offer_accepts
Revises: 0063_swap_offer_audience
Create Date: 2026-05-25
"""

import sqlalchemy as sa
from alembic import op


revision = "0064_swap_offer_accepts"
down_revision = "0063_swap_offer_audience"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "shift_swap_offers",
        sa.Column(
            "accepts",
            sa.String(16),
            nullable=False,
            server_default="either",
        ),
    )
    op.execute(
        "ALTER TABLE shift_swap_offers "
        "ADD CONSTRAINT ck_swap_offer_accepts "
        "CHECK (accepts IN ('cover_only', 'swap_only', 'either'))"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE shift_swap_offers "
        "DROP CONSTRAINT IF EXISTS ck_swap_offer_accepts"
    )
    op.drop_column("shift_swap_offers", "accepts")

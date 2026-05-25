"""Per-offer audience for shift swap requests.

Previously every active member of the tenant got the email when
anyone requested a cambio de turno. For a department with mixed
categorías that's noise — an "adjunto" asking for guardia coverage
doesn't want the residentes to receive the request (and a
residente probably can't cover the guardia anyway). The requester
should narrow who they ask: by categoría, by individual, or both.

Design:
  - Single nullable `audience_membership_ids INTEGER[]` column.
  - NULL = audience is the whole tenant (back-compat: existing
    open offers continue to behave as before).
  - Non-empty array = ONLY those memberships can see the offer
    in their list, respond to it, or receive the notification
    email. Anyone outside the array is treated as if the offer
    doesn't exist.
  - The requester is never required to include themselves; they
    can't respond to their own offer anyway.

We don't enforce categoría boundaries here — the frontend
resolves "by category" into the matching membership ids and
submits the explicit list. Keeping the storage as plain ids
means the visibility rule is one branch (`m.id = ANY(audience)`)
instead of "audience of X kinds with ambiguous union semantics".

Revision ID: 0063_swap_offer_audience
Revises: 0062_hospital_guardias_today
Create Date: 2026-05-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0063_swap_offer_audience"
down_revision = "0062_hospital_guardias_today"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "shift_swap_offers",
        sa.Column(
            "audience_membership_ids",
            postgresql.ARRAY(sa.Integer()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("shift_swap_offers", "audience_membership_ids")

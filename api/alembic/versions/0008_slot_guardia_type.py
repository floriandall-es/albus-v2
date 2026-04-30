"""sprint 5: slots.guardia_type

Free-text marker on a slot saying "this is a guardia of type X". The solver
matches it against Membership.guardia_types[]; if the string isn't there the
member can't cover the slot. No CHECK on the value — tenants invent their
own taxonomy ("presencial_24h", "localizada", "findes_festivos", whatever).

Revision ID: 0008_slot_guardia_type
Revises: 0007_schedules
Create Date: 2026-04-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0008_slot_guardia_type"
down_revision = "0007_schedules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "slots", sa.Column("guardia_type", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("slots", "guardia_type")

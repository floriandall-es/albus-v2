"""Per-user accent color preference.

Nurses (and clinicians in general) asked to personalise the
look of the app — a 30-second moment that makes Trivu feel
like *theirs*. We let each user pick from a curated palette
of 12 accent colours; the frontend resolves the choice into a
CSS-variable swap so every existing `bg-brand-*` / `text-brand-*`
class repaints without per-component edits.

Default value 'teal' = the current Trivu brand. Existing rows
get the default via server_default so nothing visually changes
for users who never open the picker.

Revision ID: 0065_person_preferred_accent
Revises: 0064_swap_offer_accepts
Create Date: 2026-05-25
"""

import sqlalchemy as sa
from alembic import op


revision = "0065_person_preferred_accent"
down_revision = "0064_swap_offer_accepts"
branch_labels = None
depends_on = None


# Mirrors the TypeScript ACCENT_PRESETS keys in
# web/src/lib/accent.ts. Keep in lockstep — the API rejects
# anything outside this set.
_ACCENT_VALUES = (
    "teal",
    "azul",
    "indigo",
    "violeta",
    "rosa",
    "ambar",
    "esmeralda",
    "pizarra",
    "cyan",
    "naranja",
    "lima",
    "fucsia",
)


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column(
            "preferred_accent",
            sa.String(16),
            nullable=False,
            server_default="teal",
        ),
    )
    values_sql = ", ".join(f"'{v}'" for v in _ACCENT_VALUES)
    op.execute(
        f"ALTER TABLE persons ADD CONSTRAINT ck_persons_preferred_accent "
        f"CHECK (preferred_accent IN ({values_sql}))"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE persons DROP CONSTRAINT IF EXISTS "
        "ck_persons_preferred_accent"
    )
    op.drop_column("persons", "preferred_accent")

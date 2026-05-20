"""Per-area setup completion flags on tenants.

Adds four nullable timestamps to `tenants`:
  - setup_activities_completed_at
  - setup_rules_completed_at
  - setup_team_completed_at
  - setup_subteams_completed_at

Each one is set when the admin clicks "Marcar como completado"
on the corresponding /admin subpage (slots, rules, team,
groups). The /admin Inicio dashboard reads these to decide
whether to surface each setup card and the first-visit banner
inside each subpage.

Explicit rather than heuristic: previous derived signals
("≥1 slot exists" etc.) lit up green the moment the admin
ticked any template in the onboarding wizard, which made the
"done" state useless on real signups. The admin now decides
when each area is done.

Existing tenants keep NULL — they'll see the checklist again
on their next visit, which is fine because the cards are also
short-circuited by the same explicit click.

Revision ID: 0042_tenant_setup_flags
Revises: 0041_tenant_has_subteams
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0042_tenant_setup_flags"
down_revision = "0041_tenant_has_subteams"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for col in (
        "setup_activities_completed_at",
        "setup_rules_completed_at",
        "setup_team_completed_at",
        "setup_subteams_completed_at",
    ):
        op.add_column(
            "tenants",
            sa.Column(col, sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    for col in (
        "setup_subteams_completed_at",
        "setup_team_completed_at",
        "setup_rules_completed_at",
        "setup_activities_completed_at",
    ):
        op.drop_column("tenants", col)

"""Add `preset_kind` to tenants — onboarding template chosen by the admin.

Captures which preset the admin picked on the new first onboarding
step (Servicio quirúrgico / Servicio médico / Otro). Stored on the
tenant so we can:
  - pre-fill subsequent wizard steps with sensible defaults,
  - drive future "smart suggestion" hints,
  - segment analytics by vertical without re-asking.

Nullable. Existing tenants (already past onboarding when this ships)
get NULL — they're never asked again, and downstream code treats
NULL as "unknown / Otro" for any default-suggestion logic.

Revision ID: 0029_tenant_preset_kind
Revises: 0028_person_first_last_name
Create Date: 2026-05-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0029_tenant_preset_kind"
down_revision = "0028_person_first_last_name"
branch_labels = None
depends_on = None


# Kept in sync with PRESET_KINDS in app.services.onboarding_presets.
_VALID_KINDS = ("quirurgico", "medico", "otro")


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("preset_kind", sa.String(length=32), nullable=True),
    )
    op.create_check_constraint(
        "ck_tenants_preset_kind",
        "tenants",
        f"preset_kind IS NULL OR preset_kind IN {_VALID_KINDS!r}",
    )


def downgrade() -> None:
    op.drop_constraint("ck_tenants_preset_kind", "tenants", type_="check")
    op.drop_column("tenants", "preset_kind")

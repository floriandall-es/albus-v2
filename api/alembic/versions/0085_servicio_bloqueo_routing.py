"""Servicio-wide bloqueo routing mode.

Adds `servicios.bloqueo_routing_mode` so the Jefe de Servicio (a
member whose person.cargos contains "Jefe de Servicio") can
centralise every bloqueo decision on themselves, instead of letting
each member pick their reviewer.

  - `delegated` (the default and the only behaviour before this
    migration): every member sees the picker on /me/bloqueos and
    chooses which admin in the servicio reviews their request.
  - `centralised`: the picker collapses to a read-only "Se enviará
    a {Jefe}" line and every new bloqueo auto-routes to the Jefe
    de Servicio's membership. The lookup happens at create-bloqueo
    time, so swapping who the Jefe is just works on the next
    request — no migration of the column needed.

Authorisation gate is at the API layer (only callers whose
person.cargos contains "jefe de servicio" can see / flip the
toggle). We keep the schema permissive — last-write-wins across
multiple Jefes is acceptable because in real-world hospital
services there's exactly one Jefe de Servicio, and changing your
cargo to claim the title is a visible action in the directorio.

If mode='centralised' but no Jefe currently exists in the servicio
(cargo not set on anyone, or the previous Jefe lost the cargo),
create_my_request falls back to delegated for that one request so
the system never blocks bloqueos because of a missing config.

Revision ID: 0085_servicio_bloqueo_routing
Revises: 0084_swap_admin_approval
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0085_servicio_bloqueo_routing"
down_revision = "0084_swap_admin_approval"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "servicios",
        sa.Column(
            "bloqueo_routing_mode",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'delegated'"),
        ),
    )
    op.create_check_constraint(
        "ck_servicios_bloqueo_routing_mode",
        "servicios",
        "bloqueo_routing_mode IN ('delegated', 'centralised')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_servicios_bloqueo_routing_mode", "servicios", type_="check"
    )
    op.drop_column("servicios", "bloqueo_routing_mode")

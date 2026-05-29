"""Default bloqueo routing to centralised when a Jefe exists.

Customer feedback on the migration-0085 work: when a Jefe de
Servicio exists in the servicio, bloqueos should route to them by
default — not require the Jefe to flip a toggle. The previous
default ('delegated') effectively meant "every Jefe must remember
to centralise themselves" which is a footgun: members raise
bloqueos to the wrong admin until the Jefe notices and fixes it.

The fix is a default flip — no schema reshape:

  - Change the column default from 'delegated' to 'centralised'.
  - Migrate existing rows: every `bloqueo_routing_mode = 'delegated'`
    row becomes `'centralised'`. Safe because the 0085 toggle has
    only been live in alpha for ~1 day; no customer has explicitly
    chosen delegated yet. Any servicio that doesn't have a Jefe is
    unaffected at runtime: _resolve_centralised_reviewer returns
    None when no jefe carries the cargo, so create_my_request
    transparently falls back to the delegated picker for that
    request.

The semantic is now: 'centralised' is the recommended default that
adapts at runtime (route to the Jefe if there's one, otherwise let
the member pick); 'delegated' is the explicit "even when a Jefe
exists, members should still pick" override.

Revision ID: 0086_bloqueo_routing_centralised_default
Revises: 0085_servicio_bloqueo_routing
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0086_bloqueo_routing_centralised_default"
down_revision = "0085_servicio_bloqueo_routing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Flip the column default first, then backfill any rows still
    # at the old default. Order doesn't actually matter (the UPDATE
    # rewrites the existing rows regardless of the column default),
    # but doing the DEFAULT first means concurrent INSERTs during
    # the migration get the new default value.
    op.alter_column(
        "servicios",
        "bloqueo_routing_mode",
        server_default=sa.text("'centralised'"),
    )
    op.execute(
        sa.text(
            "UPDATE servicios "
            "SET bloqueo_routing_mode = 'centralised' "
            "WHERE bloqueo_routing_mode = 'delegated'"
        )
    )


def downgrade() -> None:
    # Inverse: restore the old default. We DON'T retro-migrate
    # existing 'centralised' rows back to 'delegated' on downgrade,
    # because by then some servicios may have explicitly chosen
    # centralised via the toggle and we'd erase their choice.
    op.alter_column(
        "servicios",
        "bloqueo_routing_mode",
        server_default=sa.text("'delegated'"),
    )

"""Equipos redesign — Phase A: schema for Servicios + share policy.

This migration adds the structural pieces for the bigger
"sub-equipos → peer equipos under a Servicio" rework, without
moving any data yet. Subsequent migrations + scripts handle:

  - 0070 (Phase B): convert each existing `groups` row into a
    peer tenant under the same Servicio.
  - api/scripts/seed_hospitals_cnh.py (Phase A.5): ingest the
    Catálogo Nacional de Hospitales as the authoritative
    hospital list. Runs out of band when the operator has the
    CSV.
  - 0071 (Phase E): drop the groups table + the old per-group
    publication state + the lead role, after Phase B has run
    and the legacy code paths are deleted.

This migration alone is safe to ship: every column it adds is
either NULLABLE (servicio_id on tenants, the new hospital
fields) or has a server default that preserves today's
behaviour (share_policy='none', approval_state='approved',
shared_with_servicio=false). No existing query needs to change
for things to keep working.

Naming note
-----------
The new layer is called `servicios` in the DB. There is already
a `departments` table from migration 0001 — a vestigial
per-tenant "internal department" concept used only for a label
on /me. Rather than disturb it, we use the Spanish term
`servicios` for the new layer, which also matches the user-
facing copy ("Servicio de Cirugía Torácica"). The Python class
is `Servicio`; routes are `/api/servicios/...`.

Servicios
---------
A Servicio groups peer Equipos (Tenants) under a Hospital.
For the alpha customer: one Servicio "Cirugía Torácica" with
two Equipos ("Adjuntos" + "Residentes") — the residentes group
will be promoted from its current sub-equipo status in 0070.

For solo tenants (the common shape of every other tenant in
the DB right now) we still create a singleton Servicio: one
Tenant per Servicio. That removes a special case from the
code — "this tenant has no servicio peers" is just "a
Servicio containing one tenant" rather than a separate
NULL-servicio code path.

Share policy
------------
Each Tenant chooses what it exposes to other Equipos in its
Servicio:

  - 'none'     → nothing. Default for new signups.
  - 'selected' → only slots with shared_with_servicio=true.
  - 'full'     → every slot's assignments (read-only).

The migration sets share_policy='none' for every existing
tenant; Phase B will override the alpha customer to 'full' so
nothing visually regresses after the residentes split.

Approval state
--------------
Auto-approved for everything that exists today (we trust the
historical data). New tenants created against an existing
Servicio that already has approved siblings start in 'pending'
and need a sibling admin's nod before they appear in the
Servicio timeline + cross-tenant meeting audiences. The
first tenant in a brand-new Servicio is auto-approved (you
can't bootstrap otherwise). This logic lives in the signup
route added in Phase C — the column is just a flag here.

Hospital fields for CNH ingestion
---------------------------------
The Catálogo Nacional de Hospitales (Ministerio de Sanidad)
will populate `hospitals` as the authoritative list. Columns
added here so we don't need a second migration when the CSV
seeder runs:

  - public_code             stable identifier (CNH code).
                            Partial UNIQUE index — only enforced
                            when set, since legacy rows have no
                            code yet.
  - city, province          denormalised from the catalog so
                            queries don't need a separate
                            location table.
  - autonomous_community    same.

All nullable today; the CNH seed script fills them and Phase D
signup forbids creating a hospital row that lacks them.

Revision ID: 0069_equipos_servicio_schema
Revises: 0068_violation_suppressions
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from alembic import op


revision = "0069_equipos_servicio_schema"
down_revision = "0068_violation_suppressions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------
    # 1. servicios table
    # ------------------------------------------------------------
    op.create_table(
        "servicios",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "hospital_id",
            sa.Integer,
            sa.ForeignKey("hospitals.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Display name — "Cirugía Torácica", "Anestesia", etc.
        sa.Column("name", sa.String(length=255), nullable=False),
        # URL-safe slug, unique within a hospital. Used in eventual
        # `/h/{hospital_slug}/s/{servicio_slug}` routes if we go
        # public. UNIQUE on (hospital_id, slug) so two hospitals can
        # both have a "cirugia-toracica" servicio.
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "hospital_id", "slug", name="uq_servicios_hospital_slug"
        ),
    )
    # No RLS on servicios — they sit ABOVE the tenant boundary,
    # same as hospitals. Anyone authenticated can read; the app role
    # writes via signup find-or-create + admin tooling.
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON servicios TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE servicios_id_seq TO albus_app")

    # ------------------------------------------------------------
    # 2. tenants: servicio_id + share_policy + approval_state
    # ------------------------------------------------------------
    op.add_column(
        "tenants",
        sa.Column(
            "servicio_id",
            sa.Integer,
            sa.ForeignKey("servicios.id", ondelete="RESTRICT"),
            nullable=True,
            index=True,
        ),
    )
    op.add_column(
        "tenants",
        sa.Column(
            "share_policy",
            sa.String(length=16),
            nullable=False,
            server_default="none",
        ),
    )
    op.execute(
        "ALTER TABLE tenants ADD CONSTRAINT ck_tenants_share_policy "
        "CHECK (share_policy IN ('none', 'selected', 'full'))"
    )
    op.add_column(
        "tenants",
        sa.Column(
            "approval_state",
            sa.String(length=16),
            nullable=False,
            server_default="approved",
        ),
    )
    op.execute(
        "ALTER TABLE tenants ADD CONSTRAINT ck_tenants_approval_state "
        "CHECK (approval_state IN ('pending', 'approved'))"
    )

    # ------------------------------------------------------------
    # 3. slots: shared_with_servicio per-slot flag
    # ------------------------------------------------------------
    # Only consulted when the tenant's share_policy = 'selected'.
    # The other two policies ('none', 'full') ignore this column.
    # Default false so nothing leaks by accident; the Phase D admin
    # UI lets the equipo admin toggle per slot.
    op.add_column(
        "slots",
        sa.Column(
            "shared_with_servicio",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    # ------------------------------------------------------------
    # 4. hospitals: CNH-derived fields
    # ------------------------------------------------------------
    op.add_column(
        "hospitals",
        sa.Column("public_code", sa.String(length=32), nullable=True),
    )
    # Partial UNIQUE so existing rows (NULL code) don't collide with
    # each other; once the CNH seeder runs every row gets a code and
    # the index enforces it.
    op.create_index(
        "ux_hospitals_public_code",
        "hospitals",
        ["public_code"],
        unique=True,
        postgresql_where=sa.text("public_code IS NOT NULL"),
    )
    op.add_column(
        "hospitals",
        sa.Column("city", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "hospitals",
        sa.Column("province", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "hospitals",
        sa.Column(
            "autonomous_community",
            sa.String(length=128),
            nullable=True,
        ),
    )
    op.create_index("ix_hospitals_city", "hospitals", ["city"])

    # ------------------------------------------------------------
    # 5. Backfill servicios for tenants that have a hospital
    # ------------------------------------------------------------
    # For each tenant with a hospital_id, create a singleton
    # Servicio named after the tenant. Slug is the tenant slug —
    # uniqueness is on (hospital_id, slug), and we know tenant slugs
    # are globally unique, so no collisions inside a hospital.
    #
    # Tenants with hospital_id IS NULL are left with servicio_id
    # IS NULL. Those are legacy tenants that pre-date the Hospital
    # layer (sprint 28 / migration 0051) and never got linked. They
    # keep working as before; an operator will need to attach them
    # to a hospital + servicio before they can use any
    # Servicio-level features. We deliberately don't fail the
    # migration on them — the alpha customer has hospital_id set.
    op.execute(
        """
        INSERT INTO servicios (hospital_id, name, slug, created_at)
        SELECT t.hospital_id, t.name, t.slug, now()
        FROM tenants t
        WHERE t.hospital_id IS NOT NULL
        ON CONFLICT (hospital_id, slug) DO NOTHING
        """
    )
    op.execute(
        """
        UPDATE tenants t
        SET servicio_id = s.id
        FROM servicios s
        WHERE s.hospital_id = t.hospital_id
          AND s.slug = t.slug
          AND t.servicio_id IS NULL
        """
    )

    # NOTE on NOT NULL tightening
    # ---------------------------
    # We intentionally keep tenants.servicio_id NULLABLE for now.
    # A follow-up migration (after operator data cleanup) will:
    #   - ensure every tenant has a hospital_id (some legacy ones
    #     don't)
    #   - run the same backfill again for any that show up
    #   - then ALTER COLUMN ... SET NOT NULL on both hospital_id and
    #     servicio_id.
    # Keeping it nullable means this migration is safe to run on any
    # snapshot, including ones with orphan tenants.


def downgrade() -> None:
    op.drop_index("ix_hospitals_city", table_name="hospitals")
    op.drop_index("ux_hospitals_public_code", table_name="hospitals")
    op.drop_column("hospitals", "autonomous_community")
    op.drop_column("hospitals", "province")
    op.drop_column("hospitals", "city")
    op.drop_column("hospitals", "public_code")

    op.drop_column("slots", "shared_with_servicio")

    op.execute("ALTER TABLE tenants DROP CONSTRAINT IF EXISTS ck_tenants_approval_state")
    op.drop_column("tenants", "approval_state")
    op.execute("ALTER TABLE tenants DROP CONSTRAINT IF EXISTS ck_tenants_share_policy")
    op.drop_column("tenants", "share_policy")
    op.drop_column("tenants", "servicio_id")

    op.execute("REVOKE ALL ON servicios FROM albus_app")
    op.drop_table("servicios")

"""Transplants (trasplantes).

Adds two tenant-scoped tables for the customer's transplant case
log. The alpha-customer (a thoracic surgery / lung transplant
service) tracks every transplant they participate in — both
fully-local cases (donor extracted AND recipient operated here)
and cross-hospital cases (we only did the extraction and shipped
the organ elsewhere, or received an organ that was extracted
remotely).

Data model — two tables:

  transplant_cases(id, tenant_id, external_case_id, occurred_on,
                   notes, created_at, updated_at)

  transplant_procedures(id, tenant_id, case_id, type,
                        occurred_at, primary_person_id,
                        secondary_person_id, notes, created_at)

A "case" is one transplant patient / one organ. Each case has 1
or 2 procedures:
  - EXPLANTE = donor lung extraction
  - IMPLANTE = recipient surgery

Most local cases have both; cross-hospital cases have just one,
with the missing half done elsewhere.

`external_case_id` carries the source system's case number for
traceability after migration (the legacy tool issued sequential
case numbers used in donor coordination paperwork).

`primary_person_id` and `secondary_person_id` are NULLABLE: when
the organ is received from another hospital we have no local
surgeon attribution, so the procedure carries NULL + a free-text
"Recibido X" in notes.

RLS + albus_app grants follow the standard tenant-isolation
pattern.

Revision ID: 0045_transplants
Revises: 0044_slot_name_unique_per_group
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op


revision = "0045_transplants"
down_revision = "0044_slot_name_unique_per_group"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "transplant_cases",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # External identifier from whatever upstream system issued
        # the case number (donor coordination paperwork, organ
        # network ID, etc.). Kept for traceability; not unique
        # per-tenant because the customer may legitimately have
        # gaps or duplicates from cross-hospital coordination.
        sa.Column("external_case_id", sa.String(length=64), nullable=True),
        # Case date — derived at write time from the procedures'
        # occurred_at. Indexed for the chronological list view.
        sa.Column("occurred_on", sa.Date, nullable=False),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_transplant_cases_tenant_occurred",
        "transplant_cases",
        ["tenant_id", "occurred_on"],
    )

    op.execute("ALTER TABLE transplant_cases ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE transplant_cases FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY transplant_cases_tenant_isolation ON transplant_cases
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON transplant_cases TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE transplant_cases_id_seq TO albus_app"
    )

    op.create_table(
        "transplant_procedures",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "case_id",
            sa.Integer,
            sa.ForeignKey("transplant_cases.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        # Surgeons are NULLABLE because cross-hospital cases have
        # no local attribution for the half done elsewhere. The
        # frontend renders "Recibido de X" / "Enviado a X" from
        # notes when there's no local primary surgeon.
        sa.Column(
            "primary_person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "secondary_person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "type IN ('explante','implante')",
            name="ck_transplant_procedures_type",
        ),
        sa.CheckConstraint(
            # Primary != secondary so we don't accidentally record
            # the same person twice on one procedure.
            "primary_person_id IS NULL OR secondary_person_id IS NULL "
            "OR primary_person_id <> secondary_person_id",
            name="ck_transplant_procedures_distinct_surgeons",
        ),
    )
    op.create_index(
        "ix_transplant_procedures_primary_person",
        "transplant_procedures",
        ["tenant_id", "primary_person_id"],
    )
    op.create_index(
        "ix_transplant_procedures_secondary_person",
        "transplant_procedures",
        ["tenant_id", "secondary_person_id"],
    )

    op.execute(
        "ALTER TABLE transplant_procedures ENABLE ROW LEVEL SECURITY"
    )
    op.execute(
        "ALTER TABLE transplant_procedures FORCE ROW LEVEL SECURITY"
    )
    op.execute(
        """
        CREATE POLICY transplant_procedures_tenant_isolation ON transplant_procedures
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON transplant_procedures TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE transplant_procedures_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_table("transplant_procedures")
    op.drop_table("transplant_cases")

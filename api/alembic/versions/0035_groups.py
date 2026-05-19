"""Sub-team groups inside a tenant.

Lets a tenant carve out a sub-cohort (e.g. residentes) whose
admin is a designated lead — not the tenant admin. The lead has
admin rights for that group only: their members, their slots,
their assignments. Manual-only scheduling (no solver, no
rotations, no rules — see migration NOT applied here, enforced
at the route + solver layers).

New table:
  groups(id, tenant_id, name, lead_membership_id, created_at)

New columns:
  memberships.group_id  → which group a member belongs to (nullable)
  slots.group_id        → which group "owns" an activity (nullable)

Both nullable because the common case is "main team" (no group).
A tenant can have many groups; a person and a slot each belong
to at most one.

lead_membership_id is nullable for two reasons: SET NULL on
membership delete (so we don't cascade-delete the group when its
lead leaves), and create-then-assign workflow (create the group,
then pick a lead from its members).

RLS + albus_app grants on the new table follow the same pattern
as every other tenant-scoped table.

Revision ID: 0035_groups
Revises: 0034_incidents
Create Date: 2026-05-19
"""

import sqlalchemy as sa
from alembic import op

revision = "0035_groups"
down_revision = "0034_incidents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "groups",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "lead_membership_id",
            sa.Integer,
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("tenant_id", "name", name="uq_groups_tenant_name"),
    )

    op.execute("ALTER TABLE groups ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE groups FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY groups_tenant_isolation ON groups
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON groups TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE groups_id_seq TO albus_app")

    op.add_column(
        "memberships",
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )
    op.add_column(
        "slots",
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("slots", "group_id")
    op.drop_column("memberships", "group_id")
    op.drop_table("groups")

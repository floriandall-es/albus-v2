"""Per-group publication marker for schedules.

A Schedule entity has a status (draft / published / archived)
that gates visibility of MAIN TEAM assignments to members.
Group slots don't fit that gate cleanly: their assignments are
written manually by the group's lead, independent of the
tenant admin's "Generar nueva + Publicar" lifecycle.

This migration adds `schedule_group_publications` to track a
separate "lead has published this group's plan for this month"
fact. One row per (schedule, group). Presence of the row makes
the group's assignments visible to its members in /me/turnos;
absence keeps them hidden (residents see drafts via the
group's own UI only).

Either side — the group's lead or the tenant admin — can
publish or unpublish on behalf of a group.

Revision ID: 0036_group_publications
Revises: 0035_groups
Create Date: 2026-05-19
"""

import sqlalchemy as sa
from alembic import op

revision = "0036_group_publications"
down_revision = "0035_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schedule_group_publications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "schedule_id",
            sa.Integer,
            sa.ForeignKey("schedules.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "published_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "published_by_membership_id",
            sa.Integer,
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "schedule_id", "group_id", name="uq_sched_group_publication"
        ),
    )

    op.execute("ALTER TABLE schedule_group_publications ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE schedule_group_publications FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY schedule_group_publications_tenant_isolation
        ON schedule_group_publications
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_group_publications TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE schedule_group_publications_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_table("schedule_group_publications")

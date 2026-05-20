"""Meetings (reuniones).

Adds three tables for the meetings feature:

  meetings(id, tenant_id, kind, title, description, location,
           date, start_time, end_time, weekday,
           include_main_team, organizer_membership_id, created_at)

  meeting_audience_groups(id, tenant_id, meeting_id, group_id)
  meeting_audience_persons(id, tenant_id, meeting_id, person_id)

Two kinds of meeting share one table:
  - kind='regular' → recurring weekly. weekday set (0=Mon..6=Sun),
    date NULL. The /meetings/instances endpoint expands this into
    concrete occurrences when a caller asks for a date range.
  - kind='ad_hoc'  → one-off. date set, weekday NULL.

Audience is the union of:
  - include_main_team boolean on the meeting (true → everyone in
    the main team is invited),
  - meeting_audience_groups rows (each adds a whole sub-equipo),
  - meeting_audience_persons rows (each adds one specific person).

The dedicated boolean for the main team avoids needing a NULL-able
group_id with a sentinel value. Same outcome, no NULL semantics
to reason about.

RLS + albus_app grants follow the standard tenant-isolation
pattern used by every other tenant-scoped table.

Revision ID: 0037_meetings
Revises: 0036_group_publications
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0037_meetings"
down_revision = "0036_group_publications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "meetings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("location", sa.String(length=255), nullable=True),
        # Concrete date for ad-hoc one-offs. NULL for the weekly
        # template of a regular meeting.
        sa.Column("date", sa.Date, nullable=True),
        sa.Column("start_time", sa.Time, nullable=False),
        sa.Column("end_time", sa.Time, nullable=False),
        # 0=Monday..6=Sunday. Required for kind='regular', NULL
        # for kind='ad_hoc'.
        sa.Column("weekday", sa.SmallInteger, nullable=True),
        # True → everyone in the main team is invited. Combined
        # with the per-group and per-person audience tables to
        # decide visibility for a given caller.
        sa.Column(
            "include_main_team",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "organizer_membership_id",
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
        sa.CheckConstraint(
            "kind IN ('regular','ad_hoc')",
            name="ck_meetings_kind",
        ),
        sa.CheckConstraint(
            "(kind = 'regular' AND weekday IS NOT NULL AND date IS NULL) "
            "OR (kind = 'ad_hoc' AND date IS NOT NULL AND weekday IS NULL)",
            name="ck_meetings_kind_shape",
        ),
        sa.CheckConstraint(
            "weekday IS NULL OR (weekday >= 0 AND weekday <= 6)",
            name="ck_meetings_weekday_range",
        ),
        sa.CheckConstraint(
            "end_time > start_time",
            name="ck_meetings_time_order",
        ),
    )

    op.execute("ALTER TABLE meetings ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE meetings FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY meetings_tenant_isolation ON meetings
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON meetings TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE meetings_id_seq TO albus_app")

    op.create_table(
        "meeting_audience_groups",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "meeting_id",
            sa.Integer,
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
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
        sa.UniqueConstraint(
            "meeting_id", "group_id", name="uq_meeting_audience_group"
        ),
    )
    op.execute(
        "ALTER TABLE meeting_audience_groups ENABLE ROW LEVEL SECURITY"
    )
    op.execute(
        "ALTER TABLE meeting_audience_groups FORCE ROW LEVEL SECURITY"
    )
    op.execute(
        """
        CREATE POLICY meeting_audience_groups_tenant_isolation
        ON meeting_audience_groups
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_audience_groups TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE meeting_audience_groups_id_seq TO albus_app"
    )

    op.create_table(
        "meeting_audience_persons",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "meeting_id",
            sa.Integer,
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.UniqueConstraint(
            "meeting_id", "person_id", name="uq_meeting_audience_person"
        ),
    )
    op.execute(
        "ALTER TABLE meeting_audience_persons ENABLE ROW LEVEL SECURITY"
    )
    op.execute(
        "ALTER TABLE meeting_audience_persons FORCE ROW LEVEL SECURITY"
    )
    op.execute(
        """
        CREATE POLICY meeting_audience_persons_tenant_isolation
        ON meeting_audience_persons
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_audience_persons TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE meeting_audience_persons_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_table("meeting_audience_persons")
    op.drop_table("meeting_audience_groups")
    op.drop_table("meetings")

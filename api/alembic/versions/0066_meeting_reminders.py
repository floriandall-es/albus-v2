"""Meeting reminders.

Lets the meeting creator opt into an email reminder fired some
number of minutes before the meeting starts. Valid offsets are a
fixed preset list (15 min / 1 h / 3 h / 1 día / 1 semana) — the
API rejects anything else with a 422.

Two changes:

  - `meetings.reminder_minutes_before` (Integer, nullable). NULL
    means no reminder; default for everything created before this
    migration.

  - `meeting_reminders_sent` log table with UNIQUE
    (meeting_id, instance_date). Lets the worker tick every few
    minutes idempotently — if the API container restarts mid-
    tick or two workers race, the UNIQUE constraint guarantees
    each (meeting, instance_date) gets emailed at most once.

GRANTs the new table to the runtime role, matching the pattern
hotfixed for migration 0058.

Revision ID: 0066_meeting_reminders
Revises: 0065_person_preferred_accent
Create Date: 2026-05-25
"""

import sqlalchemy as sa
from alembic import op


revision = "0066_meeting_reminders"
down_revision = "0065_person_preferred_accent"
branch_labels = None
depends_on = None


# Mirrors REMINDER_OFFSETS in api/app/services/meeting_reminders.py
# and the frontend dropdown. Keep in lockstep.
_VALID_MINUTES = (15, 60, 180, 1440, 10080)


def upgrade() -> None:
    op.add_column(
        "meetings",
        sa.Column("reminder_minutes_before", sa.Integer(), nullable=True),
    )
    values_sql = ", ".join(str(v) for v in _VALID_MINUTES)
    op.execute(
        f"ALTER TABLE meetings ADD CONSTRAINT ck_meetings_reminder_minutes "
        f"CHECK (reminder_minutes_before IS NULL OR "
        f"reminder_minutes_before IN ({values_sql}))"
    )

    op.create_table(
        "meeting_reminders_sent",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "meeting_id",
            sa.Integer(),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("instance_date", sa.Date(), nullable=False),
        sa.Column(
            "sent_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("recipient_count", sa.Integer(), nullable=False),
        sa.UniqueConstraint(
            "meeting_id",
            "instance_date",
            name="uq_meeting_reminders_sent",
        ),
    )
    # Same GRANT pattern used by every other table the runtime
    # role writes to (see migration 0059 hotfix for the
    # consequence of forgetting this).
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_reminders_sent "
        "TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE meeting_reminders_sent_id_seq "
        "TO albus_app"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE ALL ON meeting_reminders_sent FROM albus_app"
    )
    op.drop_table("meeting_reminders_sent")
    op.execute(
        "ALTER TABLE meetings DROP CONSTRAINT IF EXISTS "
        "ck_meetings_reminder_minutes"
    )
    op.drop_column("meetings", "reminder_minutes_before")

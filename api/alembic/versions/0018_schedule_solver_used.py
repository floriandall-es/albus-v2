"""Add schedules.solver_used to record which engine produced the schedule.

Values: 'cpsat' (CP-SAT optimal/feasible), 'greedy' (round-robin
fallback). Null on rows generated before this migration. The UI uses
this to badge the planning view so admins know whether fairness/spread
terms were honoured (they are NOT in the greedy fallback).

Revision ID: 0018_schedule_solver_used
Revises: 0017_succession_same_day
Create Date: 2026-05-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0018_schedule_solver_used"
down_revision = "0017_succession_same_day"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "schedules",
        sa.Column("solver_used", sa.String(length=16), nullable=True),
    )
    op.create_check_constraint(
        "ck_schedules_solver_used",
        "schedules",
        "solver_used IS NULL OR solver_used IN ('cpsat','greedy')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_schedules_solver_used", "schedules", type_="check"
    )
    op.drop_column("schedules", "solver_used")

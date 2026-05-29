"""Per-tenant pulse question overrides — reword + toggle.

Admins can rewrite the prompt of any built-in question (to match
team vocabulary) and disable individual questions they don't want
asked. Scale, scale_max, labels and the underlying key stay fixed
so historical responses still align with the new effective set.

Storage shape: a single JSONB column on pulse_settings. The
object is keyed by question_key. Each value is itself an object
with optional `prompt` (string) and optional `enabled` (bool).
Missing keys mean "use the in-code default". Missing fields
inside a present key mean "use the in-code default for that
field". Example for a tenant that reworded fairness and disabled
the workload question:

  {
    "fairness": {"prompt": "Tu reparto te ha tratado bien?"},
    "workload": {"enabled": false}
  }

We don't store a separate row per key because the override count
per tenant is bounded (8 today, 12+ if we add more rotating
questions) — a JSONB column is plenty and keeps every override
read in the same row as the on/off toggle.

Revision ID: 0091_pulse_question_overrides
Revises: 0090_pulse_surveys
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0091_pulse_question_overrides"
down_revision = "0090_pulse_surveys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "pulse_settings",
        sa.Column(
            "question_overrides",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("pulse_settings", "question_overrides")

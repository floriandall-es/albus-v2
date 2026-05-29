"""Pulse surveys — weekly team-wellbeing check-in.

Two tables:

  * `pulse_settings` — one row per tenant. Holds the on/off toggle
    (default OFF — opt-in feature) and `last_notified_week_iso` for
    the Friday-fan-out idempotency. Future custom-question overrides
    will land here as a JSONB column when we ship the editor.

  * `pulse_responses` — one row per (person, ISO week, question_key).
    UNIQUE on those three so the POST endpoint is an upsert with
    well-defined semantics. Hard close: the route layer rejects any
    POST whose week_iso doesn't match the current ISO week (Monday
    0:00 Europe/Madrid → ISO week tick → previous week is immutable).

Both are tenant-scoped with RLS — pulse data is per-team and never
crosses tenants. Aggregation queries on the admin side run through
the standard RLS-bound session so a jefe can never accidentally
read another tenant's responses.

Why ISO week as the bucket: ISO 8601 weeks are unambiguous across
years, sort lexically, and let us use a TEXT column ("2026-W22")
that humans can read in psql without timezone arithmetic. The
underlying Sunday-night hard close is implicit in the ISO week
boundary (Monday is day 1).

Revision ID: 0090_pulse_surveys
Revises: 0089_push_subscriptions
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0090_pulse_surveys"
down_revision = "0089_push_subscriptions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pulse_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Default OFF — pulse surveys are an opt-in feature. The
        # admin flips this on from /admin/pulso. Until it's on, no
        # Friday push fires for the tenant and no /me/pulso card
        # appears on member home screens.
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        # Set by the worker after a successful Friday fan-out. Format:
        # "YYYY-Www". The worker compares this to the current ISO
        # week each tick; matching means "already notified, skip".
        # NULL means "never notified yet" (fresh enable).
        sa.Column(
            "last_notified_week_iso",
            sa.String(length=8),
            nullable=True,
        ),
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
            nullable=False,
        ),
        sa.UniqueConstraint(
            "tenant_id", name="uq_pulse_settings_tenant"
        ),
    )
    op.create_table(
        "pulse_responses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # ISO week the response is for. The route rejects POSTs for
        # anything that isn't the current ISO week → past weeks
        # become immutable as soon as the Monday boundary passes.
        # 8 chars covers "YYYY-Www".
        sa.Column(
            "week_iso", sa.String(length=8), nullable=False
        ),
        # Question identifier from the in-code catalogue
        # (app/services/pulse.py::CORE_QUESTIONS + ROTATING_QUESTIONS).
        # We use a stable string key rather than a FK so question
        # text can evolve (translation tweaks, A/B testing) without
        # migration churn — the key is the contract, not the prompt.
        sa.Column(
            "question_key", sa.String(length=32), nullable=False
        ),
        # 1-N integer (scale_max varies per question; usually 4 or
        # 5). Validated route-side against the question definition.
        sa.Column("score", sa.SmallInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Upsert key. The POST endpoint uses ON CONFLICT DO UPDATE
        # so a respondent who taps the wrong button and re-answers
        # before submitting just overwrites — clean intent, no
        # "last write wins" surprises.
        sa.UniqueConstraint(
            "person_id",
            "week_iso",
            "question_key",
            name="uq_pulse_responses_person_week_question",
        ),
        # Aggregation queries always group by (tenant_id, week_iso,
        # question_key). Compound index supports that without
        # needing to scan the whole table.
        sa.Index(
            "ix_pulse_responses_aggregate",
            "tenant_id",
            "week_iso",
            "question_key",
        ),
    )
    # RLS — same pattern every tenant-scoped table follows.
    for table in ("pulse_settings", "pulse_responses"):
        op.execute(
            f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"
        )
        op.execute(
            f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY"
        )
        op.execute(
            f"""
            CREATE POLICY {table}_tenant_isolation ON {table}
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
            """
        )
    # GRANTs in the same migration — learned from the 0058 → 0059
    # hotfix pattern.
    for table in ("pulse_settings", "pulse_responses"):
        op.execute(
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO albus_app"
        )
        op.execute(
            f"GRANT USAGE, SELECT ON SEQUENCE {table}_id_seq TO albus_app"
        )


def downgrade() -> None:
    for table in ("pulse_responses", "pulse_settings"):
        op.execute(
            f"REVOKE SELECT, INSERT, UPDATE, DELETE ON {table} FROM albus_app"
        )
        op.execute(
            f"REVOKE USAGE, SELECT ON SEQUENCE {table}_id_seq FROM albus_app"
        )
        op.execute(
            f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}"
        )
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.drop_table("pulse_responses")
    op.drop_table("pulse_settings")

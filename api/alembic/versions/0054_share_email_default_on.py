"""Flip `memberships.share_email` to default ON.

Sprint 28 / directory slice 1 follow-up. After shipping 0053, we
reviewed the privacy gradient:

- Email is institutional in clinical practice (already on every
  signature, badge, ticket). Defaulting it OFF kept the directory
  empty of contact methods for no real privacy gain.
- Phone is genuinely personal. Stays opt-IN.
- WhatsApp shares the phone field, so its effective default is
  governed by whether a number is entered. Stays opt-IN.

This migration:
  - Changes the column server-default for `share_email` to TRUE.
  - Backfills existing memberships whose Person has a real email
    (not the `@trivu.invalid` placeholder used by migrate_legacy
    for persons with no real address on file).

`share_phone` and `share_whatsapp` are untouched — still default
FALSE.

Revision ID: 0054_share_email_default_on
Revises: 0053_contact_channels
Create Date: 2026-05-23
"""

from alembic import op
import sqlalchemy as sa


revision = "0054_share_email_default_on"
down_revision = "0053_contact_channels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Flip the server-default to true so new memberships start
    # visible-by-email.
    op.alter_column(
        "memberships",
        "share_email",
        server_default=sa.text("true"),
    )
    # Backfill: opt every existing membership in whose Person has
    # a real email address. Skip placeholders that migrate_legacy
    # created for persons without an on-file address — surfacing
    # `@trivu.invalid` in the directory is worse than not showing
    # anything because the link would bounce.
    op.execute(
        """
        UPDATE memberships m
        SET share_email = TRUE
        FROM persons p
        WHERE m.person_id = p.id
          AND m.share_email = FALSE
          AND p.email NOT LIKE '%@trivu.invalid'
        """
    )


def downgrade() -> None:
    # Restore the original FALSE default. We don't try to "un-backfill"
    # the rows that were flipped — the upgrade was opt-in
    # implicit-consent, so the rows that landed in TRUE represent
    # the actual desired state, not a temporary migration artefact.
    op.alter_column(
        "memberships",
        "share_email",
        server_default=sa.text("false"),
    )

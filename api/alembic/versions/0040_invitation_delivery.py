"""Invitation email-delivery tracking.

Adds two columns to invitations:
  - last_email_sent_at  TIMESTAMPTZ NULL
  - last_email_error    TEXT NULL

`send_invitation_email` will set last_email_sent_at on SMTP
success and last_email_error to the formatted exception
message on failure. The admin UI surfaces this as a pill on
each pending invitation row ("Enviado" / "Falló" / "No
enviado") so an SMTP outage or typo'd address is visible
instead of silently lost.

Resending an invitation (POST /api/invitations/{id}/resend)
rotates the token and re-runs the email, clearing the error
on the next successful send.

Revision ID: 0040_invitation_delivery
Revises: 0039_terms_acceptance
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0040_invitation_delivery"
down_revision = "0039_terms_acceptance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "invitations",
        sa.Column(
            "last_email_sent_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "invitations",
        sa.Column("last_email_error", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("invitations", "last_email_error")
    op.drop_column("invitations", "last_email_sent_at")

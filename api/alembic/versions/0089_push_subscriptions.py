"""Web Push subscriptions — per-device tokens for browser notifications.

Each row is one device subscription: a browser, on a specific machine,
that has agreed to receive notifications. A single person can have many
(home laptop + work desktop + phone PWA), and one person+device combo
can re-subscribe over time (browser cleared, granted re-permission)
generating fresh endpoints.

`endpoint` is the URL the push service (FCM for Chrome/Edge, Mozilla
autopush for Firefox, Apple for iOS Safari PWAs) hands the browser
when it subscribes. We POST a signed JWT + encrypted payload there to
deliver a push. `p256dh` + `auth` are the per-subscription encryption
keys; pywebpush uses them to encrypt the payload so only that browser
can read it.

`user_agent` is opaque metadata for the user-facing "manage devices"
panel ("Safari 17.5 iPhone · last used 3h ago"). Optional — older
browsers may not send it, or future privacy modes may strip it.

Table is NOT RLS-scoped. Subscriptions belong to a person, not a
tenant; gating on tenant would break cross-tenant DMs (someone in
Servicio A can DM someone in Servicio B at the same hospital and the
recipient still needs the push). Authorisation is enforced at the
route layer: every read/write is filtered by `person_id = ctx.person.id`.

The unique constraint on `endpoint` makes the subscribe POST naturally
idempotent — same browser re-subscribing on a page refresh just bumps
`last_used_at` rather than creating duplicate rows.

ON DELETE CASCADE from persons means deleting an account cleans up
its subscriptions automatically.

Revision ID: 0089_push_subscriptions
Revises: 0088_group_chats
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0089_push_subscriptions"
down_revision = "0088_group_chats"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # Push endpoint URL. ~200-500 chars in practice for FCM; we
        # cap at TEXT to avoid surprises if a vendor extends theirs.
        # UNIQUE so re-subscribing the same browser upserts cleanly.
        sa.Column("endpoint", sa.Text(), nullable=False),
        # Curve25519 public key for the subscription (base64url).
        # ~88 chars. Required for pywebpush encryption.
        sa.Column("p256dh", sa.Text(), nullable=False),
        # Per-subscription authentication secret (base64url). ~24 chars.
        # Required for pywebpush encryption.
        sa.Column("auth", sa.Text(), nullable=False),
        # Browser/device descriptor. Surfaced in the "manage devices"
        # panel so a user can recognise + revoke a stale subscription
        # ("Safari 17 iPhone — last used 3 weeks ago"). NULL when the
        # subscribe request didn't carry one.
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Bumped on every successful push send. Drives both UI
        # ("last used X ago") and the future cleanup job that
        # prunes subscriptions silent for >60 days.
        sa.Column(
            "last_used_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.UniqueConstraint(
            "endpoint", name="uq_push_subscriptions_endpoint"
        ),
    )
    # Grant runtime role privileges in the SAME migration this time —
    # learned from 0058 where the forgotten GRANT shipped a 500 to
    # production until 0059 hotfixed it.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions "
        "TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE push_subscriptions_id_seq "
        "TO albus_app"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE, DELETE ON push_subscriptions "
        "FROM albus_app"
    )
    op.execute(
        "REVOKE USAGE, SELECT ON SEQUENCE push_subscriptions_id_seq "
        "FROM albus_app"
    )
    op.drop_table("push_subscriptions")

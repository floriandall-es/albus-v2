"""Migration 0089: web push subscriptions.

One row per device-subscription. See the migration docstring for the
data-model rationale (no RLS, endpoint UNIQUE, ON DELETE CASCADE
from persons).
"""

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint(
            "endpoint", name="uq_push_subscriptions_endpoint"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Push service URL handed to the browser at subscribe time. We
    # POST signed/encrypted payloads here. UNIQUE so a browser
    # re-subscribing on a refresh upserts cleanly rather than
    # accumulating duplicates.
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    # Curve25519 public key for the subscription (base64url, ~88
    # chars). Used by pywebpush to encrypt payloads so only this
    # browser can read them.
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    # Per-subscription auth secret (base64url, ~24 chars). Also
    # required for pywebpush encryption.
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    # Browser/device descriptor for the "manage devices" panel.
    # Optional — older browsers / privacy modes may strip it.
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    # Bumped on every successful push send. Drives the "last used"
    # row in the UI and the future >60-day cleanup job.
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

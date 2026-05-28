"""StripeEvent — webhook idempotency + audit log.

Stripe re-delivers events on any non-2xx response, on timeouts,
and even occasionally on success (network blips). The webhook
handler is therefore required to be idempotent: each Stripe event
ID is processed exactly once.

We enforce that with a UNIQUE constraint on `event_id`: the very
first thing the webhook handler does is `INSERT … ON CONFLICT DO
NOTHING` here. If the insert is a no-op the event was already
seen and we 200 immediately without touching the business
logic. Otherwise we proceed and stamp `processed_at` when done.

The `payload` column keeps the full Stripe event body so we can
inspect / replay a misbehaved webhook locally without needing a
fresh Stripe call. JSONB so we can index into it later if needed.

See docs/billing-plan.md, chunk 4 ("Webhook endpoint").
"""

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class StripeEvent(Base):
    __tablename__ = "stripe_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Stripe's `evt_xxxxx` identifier. UNIQUE — the webhook handler
    # short-circuits on duplicate inserts.
    event_id: Mapped[str] = mapped_column(
        Text, nullable=False, unique=True
    )
    type: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    # NULL while the handler is in-flight. Stamped on successful
    # completion. Combined with `error` we can see stuck events.
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

"""Admin promotion consent flow (migration 0087).

Under members_pay, a promoted admin pays a higher Stripe price
than they did as a member. We can't unilaterally change someone's
recurring charge, so this row tracks the handshake: admin creates
a request, email goes to the target, target accepts or declines.
On accept we grant the role + swap the Stripe item.

Lifecycle:
  pending  → accepted | declined | cancelled | expired
where cancelled = admin withdrew before the target decided, and
expired = the TTL passed with no decision (housekeeping sweep
flips these — see routes/team_admin_promotion.py).
"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AdminPromotionRequest(Base):
    __tablename__ = "admin_promotion_requests"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')",
            name="ck_admin_promotion_status",
        ),
        # At most one open promotion per target — prevents duplicate
        # emails if two admins both click promote on the same person.
        Index(
            "uq_admin_promotion_pending_per_membership",
            "target_membership_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_membership_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="CASCADE"),
        nullable=False,
    )
    requested_by_membership_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="pending"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

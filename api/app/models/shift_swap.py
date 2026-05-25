from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ShiftSwapOffer(Base):
    __tablename__ = "shift_swap_offers"
    __table_args__ = (
        CheckConstraint(
            "status IN ('open','fulfilled','cancelled')",
            name="ck_swap_offer_status",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    assignment_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("assignments.id", ondelete="CASCADE"),
        nullable=False,
    )
    requested_by_membership_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Migration 0063: optional audience for the request. NULL = the
    # whole tenant (legacy behaviour; existing open offers). A
    # non-empty array narrows visibility + email notification to
    # only those memberships. The frontend resolves "categoría
    # X + person Y" into an explicit id list before POSTing.
    audience_membership_ids: Mapped[list[int] | None] = mapped_column(
        ARRAY(Integer()), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class ShiftSwapResponse(Base):
    __tablename__ = "shift_swap_responses"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('cover','swap')", name="ck_swap_response_kind"
        ),
        CheckConstraint(
            "status IN ('pending','accepted','declined','withdrawn')",
            name="ck_swap_response_status",
        ),
        CheckConstraint(
            "(kind = 'swap' AND swap_assignment_id IS NOT NULL) OR "
            "(kind = 'cover' AND swap_assignment_id IS NULL)",
            name="ck_swap_response_kind_assignment",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    offer_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("shift_swap_offers.id", ondelete="CASCADE"),
        nullable=False,
    )
    responder_membership_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    swap_assignment_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("assignments.id", ondelete="CASCADE"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

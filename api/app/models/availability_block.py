from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AvailabilityBlock(Base):
    __tablename__ = "availability_blocks"
    __table_args__ = (
        CheckConstraint(
            "block_type IN ('vacation','sick','training','personal','other')",
            name="ck_availability_blocks_type",
        ),
        CheckConstraint(
            "end_date >= start_date", name="ck_availability_blocks_date_order"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    person_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    block_type: Mapped[str] = mapped_column(String(32), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Sprint 5 part C: self-service workflow.
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="approved", default="approved"
    )
    requested_by_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_by_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    # Migration 0083. When set, ONLY this membership can approve/deny
    # the block — regardless of which tenant the block belongs to.
    # The chosen reviewer can be from a sibling equipo in the same
    # servicio (cross-tenant). NULL → legacy behaviour: any admin in
    # the block's own tenant can review (covers every row that
    # pre-dates this feature).
    reviewer_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

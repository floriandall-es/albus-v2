from datetime import date, datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("tenant_id", "person_id", name="uq_membership_tenant_person"),
        CheckConstraint("fte_pct >= 0 AND fte_pct <= 200", name="ck_memberships_fte_pct_range"),
        CheckConstraint(
            "exemption_type IS NULL OR exemption_type IN ('permanent','temporary')",
            name="ck_memberships_exemption_type",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    person_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False, index=True
    )
    roles: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)

    # Per-tenant person attributes (Sprint 2).
    category_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    fte_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    does_guardias: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    guardia_types: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, default=list
    )
    exemption_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    exemption_until: Mapped[date | None] = mapped_column(Date, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

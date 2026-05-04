"""Cross-slot scheduling dependencies (sprint 14).

`SlotSuccessionRule`: "after slot A, person can't take slot B for N days"
`SlotFrequencyCap`:   "at most N assignments to slot S per person per
                       rolling/iso/calendar window".

Both are tenant-scoped and follow the standard RLS pattern.
"""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SlotSuccessionRule(Base):
    __tablename__ = "slot_succession_rules"
    __table_args__ = (
        CheckConstraint(
            "days_after BETWEEN 1 AND 14",
            name="ck_succession_days_after_range",
        ),
        CheckConstraint(
            "applies_to IN ('same_person','whole_team')",
            name="ck_succession_applies_to",
        ),
        CheckConstraint(
            "severity IN ('hard','soft')",
            name="ck_succession_severity",
        ),
        UniqueConstraint(
            "tenant_id",
            "after_slot_id",
            "forbid_slot_id",
            "days_after",
            "applies_to",
            name="uq_succession_unique",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    after_slot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    forbid_slot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    days_after: Mapped[int] = mapped_column(Integer, nullable=False)
    applies_to: Mapped[str] = mapped_column(
        String(16), nullable=False, default="same_person"
    )
    severity: Mapped[str] = mapped_column(String(8), nullable=False, default="hard")
    weight: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotFrequencyCap(Base):
    __tablename__ = "slot_frequency_caps"
    __table_args__ = (
        CheckConstraint(
            "period IN ('rolling_7','rolling_14','rolling_28','iso_week','calendar_month')",
            name="ck_freqcap_period",
        ),
        CheckConstraint("max_count >= 0", name="ck_freqcap_max_count"),
        CheckConstraint("severity IN ('hard','soft')", name="ck_freqcap_severity"),
        UniqueConstraint(
            "tenant_id", "slot_id", "period", name="uq_freqcap_unique"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period: Mapped[str] = mapped_column(String(24), nullable=False)
    max_count: Mapped[int] = mapped_column(Integer, nullable=False)
    severity: Mapped[str] = mapped_column(String(8), nullable=False, default="hard")
    weight: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

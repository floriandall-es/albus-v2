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
        # The composite uniqueness covering the role filters is set up
        # via a Postgres expression index in migration 0024 (it uses
        # COALESCE to make NULL distinct from NULL). We omit the
        # UniqueConstraint here so SQLAlchemy doesn't try to redeclare
        # an incompatible one.
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
    # Sprint 17: optional sub-role filters. NULL means "any role of
    # the named slot" (and is the only legal value when the slot is
    # not team_composition). When set, the rule only fires when the
    # specific team_role is the one involved.
    after_team_role_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
        nullable=True,
    )
    forbid_team_role_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
        nullable=True,
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
        # Composite uniqueness covering team_role_id lives in a
        # Postgres expression index (migration 0026) that COALESCEs
        # the nullable role to -1 so NULL means "distinct slot-wide
        # cap". We omit the SQLAlchemy UniqueConstraint here so the
        # ORM doesn't try to redeclare an incompatible one.
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
    # Sprint 17: optional sub-role filter. NULL means "any role of
    # the named slot" (legacy behavior; the only legal value when
    # the slot is not team_composition).
    team_role_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
        nullable=True,
    )
    period: Mapped[str] = mapped_column(String(24), nullable=False)
    max_count: Mapped[int] = mapped_column(Integer, nullable=False)
    severity: Mapped[str] = mapped_column(String(8), nullable=False, default="hard")
    weight: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

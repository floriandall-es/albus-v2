"""Periodo Especial + per-slot override.

A `PeriodoEspecial` defines a tenant-scoped date range during which
the scheduler applies a modified configuration — vacation, Christmas,
Semana Santa, etc. See docs/vacation-periods.md for the full design.

Schema lives in migration 0075. RLS is enabled — only the periodo's
tenant can read/write its row + the related overrides.

Non-overlap per tenant is enforced at the DB layer via a GiST
exclusion constraint; the model doesn't repeat it. The route layer
catches the IntegrityError and turns it into a friendly 422.
"""

from datetime import date, datetime

from sqlalchemy import (
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
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PeriodoEspecial(Base):
    """A defined "special" date range — typically a vacation or
    holiday window. The scheduler consults overrides keyed on this
    period for any date that falls inside [start_date, end_date]
    (inclusive on both ends).
    """

    __tablename__ = "periodos_especiales"
    __table_args__ = (
        CheckConstraint(
            "end_date >= start_date",
            name="ck_periodos_especiales_date_order",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # User-facing label — "Verano 2026", "Navidad 2025", etc.
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Inclusive on both ends. A 1-day periodo has start == end.
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotPeriodOverride(Base):
    """Optional delta-style override on how a Slot looks during a
    PeriodoEspecial. Every non-default field on the slot that can
    vary during the period gets a nullable override column here.

    Semantics:
      - NULL override field → use the slot's default (unchanged).
      - Non-NULL override field → use this value for dates in the period.
      - `dismissed = true` → the slot doesn't run at all during the
        period (no demand, no assignments created).
      - `allowed_category_ids_override` and `allowed_person_ids_override`:
        NULL means "default restriction applies"; an empty array means
        "drop the restriction entirely" (any categoría / any person
        eligible during the period) — useful for relaxing tight
        constraints when the workforce is thin.

    UNIQUE(period_id, slot_id) means one override row per (slot, period).
    """

    __tablename__ = "slot_period_overrides"
    __table_args__ = (
        UniqueConstraint(
            "period_id", "slot_id", name="uq_slot_period_overrides_period_slot"
        ),
        CheckConstraint(
            "headcount_override IS NULL OR headcount_override >= 1",
            name="ck_slot_period_overrides_headcount_positive",
        ),
        CheckConstraint(
            "staffing_mode_override IS NULL OR "
            "staffing_mode_override IN ('single','multiple_same','team_composition')",
            name="ck_slot_period_overrides_staffing_mode",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    slot_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    headcount_override: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    staffing_mode_override: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )
    dismissed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    allowed_category_ids_override: Mapped[list[int] | None] = mapped_column(
        ARRAY(Integer), nullable=True
    )
    allowed_person_ids_override: Mapped[list[int] | None] = mapped_column(
        ARRAY(Integer), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


# V.2 — per-rule / per-succession / per-cap overrides. All three share
# the same shape (period + target FK + a couple of optional override
# columns + disabled flag). They live in their own tables rather than
# one polymorphic table because the override columns differ per type
# and we want sturdy CHECK constraints on each.


class SlotRulePeriodOverride(Base):
    """Per-(period, SlotRule) override. Most common gesture: switch
    a rotation rule to solver mode during vacation (the rotation
    cycle becomes meaningless when the rotation members aren't
    around)."""

    __tablename__ = "slot_rule_period_overrides"
    __table_args__ = (
        UniqueConstraint(
            "period_id",
            "rule_id",
            name="uq_slot_rule_period_overrides_period_rule",
        ),
        CheckConstraint(
            "strategy_override IS NULL OR "
            "strategy_override IN ('solver','fixed_weekly','rotation','manual')",
            name="ck_slot_rule_period_overrides_strategy",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    strategy_override: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotSuccessionRulePeriodOverride(Base):
    """Per-(period, SlotSuccessionRule) override. Lets the admin
    relax a "X then no Y for N days" rule during vacation — shorten
    the gap, downgrade severity, or disable entirely.

    Note: same-day (`days_after = 0`) incompatibility CAN be relaxed
    to a wider window or a non-zero gap during the periodo. The
    semantics stay the same as the base rule's; only the value
    changes.
    """

    __tablename__ = "slot_succession_rule_period_overrides"
    __table_args__ = (
        UniqueConstraint(
            "period_id",
            "succession_rule_id",
            name="uq_slot_succession_rule_period_overrides_period_rule",
        ),
        CheckConstraint(
            "days_after_override IS NULL "
            "OR (days_after_override >= 0 AND days_after_override <= 14)",
            name="ck_slot_succession_rule_period_overrides_days_after",
        ),
        CheckConstraint(
            "severity_override IS NULL OR "
            "severity_override IN ('hard','soft')",
            name="ck_slot_succession_rule_period_overrides_severity",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    succession_rule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_succession_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    days_after_override: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    severity_override: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotFrequencyCapPeriodOverride(Base):
    """Per-(period, SlotFrequencyCap) override. Raise the per-window
    max (so a "2 guardias/month" cap can become "5/month" during
    summer), flip severity, or disable."""

    __tablename__ = "slot_frequency_cap_period_overrides"
    __table_args__ = (
        UniqueConstraint(
            "period_id",
            "cap_id",
            name="uq_slot_frequency_cap_period_overrides_period_cap",
        ),
        CheckConstraint(
            "max_count_override IS NULL OR max_count_override >= 0",
            name="ck_slot_frequency_cap_period_overrides_max_count",
        ),
        CheckConstraint(
            "severity_override IS NULL OR "
            "severity_override IN ('hard','soft')",
            name="ck_slot_frequency_cap_period_overrides_severity",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    cap_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("slot_frequency_caps.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    max_count_override: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    severity_override: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    disabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

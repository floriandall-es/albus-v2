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

from datetime import datetime, time

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Slot(Base):
    __tablename__ = "slots"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_slots_tenant_name"),
        CheckConstraint(
            "days_applied IN ('all','weekdays','weekends_holidays','custom')",
            name="ck_slots_days_applied",
        ),
        CheckConstraint(
            "staffing_mode IN ('single','multiple_same','team_composition')",
            name="ck_slots_staffing_mode",
        ),
        CheckConstraint("headcount >= 1", name="ck_slots_headcount_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    department_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    pool_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("pools.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    days_applied: Mapped[str] = mapped_column(String(32), nullable=False)
    custom_days_bitmap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    staffing_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    headcount: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    post_slot_rest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    counts_for_equity: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Free-text guardia tag. When set, only members whose
    # Membership.guardia_types[] contains this exact string can cover the
    # slot. Common values: "presencial_24h", "localizada", "findes_festivos"
    # — tenants are free to invent their own taxonomy.
    guardia_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Free-text grouping tag for fairness. The solver runs one balance term
    # per distinct equity_group_key (NULL is its own catch-all bucket). Has
    # no effect when counts_for_equity=False.
    equity_group_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    @property
    def crosses_midnight(self) -> bool:
        if self.start_time is None or self.end_time is None:
            return False
        return self.end_time <= self.start_time


class SlotTeamRole(Base):
    __tablename__ = "slot_team_roles"
    __table_args__ = (
        UniqueConstraint("slot_id", "role_label", name="uq_slot_team_roles_slot_label"),
        CheckConstraint("headcount >= 1", name="ck_slot_team_roles_headcount_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role_label: Mapped[str] = mapped_column(String(255), nullable=False)
    headcount: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotTeamRoleCategory(Base):
    __tablename__ = "slot_team_role_categories"
    __table_args__ = (
        UniqueConstraint("slot_team_role_id", "category_id", name="uq_strc_role_category"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_team_role_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slot_team_roles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotSkillRequired(Base):
    __tablename__ = "slot_skills_required"
    __table_args__ = (
        UniqueConstraint("slot_id", "skill_id", name="uq_slot_skills_slot_skill"),
        CheckConstraint("strength IN ('hard','soft')", name="ck_slot_skills_strength"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    skill_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("skills.id", ondelete="CASCADE"), nullable=False, index=True
    )
    strength: Mapped[str] = mapped_column(String(8), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

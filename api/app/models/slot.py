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
    # Slot-name uniqueness is enforced by two partial unique indexes
    # rather than a UniqueConstraint (see migration 0044):
    #   - uq_slots_main_team_name: (tenant_id, name) where group_id
    #     IS NULL — main-team slots are unique within the tenant.
    #   - uq_slots_group_name: (tenant_id, group_id, name) where
    #     group_id IS NOT NULL — sub-equipo slots are unique within
    #     their group only, so two groups can each have a "Consulta"
    #     slot without collision.
    # Indexes don't live in __table_args__ because they're partial.
    __table_args__ = (
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
    # Sprint 23 / migration 0035: which sub-team owns this activity.
    # Null = main team (tenant admin manages). Non-null = owned by
    # that group; only the group lead and tenant admin can edit it,
    # and all rules are forced to manual strategy.
    group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # `pool_id` lived here before migration 0030. Pools were collapsed
    # into slot_allowed_persons; restricting which people can do a slot
    # is now a direct list of person ids on the slot itself.
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    days_applied: Mapped[str] = mapped_column(String(32), nullable=False)
    custom_days_bitmap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    staffing_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    headcount: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    post_slot_rest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    counts_for_equity: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Free-text guardia tag. Sprint 22 / migration 0032 removed the
    # eligibility filter that used this — kept only because the
    # solver's "two-guardias-too-close" spread objective consults it
    # to know whether to apply the 4-day penalty.
    guardia_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 7-char hex color (#rrggbb) used by the UI to colour-code the slot
    # row dot in the planning grid. Null = no dot.
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    # Admin-controlled display order within a tenant. Lower = earlier.
    # New slots get max(position) + 1. The /admin/slots page lets the
    # admin reorder via up/down arrows; the planning grid sorts rows
    # by this value (then by team_role_label within the same slot).
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
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


class SlotCategory(Base):
    """Per-slot categoría restriction. Empty list = unrestricted
    (any categoría can cover the slot). Non-empty = only members
    whose categoría is in the list are eligible.

    Mirrors SlotTeamRoleCategory but at the slot level — used by
    single + multiple_same slots that don't have team_roles. For
    team_composition slots, this filter applies IN ADDITION to
    each team_role's category list (intersection); in practice
    admins pick one level or the other.
    """

    __tablename__ = "slot_categories"
    __table_args__ = (
        UniqueConstraint(
            "slot_id", "category_id", name="uq_slot_categories_slot_category"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SlotAllowedPerson(Base):
    """Per-slot allow-list. If a slot has zero rows, anyone in the
    tenant team is eligible (modulo the other filters: categories
    per-role, guardia type, availability blocks, etc.). If a slot
    has one or more rows, ONLY those persons are eligible.

    Replaces the pre-0030 trio of mechanisms (pool_id on slot, pool
    memberships, slot_skills_required + person_skills). Same job,
    one table.
    """

    __tablename__ = "slot_allowed_persons"
    __table_args__ = (
        UniqueConstraint(
            "slot_id", "person_id", name="uq_slot_allowed_persons_slot_person"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    person_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

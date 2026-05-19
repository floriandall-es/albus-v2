from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Schedule(Base):
    __tablename__ = "schedules"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft','published','archived')",
            name="ck_schedules_status",
        ),
        UniqueConstraint("tenant_id", "period", name="uq_schedules_tenant_period"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    period: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    generated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    generated_by_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    # Which engine produced this schedule's assignments. Null = legacy
    # (pre-0018 migration). "cpsat" = CP-SAT optimal/feasible solve;
    # "greedy" = round-robin fallback (CP-SAT failed or unavailable).
    # Surfaced in the UI so admins can tell when fairness/spread terms
    # weren't applied.
    solver_used: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Sprint 16: tracking for the published → draft "reopen" action.
    # Null on schedules that have never been reopened. The pair of
    # fields lets the UI show a "Reabierta el X por Y" badge once a
    # publication has been brought back for edits.
    reopened_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reopened_by_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Assignment(Base):
    __tablename__ = "assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    schedule_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("schedules.id", ondelete="CASCADE"), nullable=False
    )
    slot_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("slots.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[date] = mapped_column(Date, nullable=False)
    person_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="SET NULL"), nullable=True
    )
    team_role_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("slot_team_roles.id", ondelete="SET NULL"), nullable=True
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    locked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    locked_by_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    # Set when an admin-applied OR member-initiated swap rewrites this
    # row. Both sides of a swap get marked. Null otherwise. SET NULL on
    # offer delete so audit cleanup doesn't blow assignments away.
    swap_offer_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("shift_swap_offers.id", ondelete="SET NULL"),
        nullable=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ScheduleGroupPublication(Base):
    """Per-(schedule, group) publication marker. Presence of this
    row means the group's plan for this schedule is published —
    its members can see the assignments in /me/turnos even when
    the parent Schedule's overall status is still 'draft' from
    the tenant admin's main-team perspective.

    The group lead writes this row by clicking "Publicar" on
    /lead/planificacion. Tenant admin can also publish/unpublish
    on behalf of a group via the same endpoint.
    """

    __tablename__ = "schedule_group_publications"
    __table_args__ = (
        UniqueConstraint(
            "schedule_id", "group_id", name="uq_sched_group_publication"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    schedule_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("schedules.id", ondelete="CASCADE"), nullable=False, index=True
    )
    group_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, index=True
    )
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    published_by_membership_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="SET NULL"),
        nullable=True,
    )

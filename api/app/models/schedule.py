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
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
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
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

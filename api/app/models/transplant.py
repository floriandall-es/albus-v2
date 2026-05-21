"""SQLAlchemy models for the transplant case log (see migration 0045).

Two tables — a parent TransplantCase representing one organ /
one patient, and child TransplantProcedure rows for the
EXPLANTE / IMPLANTE operations. Each case can have 1 or 2
procedures; cross-hospital cases have just one (the other half
was done elsewhere).
"""

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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class TransplantCase(Base):
    __tablename__ = "transplant_cases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # External identifier from the upstream system (donor
    # coordination paperwork, organ network ID, etc.). Optional —
    # admin-created cases may leave it blank.
    external_case_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    # Case date — set by the API at write time from the earliest
    # procedure's occurred_at. The list view sorts by this.
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    procedures: Mapped[list["TransplantProcedure"]] = relationship(
        "TransplantProcedure",
        back_populates="case",
        cascade="all, delete-orphan",
        order_by="TransplantProcedure.occurred_at",
    )


class TransplantProcedure(Base):
    __tablename__ = "transplant_procedures"
    __table_args__ = (
        CheckConstraint(
            "type IN ('explante','implante')",
            name="ck_transplant_procedures_type",
        ),
        CheckConstraint(
            "primary_person_id IS NULL OR secondary_person_id IS NULL "
            "OR primary_person_id <> secondary_person_id",
            name="ck_transplant_procedures_distinct_surgeons",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    case_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("transplant_cases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # NULLABLE — cross-hospital cases have no local surgeon
    # attribution for the half done elsewhere.
    primary_person_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )
    secondary_person_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    case: Mapped[TransplantCase] = relationship(
        "TransplantCase", back_populates="procedures"
    )

"""Migration 0090: weekly team-wellbeing pulse surveys.

See the migration docstring for the schema rationale. These models
are minimal — most of the per-question business logic lives in
`app/services/pulse.py` and the in-code question catalogue.
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class PulseSettings(Base):
    __tablename__ = "pulse_settings"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", name="uq_pulse_settings_tenant"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Default False — pulse is an opt-in feature. The admin
    # enables it from /admin/pulso.
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    # The most recent ISO week the worker fanned out for ("YYYY-Www").
    # Compared against the current week each tick — match → skip
    # this tenant; mismatch (or NULL) → send.
    last_notified_week_iso: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class PulseResponse(Base):
    __tablename__ = "pulse_responses"
    __table_args__ = (
        UniqueConstraint(
            "person_id",
            "week_iso",
            "question_key",
            name="uq_pulse_responses_person_week_question",
        ),
        Index(
            "ix_pulse_responses_aggregate",
            "tenant_id",
            "week_iso",
            "question_key",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # ISO week the response is for. Hard close: POST rejects
    # anything that isn't the current ISO week.
    week_iso: Mapped[str] = mapped_column(String(8), nullable=False)
    # Stable key from the in-code catalogue. Untyped string so the
    # catalogue can evolve without migrations — the FK is logical,
    # not enforced.
    question_key: Mapped[str] = mapped_column(
        String(32), nullable=False
    )
    # 1-N integer; N varies per question (usually 4 or 5).
    score: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

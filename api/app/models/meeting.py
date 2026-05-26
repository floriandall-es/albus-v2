from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Meeting(Base):
    """Reuniones — sesiones clínicas, pase de guardia, etc.

    Two flavours share one table:
      - kind='regular': weekly template. `weekday` set (0=Mon),
        `date` NULL. Expanded into concrete occurrences by the
        /instances endpoint when a date range is requested.
      - kind='ad_hoc' : one-off. `date` set, `weekday` NULL.

    Audience is the union of (a) the `include_main_team` boolean
    and (b) MeetingAudiencePerson rows (specific people). A caller
    is "in the audience" iff they match either.
    """

    __tablename__ = "meetings"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('regular','ad_hoc')",
            name="ck_meetings_kind",
        ),
        CheckConstraint(
            "(kind = 'regular' AND weekday IS NOT NULL AND date IS NULL) "
            "OR (kind = 'ad_hoc' AND date IS NOT NULL AND weekday IS NULL)",
            name="ck_meetings_kind_shape",
        ),
        CheckConstraint(
            "weekday IS NULL OR (weekday >= 0 AND weekday <= 6)",
            name="ck_meetings_weekday_range",
        ),
        CheckConstraint(
            "end_time > start_time",
            name="ck_meetings_time_order",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    date: Mapped[date | None] = mapped_column(Date, nullable=True)
    start_time: Mapped[time] = mapped_column(Time, nullable=False)
    end_time: Mapped[time] = mapped_column(Time, nullable=False)
    weekday: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Migration 0066: optional email reminder. NULL = no reminder.
    # Non-null values are constrained to a fixed preset list
    # (15 / 60 / 180 / 1440 / 10080) — both the API and the DB
    # CHECK enforce it. The reminder worker fires roughly N
    # minutes before each materialised instance and writes a
    # row into meeting_reminders_sent so re-ticks stay idempotent.
    reminder_minutes_before: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    include_main_team: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    organizer_membership_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MeetingReminderSent(Base):
    """Idempotency log for the reminder worker (migration 0066).

    The worker ticks every few minutes and computes which meeting
    instances are due for a reminder *now-ish* (lookback window).
    Before sending, it inserts a row keyed by
    (meeting_id, instance_date). The UNIQUE constraint means a
    concurrent worker or a restart-during-tick can never produce
    a duplicate email.

    `recipient_count` lives here as a debugging aid so we can
    spot-check "did the reminder really fan out" without re-doing
    the audience resolution.
    """

    __tablename__ = "meeting_reminders_sent"
    __table_args__ = (
        UniqueConstraint(
            "meeting_id", "instance_date", name="uq_meeting_reminders_sent"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    meeting_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("meetings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    instance_date: Mapped[date] = mapped_column(Date, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    recipient_count: Mapped[int] = mapped_column(Integer, nullable=False)


class MeetingAudiencePerson(Base):
    """Adds one specific person to a meeting's audience."""

    __tablename__ = "meeting_audience_persons"
    __table_args__ = (
        UniqueConstraint(
            "meeting_id", "person_id", name="uq_meeting_audience_person"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    meeting_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("meetings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

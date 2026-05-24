from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Person(Base):
    __tablename__ = "persons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    # NULL = pendiente (invited but never activated). NOT NULL =
    # activo (has logged in / set a password at least once). The
    # solver is unaware of this distinction; it scans Memberships.
    hashed_password: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    # Canonical display string — kept in sync with first_name + last_name
    # on every write (see _compose_name in routes). Legacy rows from
    # before the split have it as the only source of truth.
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Sprint 18: split for friendly first-name greetings and last-name-
    # only lists. Both nullable on existing rows; new signups + invite
    # acceptances populate them. Frontend has fallback helpers that
    # split `name` heuristically when these are null.
    first_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    locale: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Relative URL of the uploaded profile photo (resized to 128x128 JPEG)
    # served by FastAPI from the avatars volume. Null = no photo, UI falls
    # back to a colored-initials chip.
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # Migration 0057: two optional phones per person, free format
    # (no E.164 enforcement — admins enter "(96) 197 25 00 ext. 1234"
    # and we don't want to fight them on it).
    #
    # `work_phone` — corporate / institutional line, switchboard,
    # on-call number. Surfaced in the directory when the membership's
    # `share_work_phone` flag is true.
    # `personal_phone` — private cell. Surfaced in the directory
    # when the membership's `share_personal_phone` is true; also
    # the number used for the WhatsApp deep link when
    # `share_whatsapp` is true. WhatsApp is never linked to the work
    # phone — sharing your corporate line on WhatsApp is unwanted by
    # default, and the switchboard usually isn't a WhatsApp account
    # anyway.
    work_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    personal_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Migration 0060: free-text job title shown on the hospital
    # directory card ("Jefe de Servicio", "Coordinadora de
    # Trasplantes"…). Distinct from membership.category_id, which
    # the scheduler uses to decide who can cover which slot —
    # cargo is purely presentational.
    cargo: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Timestamp the user clicked the verification link sent on
    # signup. NULL = not yet verified — surfaced to the frontend
    # which shows a "verifica tu correo" banner until cleared.
    # Existing persons were backfilled to NOW() by migration 0038
    # so they're grandfathered as verified.
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # When the user acknowledged the Terms of Service and Privacy
    # Policy, and which version string they ack'd. Set on signup
    # and on invitation accept; existing rows were backfilled to
    # NOW()/version='1.0' by migration 0039. Both nullable so a
    # future bump of the legal text can be detected by comparing
    # version strings without forcing a destructive migration.
    terms_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    terms_accepted_version: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Person(Base):
    __tablename__ = "persons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

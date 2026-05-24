"""Per-person "starred" entries on the hospital directory.

Migration 0058. The owner (`person_id`) bookmarks another clinician
(`favorite_person_id`) for quick access. Frontend renders a
"Favoritos" section at the top of the directory before the per-
department clusters; starred people show in both Favoritos and
their department.

Personal preference of the user — NOT tenant-scoped. No RLS; the
routes gate by `person_id = ctx.person.id`.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DirectoryFavorite(Base):
    __tablename__ = "directory_favorites"
    __table_args__ = (
        CheckConstraint(
            "person_id != favorite_person_id",
            name="ck_directory_favorites_self",
        ),
        UniqueConstraint(
            "person_id",
            "favorite_person_id",
            name="uq_directory_favorites_pair",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    favorite_person_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

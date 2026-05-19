from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Incident(Base):
    """Tenant-scoped freeform log for out-of-the-ordinary events.

    Per-tenant journal. Admins use it to record things like
    last-minute call-offs, swap conflicts, or anything else they'd
    otherwise write down off-system. The body is freeform — no
    structured linkage to persons/slots/assignments. If a pattern
    emerges (e.g. always linking to a person), we can promote
    those references to FK columns later.
    """

    __tablename__ = "incidents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    occurred_at: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_membership_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

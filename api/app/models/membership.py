from datetime import datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("tenant_id", "person_id", name="uq_membership_tenant_person"),
        CheckConstraint(
            "fte_pct >= 0 AND fte_pct <= 200", name="ck_memberships_fte_pct_range"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    person_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("persons.id", ondelete="CASCADE"), nullable=False, index=True
    )
    roles: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)

    # Per-tenant person attributes (Sprint 2).
    category_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    fte_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=100)

    # Sprint 22 / migration 0032: pause membership without deleting.
    # Non-null = the membership is paused; the solver skips it, admins
    # see a "Desactivado" badge in the UI, but past assignments and
    # the user's login stay intact. Re-enabling = set back to NULL.
    disabled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Sprint 23 / migration 0035: sub-team grouping. Null = main team
    # member (managed by the tenant admin). Non-null = member of that
    # group, manageable by the tenant admin AND by the group lead.
    group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("groups.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Sprint 28 / migration 0052: hospital directory opt-out. True =
    # visible in the cross-tenant directory of the parent hospital
    # (default). False = the clinician chose to hide from sibling
    # departments. Per-membership (not per-Person) because the
    # decision is tied to the employment context.
    directory_visible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

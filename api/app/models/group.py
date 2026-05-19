from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Group(Base):
    """A sub-team within a tenant. Has one designated lead
    (Membership) who acts as admin for the group's members and
    slots only. Example: a residente mayor leading the residentes
    cohort while the jefe de servicio runs the full team.

    The lead is a Membership rather than a Person so the grant is
    scoped to "admin of THIS tenant" rather than the bare person
    identity. SET NULL on membership delete: removing the lead
    doesn't delete the group — admin can assign a new lead.
    """

    __tablename__ = "groups"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_groups_tenant_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    lead_membership_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

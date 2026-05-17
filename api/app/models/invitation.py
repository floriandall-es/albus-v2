from datetime import datetime

from sqlalchemy import ARRAY, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Invitation(Base):
    __tablename__ = "invitations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    person_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Bcrypt of the raw token, used for constant-time equality check
    # AFTER the row has been located.
    token_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    # Deterministic HMAC-SHA256(invitation_lookup_secret, raw_token).
    # Indexed + unique. Used by the public endpoint to find the row
    # in O(1) without scanning all tenants. RLS gates the SELECT on
    # `app.invitation_lookup` matching this column, so even setting
    # the value to a guessed string returns only the one matching
    # row (and bcrypt then validates the user's raw token).
    token_lookup: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_membership_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("memberships.id", ondelete="SET NULL"), nullable=True
    )
    category_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    roles: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

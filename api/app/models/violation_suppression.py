"""Per-schedule "overrule" markers for the violations engine.

See migration 0068 for the design rationale. Identity =
(schedule_id, signature), where signature is a sha256 hex over
the canonical JSON of the violation's (kind, sorted cells,
rule_id). The signature is computed by the violations service
helper `violation_signature()`.
"""

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ViolationSuppression(Base):
    __tablename__ = "violation_suppressions"
    __table_args__ = (
        UniqueConstraint(
            "schedule_id",
            "signature",
            name="uq_violation_suppressions_sig",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    schedule_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("schedules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # sha256 hex (64 chars) of the canonical violation tuple. The
    # backend computes this in _serialize_violations and the
    # frontend passes it back verbatim when suppressing.
    signature: Mapped[str] = mapped_column(String(64), nullable=False)
    # Mirror of Violation.kind. Stored so an admin browsing
    # `violation_suppressions` directly can tell at a glance what
    # got hidden; not used for matching (signature is the key).
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    suppressed_by_membership_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("memberships.id", ondelete="SET NULL"),
        nullable=True,
    )
    suppressed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

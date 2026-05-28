"""BillingEmailSent — idempotency log for billing-lifecycle emails.

Recorded by `app.services.billing_emails.try_send(...)` after every
successful (or failed) send attempt. The daily scheduler tick
checks against this table before sending so a process restart
mid-tick can't double-email an admin / member.

Uniqueness is enforced by two partial UNIQUE indexes (see
migration 0082): one for admin-* kinds (person_id IS NULL),
one for member-* kinds (person_id IS NOT NULL). This shape lets
us reuse the same table for tenant-scoped and person-scoped sends
without inventing two tables.

See docs/billing-plan.md, chunk 14.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BillingEmailSent(Base):
    __tablename__ = "billing_emails_sent"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Kind names match the template function names in
    # app/services/email_templates.py with a _dN suffix on the
    # trial-ending variants (one of d7/d3/d1 — days remaining).
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    tenant_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Null for admin-* kinds (which fan out to every tenant admin
    # at send time), set for member-* kinds (which target a
    # specific clinician).
    person_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=True,
    )
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

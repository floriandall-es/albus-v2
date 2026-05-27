"""Founder dashboard wire shapes.

One model today — FounderTenantSummary — backing the table on the
`/founder` page. Cross-tenant rollup; reads happen via
AdminSessionLocal so they bypass RLS. Gated by Person.is_founder
(migration 0079); non-founders get a 403 before any data is built.
"""

from datetime import datetime

from pydantic import BaseModel


class FounderTenantSummary(BaseModel):
    id: int
    name: str
    slug: str
    hospital_name: str | None
    servicio_name: str | None
    signup_date: datetime
    members_count: int
    admins_count: int
    last_login_at: datetime | None
    last_schedule_published_at: datetime | None
    pending_invitations_count: int

    model_config = {"from_attributes": True}

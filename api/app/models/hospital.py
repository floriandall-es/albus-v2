"""Sprint 28 / migration 0051: Hospital layer above Tenant.

A Hospital row represents a physical hospital (or other clinical
organization). Multiple Tenants can roll up under one Hospital so
sibling departments at the same site are linked, even though they
remain independent scheduling boundaries.

The table sits above the per-tenant RLS boundary — no tenant_id
column, no RLS policy. Anyone authenticated can read it; only the
app role writes via the signup find-or-create path and (later)
admin tooling for renaming / merging.

Today this exists purely as a foundation. No user-facing UI yet;
TenantOut exposes hospital_id + hospital_name so future surfaces
(directory, hospital-wide stats, federated billing) can rely on
the data already being populated for new tenants.
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Hospital(Base):
    __tablename__ = "hospitals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    country_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    region_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

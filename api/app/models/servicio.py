"""Servicio — groups peer Equipos (Tenants) under a Hospital.

Sits between Hospital and Tenant. One Servicio groups peer
Equipos — e.g. "Cirugía Torácica" Servicio contains the
"Adjuntos" Equipo and the "Residentes" Equipo, each with its
own admin, slots, schedule, rules. Cross-team coordination is
read-side only (see Tenant.share_policy + each tenant's slots'
shared_with_servicio flag).

For solo tenants we still create a singleton Servicio; that's
cheaper than maintaining a "this tenant has no peers" code
path. See migration 0069 for the backfill.

Naming note: we deliberately chose `servicios` over
`departments` because the existing `departments` table from
migration 0001 is a separate (vestigial) per-tenant concept,
and "servicio" matches the Spanish hospital vocabulary we use
in copy ("Servicio de Cirugía Torácica").

No RLS — Servicio sits above the tenant boundary, same shape as
Hospital. The app role writes via signup find-or-create + admin
tooling.
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


class Servicio(Base):
    __tablename__ = "servicios"
    __table_args__ = (
        UniqueConstraint(
            "hospital_id", "slug", name="uq_servicios_hospital_slug"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hospital_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("hospitals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # User-facing name ("Cirugía Torácica", "Anestesia", …).
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # URL-safe slug, unique within a hospital. We allow two hospitals
    # to share a slug ("cirugia-toracica" in both La Fe and La Paz)
    # but not within one hospital.
    slug: Mapped[str] = mapped_column(String(64), nullable=False)
    # Migration 0085 + 0086. How bloqueos route to a reviewer:
    #   - 'centralised' (default since 0086): bloqueos auto-route
    #     to the Jefe de Servicio (a person.cargos entry matches
    #     "jefe de servicio" case-insensitively). When no Jefe
    #     currently exists, create_my_request transparently falls
    #     back to the delegated picker — so this default is safe
    #     even on servicios that haven't named a Jefe yet.
    #   - 'delegated': explicit override. Every member picks an
    #     admin on /me/bloqueos even when a Jefe exists. The
    #     mode is gated at the API: only the Jefe can flip it.
    bloqueo_routing_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="centralised"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

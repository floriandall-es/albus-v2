"""Pydantic schemas for the Servicio-scoped routes.

A Servicio groups peer Equipos (Tenants) under one Hospital
(see migration 0069). These schemas serve the
/api/servicios/{id} surfaces that drive the cross-equipo
timeline + share-policy admin UI introduced in Phase C.2.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel


SharePolicy = Literal["none", "selected", "full"]
ApprovalState = Literal["pending", "approved"]


class EquipoOut(BaseModel):
    """One peer Equipo within a Servicio. Returned by
    GET /api/servicios/{id}. The list omits no equipos — even
    pending ones — so the approving admin can see what's waiting.
    The UI hides pending ones for non-admin callers."""

    tenant_id: int
    tenant_name: str
    tenant_slug: str
    share_policy: SharePolicy
    approval_state: ApprovalState
    created_at: datetime


class ServicioOut(BaseModel):
    """Top-level info for a Servicio + its equipos. The hospital
    fields are denormalised for convenience so the UI doesn't
    need a second roundtrip to render the breadcrumb."""

    id: int
    name: str
    slug: str
    hospital_id: int
    hospital_name: str
    equipos: list[EquipoOut]


class ServicioTimelineCellOut(BaseModel):
    """One assignment in the cross-equipo timeline.

    Carries everything the planning grid needs to render the cell:
    the person (if filled), the slot meta, the equipo it belongs
    to, plus the source schedule id so a click can deep-link the
    caller into the owning equipo's schedule view (if they have
    access there)."""

    assignment_id: int
    date: date
    tenant_id: int
    tenant_name: str
    slot_id: int
    slot_name: str
    slot_color: str | None
    slot_start_time: time | None
    slot_end_time: time | None
    person_id: int | None
    person_name: str | None
    person_last_name: str | None
    schedule_id: int


class ServicioTimelineOut(BaseModel):
    """Wrapper: the visible cells plus the range echo so the UI
    can validate it got back what it asked for."""

    servicio_id: int
    from_date: date
    to_date: date
    cells: list[ServicioTimelineCellOut]


class SharePolicyUpdateRequest(BaseModel):
    """Admin sets the caller equipo's exposure to the rest of the
    Servicio. Per-slot toggles for 'selected' live on the slot
    (slots.shared_with_servicio), not here — this endpoint is
    just the top-level enum."""

    share_policy: SharePolicy

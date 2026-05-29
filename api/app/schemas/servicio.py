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
# Migration 0085. Servicio-wide routing for new bloqueos.
BloqueoRoutingMode = Literal["delegated", "centralised"]


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


class ServicioPersonOut(BaseModel):
    """One person reachable from the caller's Servicio. Returned by
    GET /api/servicios/{id}/persons; consumed by the cross-equipo
    meeting invitee picker. Carries enough metadata to render
    "Mara Gascón · Residentes — Cirugía Torácica · Residente" in
    a chip without a second lookup.
    """

    person_id: int
    person_name: str
    person_first_name: str | None
    person_last_name: str | None
    person_avatar_url: str | None
    tenant_id: int
    tenant_name: str
    category_name: str | None
    # True when this person sits in the caller's OWN tenant — the
    # picker uses it to group "Tu equipo" vs "Otros equipos del
    # servicio" sections.
    is_caller_tenant: bool


class SharePolicyUpdateRequest(BaseModel):
    """Admin sets the caller equipo's exposure to the rest of the
    Servicio. Per-slot toggles for 'selected' live on the slot
    (slots.shared_with_servicio), not here — this endpoint is
    just the top-level enum."""

    share_policy: SharePolicy


class JefeInfo(BaseModel):
    """Who the Jefe de Servicio is, when one exists. Returned as
    part of the bloqueo-routing GET so the toggle UI can show
    "centralizado en Dr. X" without a second fetch. NULL when
    no member of the servicio carries the cargo."""

    membership_id: int
    person_id: int
    person_name: str
    tenant_id: int
    tenant_name: str


class BloqueoRoutingOut(BaseModel):
    """Snapshot of how bloqueos route in the caller's servicio.

    `mode` = 'delegated' is the default and means every member
    picks an admin on /me/bloqueos. `mode` = 'centralised' means
    bloqueos auto-route to the Jefe de Servicio when one exists
    (when none exists, create_my_request transparently falls back
    to delegated for that one request).

    `jefe` is non-null when at least one admin of an approved
    equipo in the servicio carries the "Jefe de Servicio" cargo.
    When multiple exist, the deterministic pick is returned (see
    _resolve_servicio_jefe in routes/availability.py)."""

    mode: BloqueoRoutingMode
    jefe: JefeInfo | None = None
    # True when the caller themselves is the resolved jefe — the
    # UI uses it to switch the toggle copy from "Centralizar en
    # {Name}" to "Centralizar en mí".
    caller_is_jefe: bool = False


class BloqueoRoutingUpdate(BaseModel):
    """Jefe-only PATCH on the servicio routing mode. The mode is
    the only mutable field — when 'centralised', the reviewer is
    by definition the resolved Jefe at create-bloqueo time, not
    a separately-named admin."""

    mode: BloqueoRoutingMode


class PendingEquipoOut(BaseModel):
    """One pending-approval Equipo in the caller's Servicio.

    Drives the /admin/equipos-pendientes page + the equipos-
    pendientes count on /admin/inicio. Carries enough metadata
    so the approving admin can decide without a second fetch:
    who created it, when, with what email.
    """

    tenant_id: int
    tenant_name: str
    tenant_slug: str
    created_at: datetime
    # The admin who signed it up (always exactly one — they're the
    # only Membership at the moment of creation).
    admin_name: str
    admin_first_name: str | None
    admin_last_name: str | None
    admin_email: str

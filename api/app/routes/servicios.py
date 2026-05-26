"""Servicio-scoped endpoints (Phase C.2).

Three surfaces:

  GET   /api/servicios/{id}
        Servicio metadata + list of peer Equipos in it. Drives
        the /admin/servicio overview page.

  GET   /api/servicios/{id}/timeline?from&to
        Cross-equipo assignment view, respecting each Equipo's
        share_policy. Uses the list_servicio_timeline
        SECURITY DEFINER function (see migration 0071) so RLS
        doesn't block the cross-tenant join.

  PATCH /api/equipos/me/share-policy
        Update the caller equipo's share_policy enum. Admin-only.
        Per-slot toggles for 'selected' are PATCH-ed on the slot
        itself (see slots.update_slot — accepts
        shared_with_servicio).

Auth: every endpoint requires the caller to be in the target
Servicio. We check by joining the caller's tenant_id → servicio_id
on entry; tenants without a servicio_id (legacy pre-Phase-A)
get a 404 from the same gate.
"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text

from app.models import Hospital, Servicio
from app.routes.deps import RequestContext, get_current_context
from app.schemas.servicio import (
    EquipoOut,
    ServicioOut,
    ServicioPersonOut,
    ServicioTimelineCellOut,
    ServicioTimelineOut,
    SharePolicyUpdateRequest,
)


router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _require_same_servicio(ctx: RequestContext, servicio_id: int) -> Servicio:
    """Reject the request unless the caller's tenant lives under the
    target servicio. Returns the Servicio row for downstream use.
    404 (not 403) on mismatch to avoid leaking servicio ids.
    """
    if ctx.tenant.servicio_id is None or ctx.tenant.servicio_id != servicio_id:
        raise HTTPException(status_code=404, detail="Servicio no encontrado")
    sv = ctx.db.get(Servicio, servicio_id)
    if sv is None:
        raise HTTPException(status_code=404, detail="Servicio no encontrado")
    return sv


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/servicios/{servicio_id}", response_model=ServicioOut)
def get_servicio(
    servicio_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> ServicioOut:
    sv = _require_same_servicio(ctx, servicio_id)
    hosp = ctx.db.get(Hospital, sv.hospital_id)
    if hosp is None:
        # Defensive — Servicio.hospital_id is NOT NULL with ON CASCADE,
        # so this only fires on a corrupt DB.
        raise HTTPException(
            status_code=500, detail="Servicio sin hospital asociado"
        )

    # Cross-tenant read via SECURITY DEFINER function (migration 0071).
    # Plain Python query via the runtime role would be RLS-blocked on
    # every sibling tenant.
    rows = (
        ctx.db.execute(
            text(
                "SELECT tenant_id, tenant_name, tenant_slug, "
                "share_policy, approval_state, created_at "
                "FROM list_servicio_equipos(:sid)"
            ),
            {"sid": servicio_id},
        )
        .mappings()
        .all()
    )
    equipos = [EquipoOut(**dict(r)) for r in rows]

    return ServicioOut(
        id=sv.id,
        name=sv.name,
        slug=sv.slug,
        hospital_id=hosp.id,
        hospital_name=hosp.name,
        equipos=equipos,
    )


@router.get(
    "/servicios/{servicio_id}/timeline",
    response_model=ServicioTimelineOut,
)
def get_servicio_timeline(
    servicio_id: int,
    from_: date = Query(..., alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> ServicioTimelineOut:
    """Cross-equipo published assignments in [from, to], filtered by
    each equipo's share_policy. The caller's OWN tenant always shows
    everything; siblings show per their policy. Drafts are never
    surfaced — the timeline is a "what's actually been published"
    view.

    Range capped at 366 days for the same reason every other
    range-driven endpoint caps it: pathological calls.
    """
    _require_same_servicio(ctx, servicio_id)
    if to < from_:
        raise HTTPException(status_code=422, detail="`to` must be >= `from`")
    if (to - from_).days > 366:
        raise HTTPException(
            status_code=422, detail="El rango máximo es de 366 días."
        )

    rows = (
        ctx.db.execute(
            text(
                "SELECT assignment_id, assignment_date AS date, "
                "tenant_id, tenant_name, "
                "slot_id, slot_name, slot_color, "
                "slot_start_time, slot_end_time, "
                "person_id, person_name, person_last_name, "
                "schedule_id "
                "FROM list_servicio_timeline(:sid, :ct, :f, :t)"
            ),
            {
                "sid": servicio_id,
                "ct": ctx.tenant.id,
                "f": from_,
                "t": to,
            },
        )
        .mappings()
        .all()
    )
    cells = [ServicioTimelineCellOut(**dict(r)) for r in rows]
    return ServicioTimelineOut(
        servicio_id=servicio_id,
        from_date=from_,
        to_date=to,
        cells=cells,
    )


@router.get(
    "/servicios/{servicio_id}/persons",
    response_model=list[ServicioPersonOut],
)
def list_servicio_persons(
    servicio_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[ServicioPersonOut]:
    """Persons across every approved Equipo in the Servicio. Drives
    the cross-equipo meeting invitee picker.

    Caller must belong to the servicio. Pending equipos are
    excluded (the SECURITY DEFINER function enforces that).
    """
    _require_same_servicio(ctx, servicio_id)
    rows = (
        ctx.db.execute(
            text(
                "SELECT person_id, person_name, person_first_name, "
                "person_last_name, person_avatar_url, "
                "tenant_id, tenant_name, category_name, "
                "is_caller_tenant "
                "FROM list_servicio_persons(:sid, :ct)"
            ),
            {"sid": servicio_id, "ct": ctx.tenant.id},
        )
        .mappings()
        .all()
    )
    return [ServicioPersonOut(**dict(r)) for r in rows]


@router.patch(
    "/equipos/me/share-policy",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def update_my_share_policy(
    payload: SharePolicyUpdateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Set the caller's tenant share_policy. Admin-only.

    The enum is validated by the CHECK constraint added in
    migration 0069 — Pydantic also enforces the Literal here.
    Per-slot 'selected' toggles live on slots.shared_with_servicio
    (set via PATCH /api/slots/{id}), not on this endpoint, to keep
    the wire shape small and the UI flow obvious: pick policy
    here, tick slots over on the Actividades page.
    """
    _require_admin(ctx)
    ctx.tenant.share_policy = payload.share_policy
    ctx.db.flush()

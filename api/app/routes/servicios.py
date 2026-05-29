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

from app.models import Hospital, Membership, Person, Servicio, Tenant
from app.routes.deps import RequestContext, get_current_context
from app.schemas.servicio import (
    BloqueoRoutingOut,
    BloqueoRoutingUpdate,
    EquipoOut,
    JefeInfo,
    PendingEquipoOut,
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


# ---------------------------------------------------------------------------
# Sibling approval (Phase D.3)
# ---------------------------------------------------------------------------


def _require_admin_of_approved_sibling(ctx: RequestContext) -> None:
    """Approve/decline endpoints are gated to admins of an APPROVED
    sibling equipo in the same servicio. A pending tenant's own
    admin can't self-approve (chicken-and-egg) — that's the whole
    point of the gate.

    We re-use `_require_admin(ctx)` because the caller's
    membership is necessarily in their own (approved) tenant; the
    only thing left to check is that the target tenant lives in
    the same servicio. That second check is per-endpoint below.
    """
    _require_admin(ctx)
    if ctx.tenant.approval_state != "approved":
        # The caller's OWN tenant is pending — they can't approve
        # anyone else.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Tu equipo aún está pendiente de aprobación; no puedes "
                "aprobar a otros."
            ),
        )
    if ctx.tenant.servicio_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tu equipo no pertenece a ningún servicio.",
        )


@router.get(
    "/equipos/pendientes",
    response_model=list[PendingEquipoOut],
)
def list_pending_equipos(
    ctx: RequestContext = Depends(get_current_context),
) -> list[PendingEquipoOut]:
    """Pending sibling equipos awaiting approval. Returns one row
    per pending Tenant in the caller's Servicio (excluding the
    caller's own tenant — irrelevant whether it's pending or not).

    Admin-only. Drives the /admin/equipos-pendientes page and the
    new card on /admin Inicio.
    """
    _require_admin_of_approved_sibling(ctx)
    # Cross-tenant read — use SECURITY DEFINER hop. We rely on
    # list_servicio_equipos for the basic tenants+state pull and
    # then join in the admin Person details locally. Two queries
    # but each is small.
    siblings = (
        ctx.db.execute(
            text(
                "SELECT tenant_id, tenant_name, tenant_slug, created_at "
                "FROM list_servicio_equipos(:sid) "
                "WHERE approval_state = 'pending' "
                "  AND tenant_id <> :ct"
            ),
            {"sid": ctx.tenant.servicio_id, "ct": ctx.tenant.id},
        )
        .mappings()
        .all()
    )
    if not siblings:
        return []
    # For each pending tenant, find the (single) admin Person —
    # at signup time we wrote exactly one Membership with
    # roles=['admin']. Bypass RLS via the admin engine so we can
    # cross tenants.
    from app.db.session import AdminSessionLocal

    admin_db = AdminSessionLocal()
    try:
        out: list[PendingEquipoOut] = []
        for r in siblings:
            admin_row = admin_db.execute(
                text(
                    "SELECT p.name, p.first_name, p.last_name, p.email "
                    "FROM memberships m "
                    "JOIN persons p ON p.id = m.person_id "
                    "WHERE m.tenant_id = :tid "
                    "  AND 'admin' = ANY(m.roles) "
                    "ORDER BY m.id "
                    "LIMIT 1"
                ),
                {"tid": r["tenant_id"]},
            ).mappings().first()
            out.append(
                PendingEquipoOut(
                    tenant_id=r["tenant_id"],
                    tenant_name=r["tenant_name"],
                    tenant_slug=r["tenant_slug"],
                    created_at=r["created_at"],
                    admin_name=(admin_row or {}).get("name") or "(desconocido)",
                    admin_first_name=(admin_row or {}).get("first_name"),
                    admin_last_name=(admin_row or {}).get("last_name"),
                    admin_email=(admin_row or {}).get("email") or "",
                )
            )
        return out
    finally:
        admin_db.close()


def _load_pending_sibling(
    ctx: RequestContext, tenant_id: int
) -> Tenant:
    """Load the target Tenant for approve/decline. Refuses anything
    that isn't pending + in the caller's servicio.

    `tenants` has no RLS, so ctx.db.get works for cross-tenant
    loads. Returning 404 for wrong-servicio rather than 403 to
    avoid leaking tenant ids across servicios."""
    target = ctx.db.get(Tenant, tenant_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Equipo no encontrado")
    if target.servicio_id != ctx.tenant.servicio_id:
        raise HTTPException(status_code=404, detail="Equipo no encontrado")
    if target.approval_state != "pending":
        raise HTTPException(
            status_code=409,
            detail="Este equipo ya no está pendiente de aprobación.",
        )
    return target


@router.post(
    "/equipos/{tenant_id}/approve",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def approve_equipo(
    tenant_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Approve a pending sibling equipo. Admin-of-approved-sibling
    only. Flips approval_state='approved'; from that point on the
    new equipo appears in the servicio timeline + can invite /
    be invited to cross-equipo meetings."""
    _require_admin_of_approved_sibling(ctx)
    target = _load_pending_sibling(ctx, tenant_id)
    target.approval_state = "approved"
    ctx.db.flush()


@router.post(
    "/equipos/{tenant_id}/decline",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def decline_equipo(
    tenant_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Decline a pending sibling equipo. The just-signed-up admin's
    Tenant + Membership are deleted; their Person row stays (no
    cross-tenant references) and is emailed the decline notice
    so they know what happened.

    Hard delete (vs flagging declined) keeps the model simple —
    declined rows accumulating would clutter every cross-equipo
    query for no real benefit.
    """
    _require_admin_of_approved_sibling(ctx)
    target = _load_pending_sibling(ctx, tenant_id)

    # Capture details for the email BEFORE deletion.
    from app.db.session import AdminSessionLocal

    admin_db = AdminSessionLocal()
    try:
        admin_person = admin_db.execute(
            text(
                "SELECT p.id, p.email, p.first_name, p.name "
                "FROM memberships m "
                "JOIN persons p ON p.id = m.person_id "
                "WHERE m.tenant_id = :tid "
                "  AND 'admin' = ANY(m.roles) "
                "ORDER BY m.id LIMIT 1"
            ),
            {"tid": target.id},
        ).mappings().first()
    finally:
        admin_db.close()

    servicio_name: str | None = None
    if ctx.tenant.servicio_id is not None:
        sv = ctx.db.get(Servicio, ctx.tenant.servicio_id)
        servicio_name = sv.name if sv else None

    # Drop the tenant — CASCADEs delete its memberships, slots
    # (none yet for fresh signups), etc. Person row survives.
    ctx.db.delete(target)
    ctx.db.flush()

    # Fire-and-forget decline email. Swallowed by send_email on
    # SMTP failure — same pattern as the swap-notification path.
    if admin_person and admin_person["email"]:
        try:
            from app.services.email import send_email
            from app.services.email_templates import equipo_declined_email

            subject, body = equipo_declined_email(
                recipient_first_name=(
                    admin_person.get("first_name") or admin_person.get("name") or ""
                ),
                equipo_name=target.name,
                servicio_name=servicio_name or "(servicio)",
            )
            send_email(admin_person["email"], subject, body)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Bloqueo routing mode (migration 0085)
# ---------------------------------------------------------------------------


def _require_jefe_admin(ctx: RequestContext) -> None:
    """Authz gate for the bloqueo-routing endpoints.

    Caller must be (a) an admin in the current tenant AND (b) carry
    'Jefe de Servicio' in their person.cargos. We do not require
    the caller to be the *deterministically-resolved* jefe — a
    secondary jefe (if one exists) can still operate the toggle.
    The cargo claim is the gate; the deterministic resolution
    only decides who reviews at create-bloqueo time."""
    _require_admin(ctx)
    # Local import avoids a cycle with availability.py.
    from app.routes.availability import _person_is_jefe_de_servicio

    if not _person_is_jefe_de_servicio(ctx.person):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo el Jefe de Servicio puede modificar este ajuste.",
        )


def _build_jefe_info(ctx: RequestContext) -> JefeInfo | None:
    """Read-only resolution for the GET response. Returns the
    deterministically-picked Jefe de Servicio (own equipo first,
    then lowest membership id) or None when nobody carries the
    cargo on an admin membership of an approved equipo in the
    caller's servicio."""
    from app.routes.availability import _resolve_servicio_jefe

    resolved = _resolve_servicio_jefe(ctx)
    if resolved is None:
        return None
    m, p, t = resolved
    return JefeInfo(
        membership_id=m.id,
        person_id=p.id,
        person_name=p.name,
        tenant_id=t.id,
        tenant_name=t.name,
    )


@router.get(
    "/servicios/me/bloqueo-routing",
    response_model=BloqueoRoutingOut,
)
def get_my_bloqueo_routing(
    ctx: RequestContext = Depends(get_current_context),
) -> BloqueoRoutingOut:
    """Read the bloqueo routing mode for the caller's servicio.

    Gated to the Jefe de Servicio (admin + matching cargo) — only
    they should see the toggle. The /me/servicio/admins endpoint
    exposes the mode to every member but no jefe metadata, so a
    non-jefe member who calls THIS endpoint to fish for who the
    jefe is just gets a 403."""
    _require_jefe_admin(ctx)
    if ctx.tenant.servicio_id is None:
        # Solo tenant — no servicio config to route through.
        raise HTTPException(
            status_code=404,
            detail="Tu equipo no pertenece a ningún servicio.",
        )
    sv = ctx.db.get(Servicio, ctx.tenant.servicio_id)
    if sv is None:
        raise HTTPException(status_code=404, detail="Servicio no encontrado")
    jefe = _build_jefe_info(ctx)
    return BloqueoRoutingOut(
        mode=sv.bloqueo_routing_mode,  # type: ignore[arg-type]
        jefe=jefe,
        caller_is_jefe=(
            jefe is not None and jefe.membership_id == ctx.membership.id
        ),
    )


@router.patch(
    "/servicios/me/bloqueo-routing",
    response_model=BloqueoRoutingOut,
)
def update_my_bloqueo_routing(
    payload: BloqueoRoutingUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> BloqueoRoutingOut:
    """Flip the servicio's bloqueo routing mode.

    Jefe-only (cargo-gated). When the new mode is 'centralised'
    but no jefe currently resolves, we still allow the write —
    create_my_request silently falls back to delegated for that
    one request until a jefe is in place. Avoids a chicken-and-
    egg lock where the caller can't flip back to centralised
    after their cargo gets cleared and re-set.

    Existing pending bloqueos are untouched; the new mode only
    affects bloqueos raised AFTER the write."""
    _require_jefe_admin(ctx)
    if ctx.tenant.servicio_id is None:
        raise HTTPException(
            status_code=404,
            detail="Tu equipo no pertenece a ningún servicio.",
        )
    sv = ctx.db.get(Servicio, ctx.tenant.servicio_id)
    if sv is None:
        raise HTTPException(status_code=404, detail="Servicio no encontrado")
    sv.bloqueo_routing_mode = payload.mode
    ctx.db.flush()
    jefe = _build_jefe_info(ctx)
    return BloqueoRoutingOut(
        mode=sv.bloqueo_routing_mode,  # type: ignore[arg-type]
        jefe=jefe,
        caller_is_jefe=(
            jefe is not None and jefe.membership_id == ctx.membership.id
        ),
    )

"""Admin promotion consent flow (migration 0087).

Two surfaces:

  Admin-side (auth-required):
    POST   /api/team/{membership_id}/admin-promotion   create
    GET    /api/admin-promotions                       list pending
    DELETE /api/admin-promotions/{id}                  cancel

  Target-side (PUBLIC, token-only — the consent surface):
    GET   /api/admin-promotion/preview?token=...       what's this?
    POST  /api/admin-promotion/accept?token=...        accept → grant role
    POST  /api/admin-promotion/decline?token=...       decline → no-op

Why public + token-only on the target side: the target may be
reading the email in a different browser than where they're
logged into Trivu — same UX rationale as the email-change confirm
flow. Token signature proves they received the email.

Sister flows that this complements:
  - Direct PUT /api/team/{id} with roles: still works for team_pays
    and for demotions. Under members_pay + a non-admin → admin
    transition, the PUT route now 400s and tells the caller to
    use this endpoint instead.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import jwt as _jwt
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_admin_promotion_token,
    decode_admin_promotion_token,
)
from app.models import (
    AdminPromotionRequest,
    Membership,
    Person,
    Tenant,
)
from app.routes.deps import (
    RequestContext,
    get_current_context,
    get_db_raw,
)
from app.routes.scope import caller_scope
from app.schemas.admin_promotion import (
    AdminPromotionPreviewOut,
    AdminPromotionRequestOut,
)


router = APIRouter()
logger = logging.getLogger("app.admin_promotion")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _serialize(
    db: Session, req: AdminPromotionRequest
) -> AdminPromotionRequestOut:
    """Read-side denormalisation of person names so the admin's
    pending-list UI can render without a second fetch."""
    target_m = db.get(Membership, req.target_membership_id)
    target_p = (
        db.get(Person, target_m.person_id) if target_m else None
    )
    requester_p = None
    if req.requested_by_membership_id is not None:
        req_m = db.get(Membership, req.requested_by_membership_id)
        if req_m is not None:
            requester_p = db.get(Person, req_m.person_id)
    return AdminPromotionRequestOut(
        id=req.id,
        target_membership_id=req.target_membership_id,
        target_person_name=target_p.name if target_p else "?",
        requested_by_membership_id=req.requested_by_membership_id,
        requested_by_person_name=(
            requester_p.name if requester_p else None
        ),
        status=req.status,  # type: ignore[arg-type]
        created_at=req.created_at,
        expires_at=req.expires_at,
        decided_at=req.decided_at,
    )


# ---------------------------------------------------------------------------
# Admin-side
# ---------------------------------------------------------------------------


@router.post(
    "/team/{membership_id}/admin-promotion",
    response_model=AdminPromotionRequestOut,
    status_code=status.HTTP_201_CREATED,
)
def create_admin_promotion(
    membership_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> AdminPromotionRequestOut:
    """Admin asks a member to accept the admin role. Server
    creates a pending request and emails the member the accept /
    decline links. The role is NOT granted here — that only
    happens when the member clicks accept.

    Refused when:
      - Caller isn't an admin (403)
      - Target membership doesn't exist in this tenant (404)
      - Target is already an admin (400 — no change to make)
      - Target is the caller themselves (400 — self-promote)
      - There's already a pending request for this target (409)
    """
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=403, detail="Permisos insuficientes."
        )
    target = ctx.db.get(Membership, membership_id)
    if target is None or target.tenant_id != ctx.tenant.id:
        raise HTTPException(
            status_code=404, detail="Miembro no encontrado"
        )
    if "admin" in (target.roles or []):
        raise HTTPException(
            status_code=400,
            detail="Esta persona ya es admin del equipo.",
        )
    if target.id == ctx.membership.id:
        raise HTTPException(
            status_code=400, detail="No puedes auto-promocionarte."
        )
    # Reject if there's already a pending request — partial unique
    # index also enforces this at the DB layer, but we want a clear
    # 409 instead of a generic IntegrityError.
    existing = (
        ctx.db.query(AdminPromotionRequest)
        .filter(
            AdminPromotionRequest.target_membership_id == target.id,
            AdminPromotionRequest.status == "pending",
        )
        .first()
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Ya hay una solicitud de promoción pendiente para "
                "esta persona."
            ),
        )

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(
        hours=settings.admin_promotion_ttl_hours
    )
    req = AdminPromotionRequest(
        tenant_id=ctx.tenant.id,
        target_membership_id=target.id,
        requested_by_membership_id=ctx.membership.id,
        status="pending",
        expires_at=expires_at,
    )
    ctx.db.add(req)
    ctx.db.flush()
    # Now that the row has an id we can mint the token (it embeds
    # the request_id so a single token only drives one decision).
    token = create_admin_promotion_token(
        request_id=req.id, target_membership_id=target.id
    )
    accept_url = (
        f"{settings.public_base_url.rstrip('/')}"
        f"/confirm-admin-promotion?token={token}&action=accept"
    )
    decline_url = (
        f"{settings.public_base_url.rstrip('/')}"
        f"/confirm-admin-promotion?token={token}&action=decline"
    )

    # Fire-and-forget email; swallow Stripe-style on failure so a
    # transient SMTP problem doesn't 500 the admin's click.
    target_person = ctx.db.get(Person, target.person_id)
    inviter_person = ctx.db.get(Person, ctx.person.id)
    if target_person is not None and target_person.email:
        try:
            from app.services.email import send_email
            from app.services.email_templates import (
                admin_promotion_request_email,
            )

            subject, body = admin_promotion_request_email(
                recipient_name=target_person.name,
                inviter_name=(
                    inviter_person.name if inviter_person else "Un admin"
                ),
                tenant_name=ctx.tenant.name,
                billing_model=ctx.tenant.billing_model,
                accept_url=accept_url,
                decline_url=decline_url,
                ttl_hours=settings.admin_promotion_ttl_hours,
            )
            send_email(target_person.email, subject, body)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Admin promotion email failed tenant=%s target=%s",
                ctx.tenant.id,
                target.id,
            )

    return _serialize(ctx.db, req)


@router.get(
    "/admin-promotions",
    response_model=list[AdminPromotionRequestOut],
)
def list_admin_promotions(
    ctx: RequestContext = Depends(get_current_context),
) -> list[AdminPromotionRequestOut]:
    """Pending + recently-decided promotions in the caller's
    tenant. Drives the "pending promotions" panel on /admin/team.
    Sorted recent-first so the most relevant rows are on top."""
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=403, detail="Permisos insuficientes."
        )
    rows = (
        ctx.db.query(AdminPromotionRequest)
        .filter(AdminPromotionRequest.tenant_id == ctx.tenant.id)
        .order_by(AdminPromotionRequest.created_at.desc())
        .all()
    )
    return [_serialize(ctx.db, r) for r in rows]


@router.delete(
    "/admin-promotions/{request_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def cancel_admin_promotion(
    request_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Admin withdraws a pending promotion. Idempotent: requests
    that are already decided / expired / cancelled stay as they
    are (204 on those too — the admin's mental model is "make sure
    this isn't pending anymore" and we do that)."""
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=403, detail="Permisos insuficientes."
        )
    req = ctx.db.get(AdminPromotionRequest, request_id)
    if req is None or req.tenant_id != ctx.tenant.id:
        raise HTTPException(
            status_code=404, detail="Solicitud no encontrada"
        )
    if req.status == "pending":
        req.status = "cancelled"
        req.decided_at = datetime.now(timezone.utc)
        ctx.db.flush()


# ---------------------------------------------------------------------------
# Target-side (PUBLIC — token-only)
# ---------------------------------------------------------------------------


def _load_request_from_token(
    token: str, db: Session
) -> tuple[AdminPromotionRequest, dict]:
    try:
        payload = decode_admin_promotion_token(token)
    except _jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=400,
            detail="El enlace ha caducado",
        )
    except _jwt.InvalidTokenError:
        raise HTTPException(
            status_code=400,
            detail="Enlace inválido",
        )
    req = db.get(AdminPromotionRequest, payload["request_id"])
    if req is None:
        raise HTTPException(
            status_code=404, detail="Solicitud no encontrada"
        )
    # Sanity-check the membership id in the token matches the row
    # — defends against id reuse after a row was deleted and a new
    # request happened to land on the same id.
    if req.target_membership_id != payload["target_membership_id"]:
        raise HTTPException(
            status_code=400, detail="Enlace inválido"
        )
    return req, payload


def _maybe_expire(req: AdminPromotionRequest, db: Session) -> None:
    """Lazy expiry. We don't run a cron — instead each touch of a
    pending+past-due row flips it to expired so the UI never
    renders confusingly-active old rows."""
    if (
        req.status == "pending"
        and req.expires_at < datetime.now(timezone.utc)
    ):
        req.status = "expired"
        req.decided_at = datetime.now(timezone.utc)
        db.flush()
        db.commit()


@router.get(
    "/admin-promotion/preview",
    response_model=AdminPromotionPreviewOut,
)
def preview_admin_promotion(
    token: str,
    db: Session = Depends(get_db_raw),
) -> AdminPromotionPreviewOut:
    """What the accept/decline landing page reads to render the
    "X wants to promote you on tenant Y" card. Public — no auth
    needed."""
    req, _ = _load_request_from_token(token, db)
    _maybe_expire(req, db)
    tenant = db.get(Tenant, req.tenant_id)
    target_m = db.get(Membership, req.target_membership_id)
    target_p = (
        db.get(Person, target_m.person_id) if target_m else None
    )
    inviter_p = None
    if req.requested_by_membership_id is not None:
        inv_m = db.get(Membership, req.requested_by_membership_id)
        if inv_m is not None:
            inviter_p = db.get(Person, inv_m.person_id)
    return AdminPromotionPreviewOut(
        tenant_name=tenant.name if tenant else "?",
        target_person_name=target_p.name if target_p else "?",
        inviter_person_name=inviter_p.name if inviter_p else None,
        status=req.status,  # type: ignore[arg-type]
        expires_at=req.expires_at,
    )


@router.post(
    "/admin-promotion/accept",
    response_model=AdminPromotionPreviewOut,
)
def accept_admin_promotion(
    token: str,
    db: Session = Depends(get_db_raw),
) -> AdminPromotionPreviewOut:
    """Target accepts. Grant the admin role on the membership AND
    swap the Stripe item under members_pay (or reconcile the
    team-pays seats). Idempotent: re-clicking on an already-
    accepted request is a no-op."""
    req, _ = _load_request_from_token(token, db)
    _maybe_expire(req, db)
    if req.status == "accepted":
        # Idempotent — already done.
        pass
    elif req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Esta solicitud ya está {req.status}",
        )
    else:
        target = db.get(Membership, req.target_membership_id)
        if target is None:
            raise HTTPException(
                status_code=404, detail="Miembro no encontrado"
            )
        tenant = db.get(Tenant, req.tenant_id)
        if tenant is None:
            raise HTTPException(
                status_code=404, detail="Servicio no encontrado"
            )
        # Grant role + stamp the decision atomically. The actual
        # Stripe call happens after the commit so a Stripe failure
        # doesn't roll back the role grant — same pattern we use
        # in routes/team.py.
        roles = list(target.roles or [])
        if "admin" not in roles:
            roles.append("admin")
            target.roles = roles
        req.status = "accepted"
        req.decided_at = datetime.now(timezone.utc)
        db.flush()
        db.commit()

        # Reconcile billing under the right model. swap_personal_
        # sub_role handles members_pay (their personal sub item
        # moves to price_admin); reconcile_admin_seats +
        # reconcile_team_pays_seats handle team_pays.
        if tenant.billing_model == "team_pays":
            from app.services.billing import (
                reconcile_admin_seats,
                reconcile_team_pays_seats,
            )

            reconcile_admin_seats(tenant, db)
            reconcile_team_pays_seats(tenant, db)
        else:
            from app.services.billing import swap_personal_sub_role

            target_person = db.get(Person, target.person_id)
            if target_person is not None:
                swap_personal_sub_role(
                    tenant, target_person, is_admin=True
                )

    tenant = db.get(Tenant, req.tenant_id)
    target_m = db.get(Membership, req.target_membership_id)
    target_p = (
        db.get(Person, target_m.person_id) if target_m else None
    )
    inviter_p = None
    if req.requested_by_membership_id is not None:
        inv_m = db.get(Membership, req.requested_by_membership_id)
        if inv_m is not None:
            inviter_p = db.get(Person, inv_m.person_id)
    return AdminPromotionPreviewOut(
        tenant_name=tenant.name if tenant else "?",
        target_person_name=target_p.name if target_p else "?",
        inviter_person_name=inviter_p.name if inviter_p else None,
        status=req.status,  # type: ignore[arg-type]
        expires_at=req.expires_at,
    )


@router.post(
    "/admin-promotion/decline",
    response_model=AdminPromotionPreviewOut,
)
def decline_admin_promotion(
    token: str,
    db: Session = Depends(get_db_raw),
) -> AdminPromotionPreviewOut:
    """Target declines. Just flip status — no role grant, no
    Stripe call. Idempotent."""
    req, _ = _load_request_from_token(token, db)
    _maybe_expire(req, db)
    if req.status == "declined":
        pass
    elif req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Esta solicitud ya está {req.status}",
        )
    else:
        req.status = "declined"
        req.decided_at = datetime.now(timezone.utc)
        db.flush()
        db.commit()

    tenant = db.get(Tenant, req.tenant_id)
    target_m = db.get(Membership, req.target_membership_id)
    target_p = (
        db.get(Person, target_m.person_id) if target_m else None
    )
    inviter_p = None
    if req.requested_by_membership_id is not None:
        inv_m = db.get(Membership, req.requested_by_membership_id)
        if inv_m is not None:
            inviter_p = db.get(Person, inv_m.person_id)
    return AdminPromotionPreviewOut(
        tenant_name=tenant.name if tenant else "?",
        target_person_name=target_p.name if target_p else "?",
        inviter_person_name=inviter_p.name if inviter_p else None,
        status=req.status,  # type: ignore[arg-type]
        expires_at=req.expires_at,
    )

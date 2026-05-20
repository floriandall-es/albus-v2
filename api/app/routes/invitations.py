"""Invitation flow.

The raw token is generated server-side and sent back to the inviter ONCE.
Two hashes are persisted per row:
- token_hash: bcrypt(raw_token), used for constant-time equality check.
- token_lookup: HMAC-SHA256(secret, raw_token), indexed + unique. The
  public lookup endpoint recomputes this from the user-supplied token
  and uses it for an O(1) RLS-gated row select. No cross-tenant scan.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_access_token,
    hash_password,
    pwd_context,
)
from app.db.session import SessionLocal, set_tenant
from app.models import Category, Invitation, Membership, Person, Tenant
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import AuthResponse
from app.schemas.invitation import (
    InvitationOut,
    InvitationPublicView,
    InviteAcceptRequest,
    InviteAcceptResponse,
    InviteCreateRequest,
    InviteCreateResponse,
)
from app.services.invitations import create_invitation as create_invitation_service
from app.services.invitations import (
    invitation_token_lookup,
    is_already_member,
    regenerate_invitation_token,
    send_invitation_email,
)

logger = logging.getLogger("app.invitations")


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")


router = APIRouter()


# ---------------------------------------------------------------------------
# CREATE — POST /api/team/invite (replaces the old stub)
# ---------------------------------------------------------------------------
@router.post(
    "/team/invite",
    response_model=InviteCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_invitation(
    payload: InviteCreateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> InviteCreateResponse:
    _require_admin(ctx)

    if payload.category_id is not None:
        cat = ctx.db.get(Category, payload.category_id)
        if not cat or cat.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=422, detail="Unknown category_id")

    email = payload.email.lower()

    if is_already_member(ctx.db, ctx.tenant.id, email):
        raise HTTPException(
            status_code=409, detail="Person is already a member of this tenant"
        )

    try:
        created = create_invitation_service(
            ctx.db,
            tenant_id=ctx.tenant.id,
            email=email,
            person_name=payload.person_name,
            created_by_membership_id=ctx.membership.id,
            category_id=payload.category_id,
            roles=payload.roles or ["member"],
        )
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Conflict creating invitation")

    logger.info(
        "Invitation created tenant=%s email=%s id=%s",
        ctx.tenant.slug,
        email,
        created.invitation.id,
    )
    send_invitation_email(ctx.db, tenant_id=ctx.tenant.id, created=created)

    return InviteCreateResponse(
        invitation_id=created.invitation.id,
        email=created.invitation.email,
        expires_at=created.invitation.expires_at,
        accept_url=created.accept_url,
    )


# ---------------------------------------------------------------------------
# LIST + REVOKE — admin-only, scoped to current tenant
# ---------------------------------------------------------------------------
@router.get("/invitations", response_model=list[InvitationOut])
def list_invitations(ctx: RequestContext = Depends(get_current_context)) -> list[Invitation]:
    _require_admin(ctx)
    now = datetime.now(timezone.utc)
    rows = (
        ctx.db.query(Invitation)
        .filter(
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
            Invitation.expires_at > now,
        )
        .order_by(Invitation.created_at.desc())
        .all()
    )
    return rows


@router.post("/invitations/{invitation_id}/revoke", response_model=InvitationOut)
def revoke_invitation(
    invitation_id: int, ctx: RequestContext = Depends(get_current_context)
) -> Invitation:
    _require_admin(ctx)
    inv = ctx.db.get(Invitation, invitation_id)
    if not inv or inv.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.accepted_at is not None:
        raise HTTPException(status_code=400, detail="Already accepted")
    if inv.revoked_at is None:
        inv.revoked_at = datetime.now(timezone.utc)
    ctx.db.flush()
    return inv


@router.post(
    "/invitations/{invitation_id}/resend", response_model=InvitationOut
)
def resend_invitation(
    invitation_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Invitation:
    """Rotate the token on an existing pending invitation and email
    the recipient again.

    Differs from /reissue: this mutates the existing row (same id,
    same created_at) rather than revoking + creating a new one.
    From the admin's perspective the invitation entry stays put on
    their list, with last_email_sent_at moving forward each time
    they re-send. The old accept URL stops working because
    token_lookup is rotated.

    Returns the full invitation row so the UI can refresh the
    delivery-status pill without a follow-up list call.
    """
    _require_admin(ctx)
    inv = ctx.db.get(Invitation, invitation_id)
    if not inv or inv.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.accepted_at is not None:
        raise HTTPException(
            status_code=400, detail="La invitación ya se ha aceptado"
        )
    if inv.revoked_at is not None:
        raise HTTPException(
            status_code=400, detail="La invitación se ha revocado"
        )
    created = regenerate_invitation_token(ctx.db, invitation=inv)
    send_invitation_email(ctx.db, tenant_id=ctx.tenant.id, created=created)
    ctx.db.flush()
    return inv


@router.post("/invitations/{invitation_id}/reissue", response_model=InviteCreateResponse)
def reissue_invitation(
    invitation_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> InviteCreateResponse:
    """Re-send the invitation: rotates the token + expiry on the
    existing row and re-emails the recipient. Returns the fresh
    accept_url so the admin can copy a backup link if the email
    bounces.

    Now that Person + Membership are created at invite time (sprint
    25), this endpoint can no longer call create_invitation_service
    — that would try to create a second Membership and 409 on the
    uq_membership_tenant_person constraint. We use the same in-place
    token rotation as /resend instead. Same row, fresh secrets, new
    7d expiry."""
    _require_admin(ctx)
    inv = ctx.db.get(Invitation, invitation_id)
    if not inv or inv.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.accepted_at is not None:
        raise HTTPException(status_code=400, detail="ya aceptada")
    if inv.revoked_at is not None:
        raise HTTPException(status_code=400, detail="La invitación se ha revocado")

    created = regenerate_invitation_token(ctx.db, invitation=inv)
    send_invitation_email(ctx.db, tenant_id=ctx.tenant.id, created=created)

    return InviteCreateResponse(
        invitation_id=created.invitation.id,
        email=created.invitation.email,
        expires_at=created.invitation.expires_at,
        accept_url=created.accept_url,
    )


# ---------------------------------------------------------------------------
# PUBLIC token endpoints — no auth, no tenant context.
# ---------------------------------------------------------------------------
def _public_db():
    """Session for public invite endpoints. No tenant context is set, so RLS
    blocks reads of tenant-scoped tables. We use it only to find Tenant rows
    (un-RLS'd) and then explicitly switch into the tenant's RLS context once
    we've matched a token."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _find_invitation_by_token(db: Session, raw_token: str) -> Invitation | None:
    """Find a non-superseded Invitation matching the user-supplied token.

    Sprint 17: indexed RLS-gated lookup. No cross-tenant table scan, no
    migrations-role bypass.

    Flow:
    1. Compute HMAC-SHA256(secret, raw_token) — this is the row's
       indexed `token_lookup` column.
    2. SET LOCAL app.invitation_lookup = <hash>. The RLS policy
       `rls_invitations_public_lookup` then permits SELECTing exactly
       the row whose `token_lookup` matches — at most one row by
       UNIQUE constraint.
    3. bcrypt-verify the user's raw token against `token_hash` as
       defense-in-depth (in case the lookup secret leaks, attackers
       still need the raw token; in case of a hash collision, bcrypt
       rejects it).
    4. Switch the session to the tenant's RLS context for callers
       that want to mutate the row.

    Returns None for empty, oversized, or non-matching tokens.
    """
    if not raw_token or len(raw_token) > 256:
        return None
    now = datetime.now(timezone.utc)
    lookup = invitation_token_lookup(raw_token)

    # Set the session var that the public-lookup RLS policy reads,
    # scoped to this transaction. Bound parameter so a hostile token
    # can't escape (though `lookup` is a hex digest, so the question
    # is moot).
    db.execute(text("SELECT set_config('app.invitation_lookup', :v, true)"), {"v": lookup})

    inv = (
        db.query(Invitation)
        .filter(
            Invitation.token_lookup == lookup,
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
            Invitation.expires_at > now,
        )
        .first()
    )
    if inv is None:
        return None
    # Defense in depth: even though we just matched on a deterministic
    # HMAC, also bcrypt-verify the raw token. Two independent crypto
    # primitives both have to agree.
    try:
        if not pwd_context.verify(raw_token, inv.token_hash):
            return None
    except Exception:
        return None
    # Switch the session into the invitation's tenant so subsequent
    # writes by the caller go through the normal tenant-scoped RLS
    # policies. Also clear the public-lookup setting — we don't want
    # to keep it active for the rest of the request.
    db.execute(text("SELECT set_config('app.invitation_lookup', '', true)"))
    set_tenant(db, inv.tenant_id)
    return inv


@router.get("/invitations/by-token/{raw_token}", response_model=InvitationPublicView)
def get_invitation_public(raw_token: str, db: Session = Depends(_public_db)) -> InvitationPublicView:
    inv = _find_invitation_by_token(db, raw_token)
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found or expired")
    tenant = db.get(Tenant, inv.tenant_id)
    if not tenant:
        raise HTTPException(status_code=404, detail="Invitation not found or expired")
    return InvitationPublicView(
        tenant_name=tenant.name,
        tenant_slug=tenant.slug,
        email=inv.email,
        person_name=inv.person_name,
        expires_at=inv.expires_at,
    )


@router.post(
    "/invitations/by-token/{raw_token}/accept", response_model=InviteAcceptResponse
)
def accept_invitation(
    raw_token: str,
    payload: InviteAcceptRequest,
    db: Session = Depends(_public_db),
) -> AuthResponse:
    if not payload.accept_terms:
        raise HTTPException(
            status_code=422,
            detail=(
                "Debes aceptar los términos y la política de "
                "privacidad para activar tu cuenta."
            ),
        )
    inv = _find_invitation_by_token(db, raw_token)
    if not inv:
        raise HTTPException(status_code=400, detail="Invitation not found or expired")

    # Tenant context is already set by _find_invitation_by_token.
    tenant = db.get(Tenant, inv.tenant_id)
    if not tenant:
        raise HTTPException(status_code=400, detail="Invitation tenant missing")

    # The Person + Membership were created at invite time (sprint
    # 25). This endpoint now just turns a pendiente Person into an
    # activo one — sets the password, fills in profile fields, stamps
    # the email-verified + terms-accepted markers. Cross-tenant
    # invites of an already-active Person leave the password alone.
    person = db.query(Person).filter(Person.email == inv.email).first()
    if not person:
        # Defensive: this would mean somebody deleted the Person row
        # between invite and accept. Surface a clear error rather
        # than try to repair invisibly.
        raise HTTPException(
            status_code=400,
            detail="La cuenta asociada a esta invitación ya no existe.",
        )

    membership = (
        db.query(Membership)
        .filter(
            Membership.tenant_id == tenant.id,
            Membership.person_id == person.id,
        )
        .first()
    )
    if not membership:
        # Same defensive case — admin removed the Membership before
        # the invitee could accept. Don't silently re-create it; the
        # admin's intent was to remove this person.
        raise HTTPException(
            status_code=400,
            detail="Ya no formas parte de este equipo. Pide al administrador una invitación nueva.",
        )

    from app.services.person_name import compose_name

    composed_name, first_name, last_name = compose_name(
        name=payload.person_name or inv.person_name,
        first_name=payload.first_name,
        last_name=payload.last_name,
    )

    now_utc = datetime.now(timezone.utc)
    if person.hashed_password is None:
        # First-time activation. Set the password, profile fields,
        # email-verified + terms-accepted markers. Email verification
        # is granted automatically because clicking the invite link
        # is the same mailbox proof we ask for at signup.
        person.hashed_password = hash_password(payload.password)
        person.name = composed_name
        person.first_name = first_name
        person.last_name = last_name
        person.email_verified_at = now_utc
        person.terms_accepted_at = now_utc
        person.terms_accepted_version = settings.terms_current_version
        created_person = True
    else:
        # Cross-tenant accept: the Person already has a password from
        # a previous tenant's activation. Do NOT overwrite it — that
        # would let any invitation link silently reset the user's
        # password across tenants. We also leave first/last name
        # alone (the previous tenant's value wins).
        created_person = False

    inv.accepted_at = now_utc

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Conflict accepting invitation")

    # Re-set tenant for any post-commit refresh.
    set_tenant(db, tenant.id)
    db.refresh(tenant)
    db.refresh(person)
    db.refresh(membership)

    token = create_access_token(
        person_id=person.id, tenant_id=tenant.id, roles=membership.roles
    )

    logger.info(
        "Invitation accepted tenant=%s email=%s created_person=%s",
        tenant.slug,
        person.email,
        created_person,
    )

    return AuthResponse(
        access_token=token,
        tenant=tenant,  # type: ignore[arg-type]
        person=person,  # type: ignore[arg-type]
        memberships=[membership],  # type: ignore[list-item]
    )

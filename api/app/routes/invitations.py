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


@router.post("/invitations/{invitation_id}/reissue", response_model=InviteCreateResponse)
def reissue_invitation(
    invitation_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> InviteCreateResponse:
    """Re-send the invitation: revokes the old row, creates a fresh one with
    a new token + expiry, sends the email, returns the new accept_url."""
    _require_admin(ctx)
    inv = ctx.db.get(Invitation, invitation_id)
    if not inv or inv.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.accepted_at is not None:
        raise HTTPException(status_code=400, detail="ya aceptada")

    try:
        created = create_invitation_service(
            ctx.db,
            tenant_id=ctx.tenant.id,
            email=inv.email,
            person_name=inv.person_name,
            created_by_membership_id=ctx.membership.id,
            category_id=inv.category_id,
            roles=list(inv.roles) if inv.roles else ["member"],
        )
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Conflict creating invitation")

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

    person = db.query(Person).filter(Person.email == inv.email).first()
    created_person = False
    # Compose the canonical name from whatever the invitee provided.
    # Falls back to the invitation's `person_name` if neither
    # split fields nor a legacy `person_name` came in the payload.
    from app.services.person_name import compose_name

    composed_name, first_name, last_name = compose_name(
        name=payload.person_name or inv.person_name,
        first_name=payload.first_name,
        last_name=payload.last_name,
    )

    if person:
        # Existing user: check they're not already a member of THIS tenant.
        already = (
            db.query(Membership)
            .filter(
                Membership.tenant_id == tenant.id,
                Membership.person_id == person.id,
            )
            .first()
        )
        if already:
            raise HTTPException(status_code=400, detail="Already a member")
        # Don't change existing user's password or canonical name —
        # linking accounts cross-tenant should leave their previously-
        # set profile alone. Skip the update.
    else:
        # Invitees who land here via an emailed link have already
        # demonstrated mailbox control, same proof as the signup
        # verification step. Stamp email_verified_at + terms
        # acceptance at the same time so the new Person starts in
        # a clean, fully-onboarded state.
        now_utc = datetime.now(timezone.utc)
        person = Person(
            email=inv.email,
            hashed_password=hash_password(payload.password),
            name=composed_name,
            first_name=first_name,
            last_name=last_name,
            email_verified_at=now_utc,
            terms_accepted_at=now_utc,
            terms_accepted_version=settings.terms_current_version,
        )
        db.add(person)
        db.flush()
        created_person = True

    membership = Membership(
        tenant_id=tenant.id,
        person_id=person.id,
        roles=list(inv.roles) or ["member"],
        category_id=inv.category_id,
    )
    db.add(membership)

    inv.accepted_at = datetime.now(timezone.utc)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Conflict creating membership")

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

"""Invitation flow.

The raw token is generated server-side and sent back to the inviter ONCE
(in the response and the API logs, since email is stubbed). Only the bcrypt
hash is persisted. Lookup is O(N) over active invitations because bcrypt
prevents indexing on the hash — that's fine at our scale; if it ever isn't,
we'd switch to a public-id lookup column + bcrypt verify on the secret.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
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
from app.services.invitations import is_already_member, send_invitation_email

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
    """Find a non-superseded Invitation matching the bcrypt-hashed token.

    Linear scan over candidates — there's no index-friendly way to look up a
    bcrypt hash, but we narrow first by status (active, unexpired). At our
    expected scale this is fine.
    """
    if not raw_token or len(raw_token) > 256:
        return None
    now = datetime.now(timezone.utc)
    # We need to read invitations across tenants — temporarily disable RLS by
    # NOT setting app.tenant_id (the policy denies all rows). The migrations
    # role bypasses RLS, the runtime role does not. So the runtime can't do
    # this scan. Workaround: open a new connection and use a brief
    # cross-tenant SECURITY-DEFINER-style escape — for Sprint 3 we accept
    # using the migrations role for token lookup. To avoid leaking that role,
    # we keep the engine local and dispose immediately.
    from sqlalchemy import create_engine

    admin_engine = create_engine(settings.database_url, future=True)
    try:
        with admin_engine.connect() as conn:
            rows = conn.execute(
                # Raw select so we don't need ORM session bound to this engine.
                # SQLAlchemy text() with named params.
                __import__("sqlalchemy").text(
                    """
                    SELECT id, tenant_id, email, person_name, token_hash,
                           expires_at, accepted_at, revoked_at,
                           category_id, roles, created_at,
                           created_by_membership_id
                    FROM invitations
                    WHERE accepted_at IS NULL
                      AND revoked_at IS NULL
                      AND expires_at > :now
                    """
                ),
                {"now": now},
            ).all()
    finally:
        admin_engine.dispose()

    for row in rows:
        try:
            if pwd_context.verify(raw_token, row.token_hash):
                # Re-fetch via the ORM session so callers can mutate it.
                inv = db.get(Invitation, row.id)
                # The ORM read above goes through RLS, which (with no tenant set)
                # returns None. Set tenant context and re-fetch.
                set_tenant(db, row.tenant_id)
                return db.get(Invitation, row.id)
        except Exception:
            continue
    return None


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
    inv = _find_invitation_by_token(db, raw_token)
    if not inv:
        raise HTTPException(status_code=400, detail="Invitation not found or expired")

    # Tenant context is already set by _find_invitation_by_token.
    tenant = db.get(Tenant, inv.tenant_id)
    if not tenant:
        raise HTTPException(status_code=400, detail="Invitation tenant missing")

    person = db.query(Person).filter(Person.email == inv.email).first()
    created_person = False
    display_name = (payload.person_name or inv.person_name).strip()

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
        # Don't change existing user's password. We could update display name
        # if they pass one, but linking accounts cross-tenant should leave the
        # canonical name alone. Skip the update.
    else:
        person = Person(
            email=inv.email,
            hashed_password=hash_password(payload.password),
            name=display_name,
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

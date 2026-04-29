"""Shared invitation creation helpers.

Used by both the single-invite endpoint (POST /api/team/invite) and the bulk
commit endpoint (POST /api/team/invite/bulk/commit) so that token generation,
hashing, expiry, accept-url construction, and the "revoke any pending invite
for the same (tenant, email)" rule live in one place.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import pwd_context
from app.models import Invitation, Membership, Person

INVITE_TTL = timedelta(days=7)


@dataclass
class CreatedInvitation:
    invitation: Invitation
    raw_token: str
    accept_url: str


def build_accept_url(raw_token: str) -> str:
    return f"{settings.public_base_url.rstrip('/')}/invite/{raw_token}"


def revoke_live_invitations(
    db: Session, tenant_id: int, email: str, now: datetime | None = None
) -> int:
    """Mark every non-accepted, non-revoked invitation for (tenant, email) as
    revoked. Returns the number revoked. Caller is responsible for flushing.
    """
    now = now or datetime.now(timezone.utc)
    rows = (
        db.query(Invitation)
        .filter(
            Invitation.tenant_id == tenant_id,
            Invitation.email == email,
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
        )
        .all()
    )
    for inv in rows:
        inv.revoked_at = now
    return len(rows)


def has_live_invitation(db: Session, tenant_id: int, email: str) -> bool:
    now = datetime.now(timezone.utc)
    return (
        db.query(Invitation.id)
        .filter(
            Invitation.tenant_id == tenant_id,
            Invitation.email == email,
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
            Invitation.expires_at > now,
        )
        .first()
        is not None
    )


def is_already_member(db: Session, tenant_id: int, email: str) -> bool:
    person = db.query(Person).filter(Person.email == email).first()
    if not person:
        return False
    membership = (
        db.query(Membership)
        .filter(
            Membership.tenant_id == tenant_id,
            Membership.person_id == person.id,
        )
        .first()
    )
    return membership is not None


def create_invitation(
    db: Session,
    *,
    tenant_id: int,
    email: str,
    person_name: str,
    created_by_membership_id: int | None,
    category_id: int | None = None,
    roles: list[str] | None = None,
) -> CreatedInvitation:
    """Create a new Invitation row (revoking any live one for the same
    tenant+email first). Caller is responsible for flushing/committing and
    handling IntegrityError.
    """
    now = datetime.now(timezone.utc)
    revoke_live_invitations(db, tenant_id, email, now=now)

    raw_token = secrets.token_urlsafe(32)
    token_hash = pwd_context.hash(raw_token)

    inv = Invitation(
        tenant_id=tenant_id,
        email=email,
        person_name=person_name,
        token_hash=token_hash,
        expires_at=now + INVITE_TTL,
        created_by_membership_id=created_by_membership_id,
        category_id=category_id,
        roles=list(roles) if roles else ["member"],
    )
    db.add(inv)
    db.flush()
    return CreatedInvitation(
        invitation=inv,
        raw_token=raw_token,
        accept_url=build_accept_url(raw_token),
    )

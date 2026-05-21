"""Shared invitation creation helpers.

Used by both the single-invite endpoint (POST /api/team/invite) and the bulk
commit endpoint (POST /api/team/invite/bulk/commit) so that token generation,
hashing, expiry, accept-url construction, and the "revoke any pending invite
for the same (tenant, email)" rule live in one place.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import pwd_context
from app.models import Invitation, Membership, Person, Tenant
from app.services.email import send_email
from app.services.email_templates import invitation_email

logger = logging.getLogger("app.invitations")

INVITE_TTL = timedelta(days=7)


def invitation_token_lookup(raw_token: str) -> str:
    """HMAC-SHA256(secret, raw_token) hex digest. Deterministic, so
    the public lookup endpoint can recompute it from the user-supplied
    token and find the row in O(1). The key lives in
    settings.invitation_lookup_secret — rotating it invalidates every
    pending invitation."""
    return hmac.new(
        settings.invitation_lookup_secret.encode("utf-8"),
        raw_token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


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
    """Create the Person + Membership + Invitation token in one go.

    Until sprint 25 this only created the Invitation row; the Person
    and Membership came into existence at accept time. That was wrong
    for a paid B2B tool: the admin couldn't schedule anybody until
    each individual clinician actively logged in, and many of them
    never will.

    New behaviour:
      - Person row created on first invite for this email (with
        hashed_password=NULL = pendiente). Re-used across tenants on
        subsequent invites.
      - Membership for (tenant, person) created with the invite's
        category + roles + default FTE=100. If a Membership already
        exists, the caller has already raised 409 via is_already_member.
        We don't try to re-enable disabled memberships here — that's
        a separate admin action.
      - Invitation token row created as before. Any live token for
        the same (tenant, email) is revoked first.

    The Person/Membership pair is enough for the solver to schedule
    the new member immediately. They become a "pendiente" until they
    accept the invitation and set their password.

    Caller is responsible for flushing/committing and handling
    IntegrityError.
    """
    now = datetime.now(timezone.utc)
    revoke_live_invitations(db, tenant_id, email, now=now)

    # Find-or-create the Person. Cross-tenant invites of an
    # already-active person re-use the existing row (and keep their
    # existing password / verified-email / accepted-terms state).
    person = db.query(Person).filter(Person.email == email).first()
    composed_name = person_name.strip()
    if not person:
        person = Person(
            email=email,
            hashed_password=None,
            name=composed_name,
            # No split-name info on the invite payload yet; the
            # invitee fills first/last when they accept. Until then
            # the canonical `name` column carries whatever the admin
            # typed.
            first_name=None,
            last_name=None,
        )
        db.add(person)
        db.flush()

    # Create the Membership. is_already_member should have been
    # called by the caller before we get here, so a UniqueConstraint
    # collision means the caller skipped that check — fall through
    # to the outer IntegrityError handler.
    membership = Membership(
        tenant_id=tenant_id,
        person_id=person.id,
        roles=list(roles) if roles else ["member"],
        category_id=category_id,
    )
    db.add(membership)

    raw_token = secrets.token_urlsafe(32)
    token_hash = pwd_context.hash(raw_token)
    token_lookup = invitation_token_lookup(raw_token)

    inv = Invitation(
        tenant_id=tenant_id,
        email=email,
        person_name=composed_name,
        token_hash=token_hash,
        token_lookup=token_lookup,
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


def issue_invitation_for_existing_pendiente(
    db: Session,
    *,
    tenant_id: int,
    person: Person,
    membership: Membership,
) -> CreatedInvitation:
    """Create a fresh Invitation token for a Person + Membership pair
    that already exist (legacy migration, prior cross-tenant invite,
    etc.) but are still pendiente. Skips the find-or-create Person +
    Membership steps of `create_invitation` — those would 409 on the
    existing rows.

    Called from:
      - POST /api/team/{membership_id}/invitation — the per-row
        "Enviar invitación" button on /admin/team.
      - scripts/bootstrap_admin_invitation.py for the first admin
        of a freshly-migrated tenant.

    Revokes any live Invitations for (tenant, email) first, so prior
    URLs stop working. Caller is responsible for sending the email
    (or otherwise delivering the URL) and for flushing/committing.
    """
    now = datetime.now(timezone.utc)
    revoke_live_invitations(db, tenant_id, person.email, now=now)

    raw_token = secrets.token_urlsafe(32)
    inv = Invitation(
        tenant_id=tenant_id,
        email=person.email,
        person_name=person.name,
        token_hash=pwd_context.hash(raw_token),
        token_lookup=invitation_token_lookup(raw_token),
        expires_at=now + INVITE_TTL,
        # No created_by_membership_id captured here — the caller can
        # set it post-return if they want; for the legacy bootstrap
        # there's no admin acting yet.
        created_by_membership_id=None,
        category_id=membership.category_id,
        roles=list(membership.roles),
    )
    db.add(inv)
    db.flush()
    return CreatedInvitation(
        invitation=inv,
        raw_token=raw_token,
        accept_url=build_accept_url(raw_token),
    )


def send_invitation_email(
    db: Session,
    *,
    tenant_id: int,
    created: CreatedInvitation,
) -> None:
    """Best-effort send. Looks up the tenant for the body. Never raises.

    Updates the row's last_email_sent_at on success or
    last_email_error on failure so the admin UI can show a
    delivery-status pill on each invitation row. (Underlying
    send_email itself never raises — it logs SMTP errors and
    returns; we wrap with our own try/except so any template or
    DB-fetch failure also lands in last_email_error rather than
    bubbling into the HTTP response.)
    """
    inv = created.invitation
    err: str | None = None
    try:
        tenant = db.get(Tenant, tenant_id)
        tenant_name = tenant.name if tenant else "tu equipo"
        subject, body = invitation_email(
            person_name=inv.person_name,
            tenant_name=tenant_name,
            accept_url=created.accept_url,
            expires_at=inv.expires_at,
        )
        send_email(to=inv.email, subject=subject, body_text=body)
    except Exception as exc:  # pragma: no cover
        err = f"{type(exc).__name__}: {exc}"
        logger.error(
            "Could not send invitation email tenant=%s email=%s err=%s",
            tenant_id,
            inv.email,
            exc,
        )

    if err is None:
        inv.last_email_sent_at = datetime.now(timezone.utc)
        inv.last_email_error = None
    else:
        # Don't clear last_email_sent_at — keep the previous-success
        # timestamp visible so the UI can show "última entrega: X,
        # último intento falló". last_email_error wins precedence
        # in the pill colour.
        inv.last_email_error = err


def regenerate_invitation_token(
    db: Session,
    *,
    invitation: Invitation,
) -> CreatedInvitation:
    """Rotate the token on an existing invitation so a fresh accept
    URL can be sent. Old link becomes invalid because the
    token_lookup column moves.

    Resets expires_at to NOW + INVITE_TTL so an admin re-sending a
    nearly-expired invite doesn't hand the recipient a link that
    dies in five minutes. Used by the resend endpoint.
    """
    now = datetime.now(timezone.utc)
    raw_token = secrets.token_urlsafe(32)
    invitation.token_hash = pwd_context.hash(raw_token)
    invitation.token_lookup = invitation_token_lookup(raw_token)
    invitation.expires_at = now + INVITE_TTL
    db.flush()
    return CreatedInvitation(
        invitation=invitation,
        raw_token=raw_token,
        accept_url=build_accept_url(raw_token),
    )

"""One-off bootstrap: emit an activation URL for a pendiente admin.

After the legacy migration commits, the new tenant's admin (a
pendiente Person — no password yet) has no way to log in:

  - /forgot-password short-circuits for pendientes by design
    (it doesn't want to leak which addresses have been invited
    but not activated).
  - The standard "Reenviar invitación" flow requires an
    already-authenticated admin, which is the chicken-and-egg
    we're trying to break.

This script creates a fresh Invitation row for an existing
pendiente Membership and prints the activation URL. You paste
that URL to the admin via your own communication channel.
Once they activate, the standard flow takes over: they can
invite/re-invite everyone else from /admin/team.

Usage (from `api/`):

    python -m scripts.bootstrap_admin_invitation \\
        --tenant-slug cirugia-toracica-hospital-la-fe \\
        --email sales_jes@gva.es

Idempotent: re-running revokes any live invitations first and
issues a new one. Existing token URLs from prior runs stop
working.

Safety guards:
  - Errors out if the Person isn't pendiente (already has a
    password — they don't need this).
  - Errors out if there's no Membership in the target tenant.
  - Prints the email + URL to stdout only; nothing is sent.
"""

from __future__ import annotations

import argparse
import secrets
import sys
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.core.security import pwd_context
from app.db.session import SessionLocal, set_tenant
from app.models import Invitation, Membership, Person, Tenant
from app.services.invitations import (
    INVITE_TTL,
    build_accept_url,
    invitation_token_lookup,
    revoke_live_invitations,
)


def bootstrap(db: Session, tenant_slug: str, email: str) -> str:
    email = email.lower()

    tenant = db.query(Tenant).filter(Tenant.slug == tenant_slug).first()
    if tenant is None:
        raise SystemExit(f"Tenant with slug '{tenant_slug}' not found.")

    set_tenant(db, tenant.id)

    person = db.query(Person).filter(Person.email == email).first()
    if person is None:
        raise SystemExit(
            f"No Person with email '{email}'. Did the migration run? "
            "Did you typo the address?"
        )
    if person.hashed_password is not None:
        raise SystemExit(
            f"Person '{email}' already has a password set "
            "(not pendiente). Use the standard /forgot-password "
            "flow or the admin's /admin/team invite resender."
        )

    membership = (
        db.query(Membership)
        .filter(
            Membership.tenant_id == tenant.id,
            Membership.person_id == person.id,
        )
        .first()
    )
    if membership is None:
        raise SystemExit(
            f"Person '{email}' has no Membership in tenant "
            f"'{tenant_slug}'. Pick a different tenant or email."
        )
    # Surface a warning if the membership isn't admin — bootstrap
    # is intended for admins, but we don't hard-fail since the
    # same mechanism might legitimately get used for a stuck
    # lead. Print it so the operator notices.
    if "admin" not in membership.roles:
        print(
            f"WARNING: Membership for '{email}' has roles={membership.roles} "
            "(no admin). Proceeding anyway — verify this is the "
            "person you meant.",
            file=sys.stderr,
        )

    now = datetime.now(timezone.utc)
    # Drop any live invitations so prior bootstrap attempts (or a
    # forgotten team-page invite) don't leave stale URLs working.
    revoke_live_invitations(db, tenant.id, email, now=now)

    raw_token = secrets.token_urlsafe(32)
    inv = Invitation(
        tenant_id=tenant.id,
        email=email,
        person_name=person.name,
        token_hash=pwd_context.hash(raw_token),
        token_lookup=invitation_token_lookup(raw_token),
        expires_at=now + INVITE_TTL,
        # No `created_by_membership_id` — there's no admin acting
        # on behalf of anyone here. The Invitation FK is nullable
        # exactly for this case (and migration imports of legacy
        # invitations).
        created_by_membership_id=None,
        category_id=membership.category_id,
        roles=list(membership.roles),
    )
    db.add(inv)
    db.flush()

    return build_accept_url(raw_token)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tenant-slug",
        required=True,
        help="Slug of the tenant (e.g. cirugia-toracica-hospital-la-fe)",
    )
    parser.add_argument(
        "--email",
        required=True,
        help="Email of the pendiente admin to bootstrap",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write the Invitation row. Without this flag "
        "the script does the work and rolls back at the end "
        "(useful for sanity-checking before issuing a real URL).",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        url = bootstrap(db, args.tenant_slug, args.email)
        if args.commit:
            db.commit()
            print("")
            print("=" * 60)
            print("  Activation URL — share via secure channel")
            print("=" * 60)
            print("")
            print(f"  {url}")
            print("")
            print(f"  Valid for {INVITE_TTL.days} days. Re-run this")
            print("  script to revoke + reissue.")
            print("")
            return 0
        else:
            db.rollback()
            print("")
            print("DRY RUN — Invitation would be created with this URL:")
            print(f"  {url}")
            print("")
            print("Re-run with --commit to actually persist.")
            return 0
    except Exception as exc:
        db.rollback()
        print(f"\nBOOTSTRAP FAILED: {type(exc).__name__}: {exc}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())

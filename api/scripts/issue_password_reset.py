"""One-off password-reset URL emitter for an activated user.

Use when /forgot-password isn't an option — typically because:
  - SMTP isn't configured / is broken
  - The user's mailbox doesn't accept the reset email
  - Time-pressure recovery (you need someone in NOW)

Looks up the Person by email, builds the same password-reset
JWT the /forgot-password route would, and prints the
/reset-password?token=... URL to stdout. You deliver it via
whatever channel you trust.

Activated users only — if hashed_password IS NULL the Person
is pendiente and needs the regular invitation flow
(scripts/bootstrap_admin_invitation.py).

Usage (from `api/`):

    python -m scripts.issue_password_reset --email mara@example.com

Idempotent: a fresh token is emitted on each call. The
fingerprint binding in the token (a hash of the current
password) means any previously-emitted token still works
until the user actually completes a reset, at which point
the fingerprint moves and all prior tokens are invalidated.
1h TTL applies per the security helper.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_password_reset_token,
    password_fingerprint,
)
from app.db.session import SessionLocal
from app.models import Person


def issue(db: Session, email: str) -> str:
    email = email.lower()
    person = db.query(Person).filter(Person.email == email).first()
    if person is None:
        raise SystemExit(f"No Person with email '{email}'.")
    if person.hashed_password is None:
        raise SystemExit(
            f"Person '{email}' is pendiente (no password set yet). "
            "Use scripts/bootstrap_admin_invitation.py instead — they "
            "need to activate via the invitation flow, not reset."
        )

    token = create_password_reset_token(
        person_id=person.id,
        password_fp=password_fingerprint(person.hashed_password),
    )
    url = (
        f"{settings.public_base_url.rstrip('/')}/reset-password?token={token}"
    )
    return url


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--email",
        required=True,
        help="Email of the person whose password you want to reset.",
    )
    args = ap.parse_args()

    db = SessionLocal()
    try:
        url = issue(db, args.email)
    finally:
        db.close()

    # stderr for human context; stdout is JUST the URL so the
    # operator can pipe / copy it cleanly.
    print(f"Reset URL for {args.email} (valid {settings.password_reset_ttl_minutes} min):", file=sys.stderr)
    print(url)


if __name__ == "__main__":
    main()

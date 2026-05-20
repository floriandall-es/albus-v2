from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def create_access_token(*, person_id: int, tenant_id: int, roles: list[str]) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "kind": "access",
        "person_id": person_id,
        "tenant_id": tenant_id,
        "roles": roles,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.jwt_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    # Reject any token that isn't an access token. Pre-auth tokens (issued
    # during the multi-tenant login picker flow) carry kind=pre_auth and
    # MUST NOT be usable as bearer credentials. Older tokens without a kind
    # claim are accepted for backwards compatibility.
    kind = payload.get("kind", "access")
    if kind != "access":
        raise jwt.InvalidTokenError(f"Token kind {kind!r} cannot be used as access token")
    return payload


def create_pre_auth_token(*, person_id: int) -> str:
    """Short-lived token issued after email+password verification when the
    person has 2+ memberships and must pick a tenant before getting a real
    access token. Cannot be used as a bearer credential — see
    decode_access_token."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "kind": "pre_auth",
        "person_id": person_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.pre_auth_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_pre_auth_token(token: str) -> dict[str, Any]:
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    if payload.get("kind") != "pre_auth":
        raise jwt.InvalidTokenError("Not a pre-auth token")
    if not payload.get("person_id"):
        raise jwt.InvalidTokenError("Malformed pre-auth token")
    return payload


def create_email_change_token(
    *, person_id: int, new_email: str
) -> str:
    """Self-contained JWT carrying the email change request. Sent in
    the confirmation link to the NEW address; the recipient clicking
    it is the proof of address ownership we want.

    Bound to the specific `new_email` so an intercepted token can
    only ever apply that one change — no swapping to a different
    address. Cannot be used as a bearer credential (kind ≠ access)."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "kind": "email_change",
        "person_id": person_id,
        "new_email": new_email,
        "iat": int(now.timestamp()),
        "exp": int(
            (
                now
                + timedelta(hours=settings.email_change_ttl_hours)
            ).timestamp()
        ),
    }
    return jwt.encode(
        payload, settings.jwt_secret, algorithm=settings.jwt_algorithm
    )


def decode_email_change_token(token: str) -> dict[str, Any]:
    payload = jwt.decode(
        token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
    )
    if payload.get("kind") != "email_change":
        raise jwt.InvalidTokenError("Not an email-change token")
    if not payload.get("person_id") or not payload.get("new_email"):
        raise jwt.InvalidTokenError("Malformed email-change token")
    return payload


def create_email_verify_token(*, person_id: int) -> str:
    """Self-contained JWT identifying a person to be marked verified.
    Sent on signup to the address the user gave us; clicking the
    link is proof they control that mailbox.

    Distinct `kind` from email_change so an intercepted token can
    only ever verify the address — never grant access or mutate
    an unrelated person's email."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "kind": "email_verify",
        "person_id": person_id,
        "iat": int(now.timestamp()),
        "exp": int(
            (
                now
                + timedelta(hours=settings.email_verify_ttl_hours)
            ).timestamp()
        ),
    }
    return jwt.encode(
        payload, settings.jwt_secret, algorithm=settings.jwt_algorithm
    )


def decode_email_verify_token(token: str) -> dict[str, Any]:
    payload = jwt.decode(
        token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
    )
    if payload.get("kind") != "email_verify":
        raise jwt.InvalidTokenError("Not an email-verify token")
    if not payload.get("person_id"):
        raise jwt.InvalidTokenError("Malformed email-verify token")
    return payload


def create_password_reset_token(*, person_id: int, password_fp: str) -> str:
    """Self-contained JWT carrying a password-reset grant.

    Sent to the user's email after they request a reset. Bound to
    `password_fp` (a short fingerprint of the current bcrypt hash);
    once the password actually changes, the fingerprint moves and
    any still-in-flight token for the old password becomes invalid.
    Gives us single-use semantics without a token table.

    1h TTL is the standard window — long enough for the user to
    open the email on a phone, short enough that a stolen mailbox
    doesn't yield long-term reset capability."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "kind": "password_reset",
        "person_id": person_id,
        "fp": password_fp,
        "iat": int(now.timestamp()),
        "exp": int(
            (
                now
                + timedelta(minutes=settings.password_reset_ttl_minutes)
            ).timestamp()
        ),
    }
    return jwt.encode(
        payload, settings.jwt_secret, algorithm=settings.jwt_algorithm
    )


def decode_password_reset_token(token: str) -> dict[str, Any]:
    payload = jwt.decode(
        token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
    )
    if payload.get("kind") != "password_reset":
        raise jwt.InvalidTokenError("Not a password-reset token")
    if not payload.get("person_id") or not payload.get("fp"):
        raise jwt.InvalidTokenError("Malformed password-reset token")
    return payload


def password_fingerprint(hashed_password: str) -> str:
    """Short stable derivative of the current password hash. Embedded
    in password-reset tokens so a single reset link can be used only
    once: the next reset rotates the hash, the fingerprint changes,
    and any in-flight link from the previous request becomes invalid.

    We hash the bcrypt string (not the cleartext password — we don't
    have it) with SHA-256 and keep the first 16 hex chars (64 bits).
    Bcrypt strings contain a random salt so distinct passwords yield
    distinct fingerprints; the truncation is safe because we only
    compare server-side as an equality check, not as a security
    primitive."""
    import hashlib

    return hashlib.sha256(hashed_password.encode("utf-8")).hexdigest()[:16]

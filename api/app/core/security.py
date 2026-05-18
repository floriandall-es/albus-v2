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

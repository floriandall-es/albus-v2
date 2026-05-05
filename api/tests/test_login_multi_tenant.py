"""Multi-tenant login picker flow.

Login no longer accepts a tenant_slug. With 1 membership, /api/login returns
a JWT directly. With 2+, it returns a short-lived pre_auth_token plus a list
of available tenants; the caller exchanges {pre_auth_token, tenant_id} via
/api/login/select-tenant for the real JWT.

These tests pin the security-critical edges:
- pre_auth_token cannot be used as a bearer token
- pre_auth_token can only be redeemed for tenants the person belongs to
- expired/invalid pre_auth_tokens are rejected
"""
import time
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.core.config import settings


def _signup(client, name: str, email: str, password: str = "supersecret1") -> dict:
    r = client.post(
        "/api/signup",
        json={
            "tenant_name": name,
            "person_name": "User",
            "email": email,
            "password": password,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _invite_and_accept(client, headers, email: str, person_name: str, password: str | None = None):
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": email, "person_name": person_name},
    )
    assert r.status_code == 201, r.text
    accept_url = r.json()["accept_url"]
    token = accept_url.rsplit("/", 1)[-1]
    # The accept endpoint requires a password field even for existing
    # persons (where it's ignored — see test_existing_person_new_tenant_keeps_password).
    body = {"password": password or "ignored-existing-user"}
    r = client.post(f"/api/invitations/by-token/{token}/accept", json=body)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def two_membership_user(client):
    """Create Alice with admin memberships in two tenants. Returns (email,
    password, [tenant_a_id, tenant_b_id])."""
    suffix = uuid.uuid4().hex[:6]
    email = f"alice-{suffix}@example.com"
    password = "supersecret1"

    # Tenant A — Alice signs up.
    a = _signup(client, f"Hospital A {suffix}", email, password)
    a_token = a["access_token"]
    tenant_a_id = a["tenant"]["id"]

    # Tenant B — different admin signs up, then invites Alice.
    other_email = f"bob-{suffix}@example.com"
    b = _signup(client, f"Hospital B {suffix}", other_email, password)
    b_headers = {"Authorization": f"Bearer {b['access_token']}"}
    tenant_b_id = b["tenant"]["id"]

    # Bob invites Alice; Alice accepts. The accept flow leaves her existing
    # password intact for existing persons.
    _invite_and_accept(client, b_headers, email, "Alice (in B)")

    return email, password, [tenant_a_id, tenant_b_id], a_token


def test_single_membership_returns_access_token(client):
    suffix = uuid.uuid4().hex[:6]
    email = f"solo-{suffix}@example.com"
    _signup(client, f"Hospital Solo {suffix}", email)

    r = client.post("/api/login", json={"email": email, "password": "supersecret1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "access_token" in body
    assert body.get("requires_tenant_selection") is None or body.get("requires_tenant_selection") is False
    assert body["tenant"]["id"]


def test_zero_memberships_returns_401(client, db_url):
    """A Person row with no memberships at all (rare — could happen if all
    memberships were removed) should not be able to log in."""
    suffix = uuid.uuid4().hex[:6]
    email = f"orphan-{suffix}@example.com"
    body = _signup(client, f"Hospital Orphan {suffix}", email)

    # Strip the membership directly via the migrations role to simulate.
    from sqlalchemy import create_engine, text as _text

    engine = create_engine(db_url, future=True)
    with engine.begin() as conn:
        conn.execute(_text("DELETE FROM memberships WHERE person_id = :p"),
                     {"p": body["person"]["id"]})
    engine.dispose()

    r = client.post("/api/login", json={"email": email, "password": "supersecret1"})
    assert r.status_code == 401


def test_two_memberships_returns_picker(client, two_membership_user):
    email, password, tenant_ids, _ = two_membership_user
    r = client.post("/api/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("requires_tenant_selection") is True
    assert body["pre_auth_token"]
    returned_ids = {t["id"] for t in body["available_tenants"]}
    assert returned_ids == set(tenant_ids)
    # No JWT issued yet.
    assert "access_token" not in body


def test_select_tenant_exchanges_pre_auth_for_jwt(client, two_membership_user):
    email, password, tenant_ids, _ = two_membership_user
    r = client.post("/api/login", json={"email": email, "password": password})
    pre_auth = r.json()["pre_auth_token"]
    target = tenant_ids[0]

    r = client.post(
        "/api/login/select-tenant",
        json={"pre_auth_token": pre_auth, "tenant_id": target},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["tenant"]["id"] == target

    # Real access token works against /api/me.
    r = client.get("/api/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert r.status_code == 200


def test_select_tenant_rejects_non_member(client, two_membership_user):
    email, password, tenant_ids, _ = two_membership_user
    r = client.post("/api/login", json={"email": email, "password": password})
    pre_auth = r.json()["pre_auth_token"]

    # Sign up an unrelated tenant Alice isn't a member of.
    unrelated = _signup(client, f"Hospital Otro {uuid.uuid4().hex[:6]}",
                        f"other-{uuid.uuid4().hex[:6]}@example.com")
    unrelated_id = unrelated["tenant"]["id"]
    assert unrelated_id not in tenant_ids

    r = client.post(
        "/api/login/select-tenant",
        json={"pre_auth_token": pre_auth, "tenant_id": unrelated_id},
    )
    assert r.status_code == 403


def test_select_tenant_rejects_expired_pre_auth(client, two_membership_user):
    email, _, tenant_ids, _ = two_membership_user
    # Forge an already-expired pre-auth token signed with the same secret.
    person_id = client.post(
        "/api/login",
        json={"email": email, "password": "supersecret1"},
    ).json()
    # We don't have person_id directly here; decode the live pre_auth_token.
    live = client.post(
        "/api/login",
        json={"email": email, "password": "supersecret1"},
    ).json()["pre_auth_token"]
    payload = jwt.decode(live, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

    expired_payload = {
        "kind": "pre_auth",
        "person_id": payload["person_id"],
        "iat": int((datetime.now(timezone.utc) - timedelta(hours=2)).timestamp()),
        "exp": int((datetime.now(timezone.utc) - timedelta(hours=1)).timestamp()),
    }
    expired_token = jwt.encode(expired_payload, settings.jwt_secret,
                               algorithm=settings.jwt_algorithm)

    r = client.post(
        "/api/login/select-tenant",
        json={"pre_auth_token": expired_token, "tenant_id": tenant_ids[0]},
    )
    assert r.status_code == 401


def test_pre_auth_token_cannot_be_used_as_access_token(client, two_membership_user):
    email, password, _, _ = two_membership_user
    r = client.post("/api/login", json={"email": email, "password": password})
    pre_auth = r.json()["pre_auth_token"]

    # Try to use it directly against a protected endpoint — must be rejected.
    r = client.get("/api/me", headers={"Authorization": f"Bearer {pre_auth}"})
    assert r.status_code == 401


def test_select_tenant_rejects_garbage_token(client, two_membership_user):
    _, _, tenant_ids, _ = two_membership_user
    r = client.post(
        "/api/login/select-tenant",
        json={"pre_auth_token": "not-a-jwt", "tenant_id": tenant_ids[0]},
    )
    assert r.status_code == 401


def test_select_tenant_rejects_real_access_token(client, two_membership_user):
    """A regular access token must not be accepted in place of a pre_auth
    token — kind=access ≠ kind=pre_auth."""
    _, _, tenant_ids, access_token = two_membership_user
    r = client.post(
        "/api/login/select-tenant",
        json={"pre_auth_token": access_token, "tenant_id": tenant_ids[0]},
    )
    assert r.status_code == 401

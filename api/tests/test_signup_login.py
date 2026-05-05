import re


def test_signup_login_me_flow(client, unique_email):
    r = client.post(
        "/api/signup",
        json={
            "tenant_name": "Hospital General Test",
            "person_name": "Alice Admin",
            "email": unique_email,
            "password": "supersecret1",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["access_token"]
    # Slug is server-generated from the tenant name. Allow optional collision
    # suffix because parallel test runs may have created the same slug already.
    assert re.match(r"^hospital-general-test(-\d+|-[0-9a-f]{6})?$", body["tenant"]["slug"])
    assert body["person"]["email"] == unique_email
    assert len(body["memberships"]) == 1
    assert "admin" in body["memberships"][0]["roles"]

    # Login with email + password only — single membership, JWT issued directly.
    r = client.post(
        "/api/login",
        json={"email": unique_email, "password": "supersecret1"},
    )
    assert r.status_code == 200, r.text
    login_body = r.json()
    token = login_body["access_token"]
    assert token
    assert login_body["tenant"]["slug"] == body["tenant"]["slug"]

    # /me with bearer token
    r = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["person"]["email"] == unique_email
    assert me["current_tenant"]["slug"] == body["tenant"]["slug"]
    # Person sees their membership through RLS
    assert len(me["memberships"]) == 1
    assert me["role_types"] == []
    assert me["departments"] == []


def test_login_wrong_password(client, unique_email):
    client.post(
        "/api/signup",
        json={
            "tenant_name": "Hospital Wrong-Pass",
            "person_name": "X",
            "email": unique_email,
            "password": "supersecret1",
        },
    )
    r = client.post(
        "/api/login",
        json={"email": unique_email, "password": "wrong-password"},
    )
    assert r.status_code == 401


def test_me_without_token(client):
    r = client.get("/api/me")
    assert r.status_code == 401


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}

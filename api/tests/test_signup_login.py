def test_signup_login_me_flow(client, unique_slug, unique_email):
    r = client.post(
        "/api/signup",
        json={
            "tenant_name": "Hospital General",
            "tenant_slug": unique_slug,
            "person_name": "Alice Admin",
            "email": unique_email,
            "password": "supersecret1",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["access_token"]
    assert body["tenant"]["slug"] == unique_slug
    assert body["person"]["email"] == unique_email
    assert len(body["memberships"]) == 1
    assert "admin" in body["memberships"][0]["roles"]

    # Login with the same credentials
    r = client.post(
        "/api/login",
        json={
            "email": unique_email,
            "password": "supersecret1",
            "tenant_slug": unique_slug,
        },
    )
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    assert token

    # /me with bearer token
    r = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["person"]["email"] == unique_email
    assert me["current_tenant"]["slug"] == unique_slug
    # Person sees their membership through RLS
    assert len(me["memberships"]) == 1
    assert me["role_types"] == []
    assert me["departments"] == []


def test_login_wrong_password(client, unique_slug, unique_email):
    client.post(
        "/api/signup",
        json={
            "tenant_name": "X",
            "tenant_slug": unique_slug,
            "person_name": "X",
            "email": unique_email,
            "password": "supersecret1",
        },
    )
    r = client.post(
        "/api/login",
        json={"email": unique_email, "password": "wrong-password", "tenant_slug": unique_slug},
    )
    assert r.status_code == 401


def test_me_without_token(client):
    r = client.get("/api/me")
    assert r.status_code == 401


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}

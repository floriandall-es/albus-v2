import re


def test_signup_login_me_flow(client, unique_email, cnh_hospital):
    r = client.post(
        "/api/signup",
        json={
            "first_name": "Alice",
            "last_name": "Admin",
            "email": unique_email,
            "password": "supersecret1",
            "accept_terms": True,
            "hospital_id": cnh_hospital,
            "servicio_name": "Cardiología Test",
            "equipo_name": "Equipo General Test",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["access_token"]
    # Slug is server-generated (Phase D.2: derived from equipo + servicio,
    # with a uniqueness suffix). Assert it's a well-formed slug rather than
    # a specific value — the exact derivation is covered in
    # test_signup_slug_generation.
    assert re.match(r"^[a-z0-9-]+$", body["tenant"]["slug"])
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


def test_login_wrong_password(client, unique_email, cnh_hospital):
    suffix = unique_email.split("@")[0]
    client.post(
        "/api/signup",
        json={
            "first_name": "X",
            "email": unique_email,
            "password": "supersecret1",
            "accept_terms": True,
            "hospital_id": cnh_hospital,
            "servicio_name": f"Servicio {suffix}",
            "equipo_name": f"Equipo {suffix}",
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

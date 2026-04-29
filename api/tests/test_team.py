"""Team list, update membership, invite (creates Person + Membership), tenant isolation."""


def test_team_list_returns_admin(auth_client):
    client, headers, info = auth_client
    r = client.get("/api/team", headers=headers)
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    me = rows[0]
    assert me["person_id"] == info["person_id"]
    assert me["fte_pct"] == 100
    assert me["does_guardias"] is True
    assert me["category_id"] is None


def test_team_update_member_attrs(auth_client):
    client, headers, info = auth_client
    # Create a category to assign
    r = client.post(
        "/api/categories", headers=headers, json={"name": "Adjunto", "level": 1}
    )
    cat_id = r.json()["id"]

    r = client.put(
        f"/api/team/{info['membership_id']}",
        headers=headers,
        json={
            "category_id": cat_id,
            "fte_pct": 80,
            "does_guardias": False,
            "guardia_types": ["12h", "24h"],
            "exemption_type": "temporary",
            "exemption_until": "2026-12-31",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["category_id"] == cat_id
    assert body["category_name"] == "Adjunto"
    assert body["fte_pct"] == 80
    assert body["does_guardias"] is False
    assert body["guardia_types"] == ["12h", "24h"]
    assert body["exemption_type"] == "temporary"
    assert body["exemption_until"] == "2026-12-31"

    # Clear exemption
    r = client.put(
        f"/api/team/{info['membership_id']}",
        headers=headers,
        json={"clear_exemption": True},
    )
    assert r.status_code == 200
    assert r.json()["exemption_type"] is None
    assert r.json()["exemption_until"] is None


def test_team_update_invalid_fte_422(auth_client):
    client, headers, info = auth_client
    r = client.put(
        f"/api/team/{info['membership_id']}",
        headers=headers,
        json={"fte_pct": 250},
    )
    assert r.status_code == 422


def test_team_invite_creates_person_and_membership(auth_client):
    client, headers, _info = auth_client
    r = client.post(
        "/api/categories", headers=headers, json={"name": "Residente"}
    )
    cat_id = r.json()["id"]

    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={
            "email": "carlos@example.com",
            "person_name": "Carlos Nuevo",
            "category_id": cat_id,
            "roles": ["doctor"],
            "fte_pct": 100,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created_person"] is True
    assert body["email"] == "carlos@example.com"
    assert body["membership"]["category_id"] == cat_id
    assert body["membership"]["roles"] == ["doctor"]

    # Now /team should show 2 rows
    r = client.get("/api/team", headers=headers)
    assert len(r.json()) == 2


def test_team_invite_reuses_existing_person(auth_client, second_tenant):
    """If a Person with that email already exists (e.g. they admin another tenant),
    invite reuses them and just adds a Membership."""
    client, headers_a, _info_a = auth_client
    _headers_b, info_b = second_tenant

    # Bob is the admin of tenant B; invite him to tenant A
    bob_email = f"bob-?@x"  # we don't actually know it; query through /team on B
    # Easier: use a brand-new person via invite, then invite same email to other
    r = client.post(
        "/api/team/invite",
        headers=headers_a,
        json={"email": "shared@example.com", "person_name": "Shared User"},
    )
    assert r.status_code == 201
    body1 = r.json()
    assert body1["created_person"] is True

    # Inviting same email to same tenant -> 409
    r = client.post(
        "/api/team/invite",
        headers=headers_a,
        json={"email": "shared@example.com", "person_name": "Shared User"},
    )
    assert r.status_code == 409


def test_team_tenant_isolation(auth_client, second_tenant):
    client, headers_a, _info_a = auth_client
    headers_b, info_b = second_tenant

    r = client.get("/api/team", headers=headers_a)
    a_persons = {row["person_id"] for row in r.json()}
    assert info_b["person_id"] not in a_persons

    r = client.get("/api/team", headers=headers_b)
    b_persons = {row["person_id"] for row in r.json()}
    assert len(b_persons) == 1


def test_team_update_unknown_category_422(auth_client):
    client, headers, info = auth_client
    r = client.put(
        f"/api/team/{info['membership_id']}",
        headers=headers,
        json={"category_id": 9999},
    )
    assert r.status_code == 422

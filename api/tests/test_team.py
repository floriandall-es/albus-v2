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
    assert me["category_id"] is None


def test_team_update_member_attrs(auth_client):
    client, headers, info = auth_client
    # Create a category to assign
    r = client.post(
        "/api/categories", headers=headers, json={"name": "Adjunto", "level": 1}
    )
    cat_id = r.json()["id"]

    # Guardia-type + exemption fields were removed from the membership
    # model in the equipos redesign; the updatable attrs are now
    # category_id, fte_pct, roles, disabled, allowed_slot_ids, email.
    r = client.put(
        f"/api/team/{info['membership_id']}",
        headers=headers,
        json={
            "category_id": cat_id,
            "fte_pct": 80,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["category_id"] == cat_id
    assert body["category_name"] == "Adjunto"
    assert body["fte_pct"] == 80


def test_team_update_invalid_fte_422(auth_client):
    client, headers, info = auth_client
    r = client.put(
        f"/api/team/{info['membership_id']}",
        headers=headers,
        json={"fte_pct": 250},
    )
    assert r.status_code == 422


def test_team_invite_creates_invitation(auth_client):
    """Invite contract: returns invitation_id + accept_url AND creates a
    *pending* Person + Membership immediately (migration 0059), so the
    invitee shows on /team right away with is_pending=True (they activate
    later via the accept link). Full accept-flow is covered in
    test_invitations.py — here we sanity-check the response shape and the
    pending row."""
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
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "carlos@example.com"
    assert "invitation_id" in body
    assert body["accept_url"].startswith("http")
    assert "/invite/" in body["accept_url"]

    # The invitee now appears immediately as a pending member
    # (admin + Carlos = 2). Carlos is is_pending until he activates.
    r = client.get("/api/team", headers=headers)
    rows = r.json()
    assert len(rows) == 2
    carlos = next(m for m in rows if m["person_email"] == "carlos@example.com")
    assert carlos["is_pending"] is True


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

"""Token-based invitation flow."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, text

from app.core.config import settings


def _token_from_url(url: str) -> str:
    return url.rsplit("/", 1)[-1]


def test_full_invite_accept_flow(auth_client, client):
    _client_a, headers, _info = auth_client

    r = client.post("/api/categories", headers=headers, json={"name": "Adjunto"})
    cat_id = r.json()["id"]

    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={
            "email": "carlos@example.com",
            "person_name": "Carlos",
            "category_id": cat_id,
            "roles": ["doctor", "member"],
        },
    )
    assert r.status_code == 201, r.text
    accept_url = r.json()["accept_url"]
    token = _token_from_url(accept_url)

    # Public preview works
    r = client.get(f"/api/invitations/by-token/{token}")
    assert r.status_code == 200
    pv = r.json()
    assert pv["email"] == "carlos@example.com"
    assert pv["person_name"] == "Carlos"

    # Accept with a chosen password
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "carloss3cret", "person_name": "Carlos Pérez"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    assert body["person"]["email"] == "carlos@example.com"
    assert body["person"]["name"] == "Carlos Pérez"
    assert body["memberships"][0]["roles"] == ["doctor", "member"]
    assert body["memberships"][0]["category_id"] == cat_id

    # Token cannot be reused
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "anothersecret"},
    )
    assert r.status_code == 400

    # Carlos can log in directly. Carlos has only one membership so login
    # returns a JWT immediately without going through the tenant picker.
    r = client.post(
        "/api/login",
        json={
            "email": "carlos@example.com",
            "password": "carloss3cret",
        },
    )
    assert r.status_code == 200, r.text
    assert "access_token" in r.json()


def _info_slug(info):
    return info["tenant_slug"]


def test_token_tampering_returns_404(auth_client, client):
    _client, headers, _info = auth_client
    client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "real@example.com", "person_name": "Real"},
    )
    r = client.get("/api/invitations/by-token/totally-bogus-token")
    assert r.status_code == 404


def test_expired_invitation_rejected(auth_client, client):
    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "soonexpired@example.com", "person_name": "Soon"},
    )
    accept_url = r.json()["accept_url"]
    token = _token_from_url(accept_url)
    inv_id = r.json()["invitation_id"]

    # Expire it directly via SQL
    eng = create_engine(settings.database_url, future=True)
    with eng.begin() as conn:
        conn.execute(
            text("UPDATE invitations SET expires_at = :t WHERE id = :i"),
            {"t": datetime.now(timezone.utc) - timedelta(minutes=1), "i": inv_id},
        )
    eng.dispose()

    r = client.get(f"/api/invitations/by-token/{token}")
    assert r.status_code == 404
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "somepassword"},
    )
    assert r.status_code == 400


def test_revoked_invitation_rejected(auth_client, client):
    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "revokeme@example.com", "person_name": "R"},
    )
    accept_url = r.json()["accept_url"]
    token = _token_from_url(accept_url)
    inv_id = r.json()["invitation_id"]

    # Admin revokes
    r = client.post(f"/api/invitations/{inv_id}/revoke", headers=headers)
    assert r.status_code == 200
    assert r.json()["revoked_at"] is not None

    r = client.get(f"/api/invitations/by-token/{token}")
    assert r.status_code == 404


def test_reinviting_revokes_previous(auth_client, client):
    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "again@example.com", "person_name": "A"},
    )
    token1 = _token_from_url(r.json()["accept_url"])

    r2 = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "again@example.com", "person_name": "A"},
    )
    assert r2.status_code == 201
    token2 = _token_from_url(r2.json()["accept_url"])
    assert token1 != token2

    # Old one no longer resolves
    r = client.get(f"/api/invitations/by-token/{token1}")
    assert r.status_code == 404
    # New one does
    r = client.get(f"/api/invitations/by-token/{token2}")
    assert r.status_code == 200


def test_existing_person_new_tenant_keeps_password(auth_client, second_tenant, client):
    """Bob admins tenant B. A invites Bob; Bob accepts; his existing password
    must still work for tenant B."""
    _client, headers_a, _info_a = auth_client
    _headers_b, info_b = second_tenant

    bob_email = None
    # Find Bob's email by listing team B (we need headers_b, but second_tenant
    # only returns it as the first tuple element — recover from the fixture).
    # second_tenant returns (headers, info); reconstruct.
    import json as _json
    _headers_b_actual = _headers_b
    r = client.get("/api/team", headers=_headers_b_actual)
    assert r.status_code == 200
    bob_email = r.json()[0]["person_email"]

    r = client.post(
        "/api/team/invite",
        headers=headers_a,
        json={"email": bob_email, "person_name": "Bob (in A)"},
    )
    assert r.status_code == 201
    token = _token_from_url(r.json()["accept_url"])

    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "ignored-password-because-existing-user"},
    )
    assert r.status_code == 200
    body = r.json()
    # Bob's name should NOT be overwritten on his existing Person.
    assert body["person"]["email"] == bob_email

    # Bob's original password (set via signup in second_tenant fixture) still
    # works. He now has 2 memberships (B from signup, A from accepting the
    # invite), so login returns the tenant picker payload — not a JWT.
    r = client.post(
        "/api/login",
        json={
            "email": bob_email,
            "password": "supersecret1",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("requires_tenant_selection") is True
    tenant_ids = {t["id"] for t in body["available_tenants"]}
    assert info_b["tenant_id"] in tenant_ids


def test_invite_existing_member_409(auth_client, client):
    _client, headers, info = auth_client
    # Admin's own email -> already a member
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": info["email"], "person_name": "Admin"},
    )
    assert r.status_code == 409


def test_invitations_list_isolated(auth_client, second_tenant, client):
    _client, headers_a, _info = auth_client
    headers_b, _ = second_tenant

    client.post(
        "/api/team/invite",
        headers=headers_a,
        json={"email": "x-a@example.com", "person_name": "X"},
    )
    client.post(
        "/api/team/invite",
        headers=headers_b,
        json={"email": "x-b@example.com", "person_name": "X"},
    )

    r = client.get("/api/invitations", headers=headers_a)
    emails_a = {i["email"] for i in r.json()}
    assert "x-a@example.com" in emails_a
    assert "x-b@example.com" not in emails_a

    r = client.get("/api/invitations", headers=headers_b)
    emails_b = {i["email"] for i in r.json()}
    assert "x-b@example.com" in emails_b
    assert "x-a@example.com" not in emails_b


def test_non_admin_cannot_invite(auth_client, client):
    """Demote (or rather: invite a non-admin and try to invite from there)."""
    _client, headers, _info = auth_client
    # Invite a 'member' role user, accept, then try to invite from that token.
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "regular@example.com", "person_name": "Reg", "roles": ["member"]},
    )
    token = _token_from_url(r.json()["accept_url"])
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "regularpass1"},
    )
    member_token = r.json()["access_token"]

    r = client.post(
        "/api/team/invite",
        headers={"Authorization": f"Bearer {member_token}"},
        json={"email": "another@example.com", "person_name": "X"},
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Email + reissue (Sprint 4 part A)
# ---------------------------------------------------------------------------


def test_invitation_creation_triggers_email(auth_client, client, monkeypatch):
    sent: list[dict] = []

    def fake_send(to, subject, body_text, body_html=None):
        sent.append({"to": to, "subject": subject, "body": body_text})

    monkeypatch.setattr("app.services.invitations.send_email", fake_send)

    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "mail-me@example.com", "person_name": "Mail Me"},
    )
    assert r.status_code == 201
    accept_url = r.json()["accept_url"]

    assert len(sent) == 1
    assert sent[0]["to"] == "mail-me@example.com"
    assert "Mail Me" in sent[0]["body"]
    assert accept_url in sent[0]["body"]


def test_email_failure_does_not_break_invite(auth_client, client, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError("smtp down")

    monkeypatch.setattr("app.services.invitations.send_email", boom)

    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "robust@example.com", "person_name": "R"},
    )
    assert r.status_code == 201, r.text


def test_reissue_replaces_token_and_sends_new_email(auth_client, client, monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(
        "app.services.invitations.send_email",
        lambda to, subject, body_text, body_html=None: sent.append(
            {"to": to, "subject": subject, "body": body_text}
        ),
    )

    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "again2@example.com", "person_name": "A"},
    )
    assert r.status_code == 201
    inv_id = r.json()["invitation_id"]
    old_url = r.json()["accept_url"]

    r = client.post(f"/api/invitations/{inv_id}/reissue", headers=headers)
    assert r.status_code == 200, r.text
    new_url = r.json()["accept_url"]
    assert new_url != old_url

    old_token = old_url.rsplit("/", 1)[-1]
    new_token = new_url.rsplit("/", 1)[-1]
    assert client.get(f"/api/invitations/by-token/{old_token}").status_code == 404
    assert client.get(f"/api/invitations/by-token/{new_token}").status_code == 200

    assert len(sent) == 2
    assert sent[-1]["to"] == "again2@example.com"


def test_reissue_rejects_accepted(auth_client, client):
    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "done@example.com", "person_name": "D"},
    )
    inv_id = r.json()["invitation_id"]
    token = r.json()["accept_url"].rsplit("/", 1)[-1]

    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "donesecret1"},
    )
    assert r.status_code == 200

    r = client.post(f"/api/invitations/{inv_id}/reissue", headers=headers)
    assert r.status_code == 400


def test_reissue_requires_admin(auth_client, client):
    _client, headers, _info = auth_client
    # Onboard a non-admin via an invite.
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "regular2@example.com", "person_name": "R", "roles": ["member"]},
    )
    member_token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{member_token}/accept",
        json={"password": "regular12"},
    )
    member_jwt = r.json()["access_token"]

    # Create another invite to target.
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "target@example.com", "person_name": "T"},
    )
    target_inv = r.json()["invitation_id"]

    r = client.post(
        f"/api/invitations/{target_inv}/reissue",
        headers={"Authorization": f"Bearer {member_jwt}"},
    )
    assert r.status_code == 403


def test_reissue_tenant_isolation(auth_client, second_tenant, client):
    _client, headers_a, _info_a = auth_client
    headers_b, _info_b = second_tenant

    r = client.post(
        "/api/team/invite",
        headers=headers_a,
        json={"email": "iso-a@example.com", "person_name": "X"},
    )
    inv_id = r.json()["invitation_id"]

    r = client.post(f"/api/invitations/{inv_id}/reissue", headers=headers_b)
    assert r.status_code == 404

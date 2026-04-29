"""Onboarding completion endpoint."""


def test_complete_marks_tenant(auth_client):
    client, headers, _info = auth_client
    # Initial state: not completed
    r = client.get("/api/me", headers=headers)
    assert r.status_code == 200
    assert r.json()["current_tenant"]["onboarding_completed_at"] is None

    r = client.post("/api/onboarding/complete", headers=headers)
    assert r.status_code == 200
    first = r.json()["onboarding_completed_at"]
    assert first is not None

    # /me reflects the change
    r = client.get("/api/me", headers=headers)
    assert r.json()["current_tenant"]["onboarding_completed_at"] == first


def test_complete_idempotent(auth_client):
    """Second call returns the same timestamp — admins double-clicking the
    Terminar button shouldn't reset 'when did onboarding actually finish'."""
    client, headers, _info = auth_client
    r1 = client.post("/api/onboarding/complete", headers=headers)
    assert r1.status_code == 200
    ts1 = r1.json()["onboarding_completed_at"]

    r2 = client.post("/api/onboarding/complete", headers=headers)
    assert r2.status_code == 200
    assert r2.json()["onboarding_completed_at"] == ts1


def test_complete_requires_admin(auth_client, client):
    """Invite a member-role user, accept, then try to complete onboarding."""
    _client, headers, _info = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "regular@example.com", "person_name": "Reg", "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "regularpw1"},
    )
    member_token = r.json()["access_token"]

    r = client.post(
        "/api/onboarding/complete",
        headers={"Authorization": f"Bearer {member_token}"},
    )
    assert r.status_code == 403

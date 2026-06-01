"""Schedules API: list / detail / publish / archive / delete, admin-only,
tenant isolation, status transitions."""

from __future__ import annotations


def _onboard_member(client, headers, email):
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": email, "person_name": "X", "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"accept_terms": True, "password": "memberpass"},
    )
    return r.json()["access_token"]


def _slot(client, headers):
    client.post(
        "/api/slots",
        headers=headers,
        json={
            "name": "Día",
            "days_applied": "weekdays",
            "staffing_mode": "single",
            "headcount": 1,
            "post_slot_rest": False,
            "counts_for_equity": True,
            "team_roles": [],
            "skills_required": [],
        },
    )


def test_list_and_detail(auth_client, client):
    _client, headers, _info = auth_client
    _slot(client, headers)
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    sid = r.json()["id"]

    r = client.get("/api/schedules", headers=headers)
    assert r.status_code == 200
    assert any(s["id"] == sid for s in r.json())

    r = client.get(f"/api/schedules/{sid}", headers=headers)
    assert r.status_code == 200
    assert r.json()["id"] == sid
    assert "assignments" in r.json()


def test_archive_then_regenerate(auth_client, client):
    _client, headers, _info = auth_client
    _slot(client, headers)
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    sid = r.json()["id"]
    r = client.post(f"/api/schedules/{sid}/publish", headers=headers)
    assert r.status_code == 200

    r = client.post(f"/api/schedules/{sid}/archive", headers=headers)
    assert r.status_code == 200
    assert r.json()["status"] == "archived"

    # After archive, regenerate is allowed (replaces the archived).
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    assert r.status_code == 201


def test_delete_only_draft(auth_client, client):
    _client, headers, _info = auth_client
    _slot(client, headers)
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    sid = r.json()["id"]
    r = client.delete(f"/api/schedules/{sid}", headers=headers)
    assert r.status_code == 204

    # Recreate + publish, then delete must fail.
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    sid = r.json()["id"]
    client.post(f"/api/schedules/{sid}/publish", headers=headers)
    r = client.delete(f"/api/schedules/{sid}", headers=headers)
    assert r.status_code == 400


def test_admin_required_for_writes(auth_client, client):
    _client, headers, _info = auth_client
    _slot(client, headers)
    member_jwt = _onboard_member(client, headers, "memX@example.com")
    member_headers = {"Authorization": f"Bearer {member_jwt}"}

    r = client.post(
        "/api/schedules/generate",
        headers=member_headers,
        json={"period": "2026-05-01"},
    )
    assert r.status_code == 403


def test_schedules_tenant_isolation(auth_client, second_tenant, client):
    _client, headers_a, _info_a = auth_client
    headers_b, _info_b = second_tenant

    _slot(client, headers_a)
    _slot(client, headers_b)
    r = client.post(
        "/api/schedules/generate",
        headers=headers_a,
        json={"period": "2026-05-01"},
    )
    sid_a = r.json()["id"]
    client.post(
        "/api/schedules/generate",
        headers=headers_b,
        json={"period": "2026-05-01"},
    )

    r = client.get("/api/schedules", headers=headers_a)
    a_ids = {s["id"] for s in r.json()}
    assert sid_a in a_ids
    r = client.get(f"/api/schedules/{sid_a}", headers=headers_b)
    assert r.status_code == 404

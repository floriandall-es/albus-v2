"""Availability blocks: CRUD, validations, tenant isolation."""

from __future__ import annotations


def _invite_member(client, headers, email, name="Member") -> int:
    """Returns person_id of an accepted invite."""
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": email, "person_name": name, "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "membermember"},
    )
    return r.json()["person"]["id"]


def test_availability_crud_round_trip(auth_client, client):
    _client, headers, _info = auth_client
    pid = _invite_member(client, headers, "av1@example.com", "Av One")

    r = client.get("/api/availability-blocks", headers=headers)
    assert r.json() == []

    r = client.post(
        "/api/availability-blocks",
        headers=headers,
        json={
            "person_id": pid,
            "start_date": "2026-05-04",
            "end_date": "2026-05-08",
            "block_type": "vacation",
            "notes": "Puente de mayo",
        },
    )
    assert r.status_code == 201, r.text
    bid = r.json()["id"]
    assert r.json()["person_name"] == "Av One"

    # Filter
    r = client.get(
        "/api/availability-blocks?from=2026-05-01&to=2026-05-31",
        headers=headers,
    )
    assert len(r.json()) == 1
    r = client.get(
        "/api/availability-blocks?from=2026-06-01&to=2026-06-30",
        headers=headers,
    )
    assert r.json() == []

    # Update
    r = client.put(
        f"/api/availability-blocks/{bid}",
        headers=headers,
        json={
            "person_id": pid,
            "start_date": "2026-05-04",
            "end_date": "2026-05-10",
            "block_type": "training",
            "notes": "Curso ATLS",
        },
    )
    assert r.status_code == 200
    assert r.json()["block_type"] == "training"

    # Delete
    r = client.delete(f"/api/availability-blocks/{bid}", headers=headers)
    assert r.status_code == 204
    r = client.get("/api/availability-blocks", headers=headers)
    assert r.json() == []


def test_end_before_start_rejected(auth_client, client):
    _client, headers, _info = auth_client
    pid = _invite_member(client, headers, "av2@example.com")
    r = client.post(
        "/api/availability-blocks",
        headers=headers,
        json={
            "person_id": pid,
            "start_date": "2026-05-10",
            "end_date": "2026-05-05",
            "block_type": "vacation",
        },
    )
    assert r.status_code == 422


def test_cross_tenant_person_rejected(auth_client, second_tenant, client):
    _client, headers_a, info_a = auth_client
    _headers_b, info_b = second_tenant

    # Try to block tenant B's admin from tenant A.
    r = client.post(
        "/api/availability-blocks",
        headers=headers_a,
        json={
            "person_id": info_b["person_id"],
            "start_date": "2026-05-04",
            "end_date": "2026-05-05",
            "block_type": "vacation",
        },
    )
    assert r.status_code == 422


def test_availability_tenant_isolation(auth_client, second_tenant, client):
    _client, headers_a, info_a = auth_client
    headers_b, _info_b = second_tenant

    pid_a = _invite_member(client, headers_a, "iso-a@example.com")

    client.post(
        "/api/availability-blocks",
        headers=headers_a,
        json={
            "person_id": pid_a,
            "start_date": "2026-05-04",
            "end_date": "2026-05-05",
            "block_type": "vacation",
        },
    )
    r = client.get("/api/availability-blocks", headers=headers_a)
    assert len(r.json()) == 1
    r = client.get("/api/availability-blocks", headers=headers_b)
    assert r.json() == []


def test_availability_admin_required(auth_client, client):
    _client, headers, _info = auth_client
    pid = _invite_member(client, headers, "av-mem@example.com")
    # Onboard a regular member and try to write.
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "regav@example.com", "person_name": "R", "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "regav1234"},
    )
    member_jwt = r.json()["access_token"]
    member_headers = {"Authorization": f"Bearer {member_jwt}"}

    r = client.post(
        "/api/availability-blocks",
        headers=member_headers,
        json={
            "person_id": pid,
            "start_date": "2026-05-04",
            "end_date": "2026-05-05",
            "block_type": "vacation",
        },
    )
    assert r.status_code == 403

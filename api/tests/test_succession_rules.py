"""CRUD + tenant-isolation tests for slot-succession-rules."""

from __future__ import annotations


def _create_slot(client, headers, name="A"):
    r = client.post(
        "/api/slots",
        headers=headers,
        json={
            "name": name,
            "days_applied": "weekdays",
            "staffing_mode": "single",
            "headcount": 1,
            "post_slot_rest": False,
            "counts_for_equity": True,
            "team_roles": [],
            "skills_required": [],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_create_list_update_delete(auth_client, client):
    _, headers, _ = auth_client
    a = _create_slot(client, headers, "A")
    b = _create_slot(client, headers, "B")

    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": a["id"],
            "forbid_slot_id": b["id"],
            "days_after": 1,
            "severity": "hard",
        },
    )
    assert r.status_code == 201, r.text
    rule_id = r.json()["id"]
    assert r.json()["applies_to"] == "same_person"
    assert r.json()["weight"] == 5

    # Idempotent: same payload -> 200 with same id.
    r2 = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": a["id"],
            "forbid_slot_id": b["id"],
            "days_after": 1,
            "severity": "hard",
        },
    )
    assert r2.status_code == 200
    assert r2.json()["id"] == rule_id

    r = client.get("/api/slot-succession-rules", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1

    r = client.put(
        f"/api/slot-succession-rules/{rule_id}",
        headers=headers,
        json={"severity": "soft", "weight": 50},
    )
    assert r.status_code == 200
    assert r.json()["severity"] == "soft"
    assert r.json()["weight"] == 50

    r = client.delete(f"/api/slot-succession-rules/{rule_id}", headers=headers)
    assert r.status_code == 204
    r = client.get("/api/slot-succession-rules", headers=headers)
    assert len(r.json()) == 0


def test_whole_team_rejected(auth_client, client):
    _, headers, _ = auth_client
    a = _create_slot(client, headers, "A")
    b = _create_slot(client, headers, "B")
    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": a["id"],
            "forbid_slot_id": b["id"],
            "days_after": 1,
            "applies_to": "whole_team",
        },
    )
    assert r.status_code == 422


def test_self_succession_allowed(auth_client, client):
    """No guardia 3 days after a guardia."""
    _, headers, _ = auth_client
    a = _create_slot(client, headers, "Guardia")
    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": a["id"],
            "forbid_slot_id": a["id"],
            "days_after": 3,
        },
    )
    assert r.status_code == 201


def test_invalid_days_after(auth_client, client):
    _, headers, _ = auth_client
    a = _create_slot(client, headers, "A")
    b = _create_slot(client, headers, "B")
    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": a["id"],
            "forbid_slot_id": b["id"],
            "days_after": 15,
        },
    )
    assert r.status_code == 422


def test_cross_tenant_slot_rejected(auth_client, client, second_tenant):
    _, headers, _ = auth_client
    other_headers, _ = second_tenant
    a_other = _create_slot(client, other_headers, "A")
    b = _create_slot(client, headers, "B")
    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": a_other["id"],
            "forbid_slot_id": b["id"],
            "days_after": 1,
        },
    )
    assert r.status_code == 422


def test_tenant_isolation(auth_client, client, second_tenant):
    _, headers, _ = auth_client
    other_headers, _ = second_tenant
    a = _create_slot(client, headers, "A")
    b = _create_slot(client, headers, "B")
    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={"after_slot_id": a["id"], "forbid_slot_id": b["id"], "days_after": 1},
    )
    assert r.status_code == 201

    r = client.get("/api/slot-succession-rules", headers=other_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_non_admin_forbidden(auth_client, client):
    _, headers, _ = auth_client
    a = _create_slot(client, headers, "A")
    b = _create_slot(client, headers, "B")

    # Invite a non-admin member.
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "m@example.com", "person_name": "M", "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept", json={"password": "memberpass"}
    )
    member_token = r.json()["access_token"]
    member_headers = {"Authorization": f"Bearer {member_token}"}

    r = client.post(
        "/api/slot-succession-rules",
        headers=member_headers,
        json={"after_slot_id": a["id"], "forbid_slot_id": b["id"], "days_after": 1},
    )
    assert r.status_code == 403

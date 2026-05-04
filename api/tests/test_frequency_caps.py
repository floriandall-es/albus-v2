"""CRUD + tenant-isolation tests for slot-frequency-caps."""

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
    s = _create_slot(client, headers)
    r = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={
            "slot_id": s["id"],
            "period": "rolling_7",
            "max_count": 2,
            "severity": "hard",
        },
    )
    assert r.status_code == 201, r.text
    cap_id = r.json()["id"]

    # Idempotent: same (slot_id, period) -> 200 with same id.
    r2 = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={
            "slot_id": s["id"],
            "period": "rolling_7",
            "max_count": 5,
            "severity": "soft",
        },
    )
    assert r2.status_code == 200
    assert r2.json()["id"] == cap_id
    # The idempotent return is the existing row, NOT the new payload.
    assert r2.json()["max_count"] == 2

    r = client.get("/api/slot-frequency-caps", headers=headers)
    assert len(r.json()) == 1

    r = client.put(
        f"/api/slot-frequency-caps/{cap_id}",
        headers=headers,
        json={"max_count": 3, "severity": "soft", "weight": 50},
    )
    assert r.status_code == 200
    assert r.json()["max_count"] == 3
    assert r.json()["severity"] == "soft"

    r = client.delete(f"/api/slot-frequency-caps/{cap_id}", headers=headers)
    assert r.status_code == 204


def test_invalid_period(auth_client, client):
    _, headers, _ = auth_client
    s = _create_slot(client, headers)
    r = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={"slot_id": s["id"], "period": "weekly", "max_count": 1},
    )
    assert r.status_code == 422


def test_negative_max_count(auth_client, client):
    _, headers, _ = auth_client
    s = _create_slot(client, headers)
    r = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={"slot_id": s["id"], "period": "rolling_7", "max_count": -1},
    )
    assert r.status_code == 422


def test_cross_tenant_slot_rejected(auth_client, client, second_tenant):
    _, headers, _ = auth_client
    other_headers, _ = second_tenant
    s_other = _create_slot(client, other_headers, "X")
    r = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={"slot_id": s_other["id"], "period": "rolling_7", "max_count": 1},
    )
    assert r.status_code == 422


def test_tenant_isolation(auth_client, client, second_tenant):
    _, headers, _ = auth_client
    other_headers, _ = second_tenant
    s = _create_slot(client, headers, "A")
    r = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={"slot_id": s["id"], "period": "rolling_7", "max_count": 2},
    )
    assert r.status_code == 201
    r = client.get("/api/slot-frequency-caps", headers=other_headers)
    assert r.json() == []

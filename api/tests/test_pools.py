"""Pools CRUD + member add/remove + tenant isolation."""


def test_pools_crud_and_members(auth_client):
    client, headers, info = auth_client

    # Create pool
    r = client.post(
        "/api/pools",
        headers=headers,
        json={"name": "REA", "membership_mode": "dedicated", "equity_independent": True},
    )
    assert r.status_code == 201, r.text
    pool = r.json()
    pid = pool["id"]
    assert pool["member_count"] == 0

    # Idempotent: duplicate name returns the existing row with 200.
    r = client.post(
        "/api/pools",
        headers=headers,
        json={"name": "REA", "membership_mode": "dedicated", "equity_independent": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["id"] == pid
    # Case-insensitive too.
    r = client.post(
        "/api/pools",
        headers=headers,
        json={"name": "rea", "membership_mode": "dedicated", "equity_independent": True},
    )
    assert r.status_code == 200
    assert r.json()["id"] == pid

    # List
    r = client.get("/api/pools", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1

    # Add the admin themselves as a member
    r = client.post(
        f"/api/pools/{pid}/members",
        headers=headers,
        json={"person_id": info["person_id"]},
    )
    assert r.status_code == 201, r.text

    # Adding again -> 409
    r = client.post(
        f"/api/pools/{pid}/members",
        headers=headers,
        json={"person_id": info["person_id"]},
    )
    assert r.status_code == 409

    # Detail with members
    r = client.get(f"/api/pools/{pid}", headers=headers)
    assert r.status_code == 200
    detail = r.json()
    assert detail["member_count"] == 1
    assert len(detail["members"]) == 1
    assert detail["members"][0]["person_id"] == info["person_id"]

    # Update mode
    r = client.put(
        f"/api/pools/{pid}",
        headers=headers,
        json={"membership_mode": "rotational"},
    )
    assert r.status_code == 200
    assert r.json()["membership_mode"] == "rotational"

    # Remove member
    r = client.delete(
        f"/api/pools/{pid}/members/{info['person_id']}", headers=headers
    )
    assert r.status_code == 204

    # Member gone
    r = client.get(f"/api/pools/{pid}", headers=headers)
    assert r.json()["member_count"] == 0

    # Delete pool
    r = client.delete(f"/api/pools/{pid}", headers=headers)
    assert r.status_code == 204


def test_pools_tenant_isolation(auth_client, second_tenant):
    client, headers_a, _info_a = auth_client
    headers_b, _info_b = second_tenant

    r = client.post("/api/pools", headers=headers_a, json={"name": "REA"})
    assert r.status_code == 201
    a_pid = r.json()["id"]

    r = client.post("/api/pools", headers=headers_b, json={"name": "Trasplantes"})
    assert r.status_code == 201

    r = client.get("/api/pools", headers=headers_a)
    assert {p["name"] for p in r.json()} == {"REA"}
    r = client.get("/api/pools", headers=headers_b)
    assert {p["name"] for p in r.json()} == {"Trasplantes"}

    # B cannot access A's pool
    r = client.get(f"/api/pools/{a_pid}", headers=headers_b)
    assert r.status_code == 404


def test_pools_invalid_membership_mode_422(auth_client):
    client, headers, _ = auth_client
    r = client.post(
        "/api/pools",
        headers=headers,
        json={"name": "X", "membership_mode": "weird"},
    )
    assert r.status_code == 422

"""Skills CRUD + tenant isolation."""


def test_skills_crud(auth_client):
    client, headers, _info = auth_client

    r = client.post(
        "/api/skills",
        headers=headers,
        json={"name": "ECMO", "description": "Extracorporeal life support"},
    )
    assert r.status_code == 201, r.text
    sid = r.json()["id"]

    r = client.get("/api/skills", headers=headers)
    assert len(r.json()) == 1

    r = client.put(
        f"/api/skills/{sid}", headers=headers, json={"description": "Updated"}
    )
    assert r.status_code == 200
    assert r.json()["description"] == "Updated"

    # Idempotent: duplicate name returns existing row with 200.
    r = client.post("/api/skills", headers=headers, json={"name": "ECMO"})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == sid
    # Case-insensitive: same row.
    r = client.post("/api/skills", headers=headers, json={"name": "ecmo"})
    assert r.status_code == 200
    assert r.json()["id"] == sid

    r = client.delete(f"/api/skills/{sid}", headers=headers)
    assert r.status_code == 204
    r = client.get(f"/api/skills/{sid}", headers=headers)
    assert r.status_code == 404


def test_skills_tenant_isolation(auth_client, second_tenant):
    client, headers_a, _ = auth_client
    headers_b, _ = second_tenant

    r = client.post("/api/skills", headers=headers_a, json={"name": "ECMO"})
    assert r.status_code == 201
    a_id = r.json()["id"]

    r = client.post("/api/skills", headers=headers_b, json={"name": "Lap Surgery"})
    assert r.status_code == 201

    r = client.get("/api/skills", headers=headers_a)
    assert {s["name"] for s in r.json()} == {"ECMO"}
    r = client.get("/api/skills", headers=headers_b)
    assert {s["name"] for s in r.json()} == {"Lap Surgery"}

    r = client.get(f"/api/skills/{a_id}", headers=headers_b)
    assert r.status_code == 404

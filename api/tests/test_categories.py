"""Categories CRUD + tenant isolation, including a raw-SQL RLS probe."""
from sqlalchemy import create_engine, text

from app.core.config import settings


def test_categories_crud_round_trip(auth_client):
    client, headers, _info = auth_client

    # List empty
    r = client.get("/api/categories", headers=headers)
    assert r.status_code == 200
    assert r.json() == []

    # Create
    r = client.post(
        "/api/categories",
        headers=headers,
        json={"name": "Adjunto", "level": 2, "description": "Doctor adjunto"},
    )
    assert r.status_code == 201, r.text
    cat = r.json()
    cid = cat["id"]
    assert cat["name"] == "Adjunto"
    assert cat["level"] == 2

    # Idempotent: same name returns the existing row with 200, no duplicate.
    r = client.post(
        "/api/categories",
        headers=headers,
        json={"name": "Adjunto"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["id"] == cid

    # Case-insensitive: "ADJUNTO" also returns the same row.
    r = client.post("/api/categories", headers=headers, json={"name": "ADJUNTO"})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == cid

    # Whitespace is trimmed.
    r = client.post("/api/categories", headers=headers, json={"name": "  Adjunto  "})
    assert r.status_code == 200, r.text
    assert r.json()["id"] == cid

    # List still has exactly one.
    r = client.get("/api/categories", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1

    # Get one
    r = client.get(f"/api/categories/{cid}", headers=headers)
    assert r.status_code == 200
    assert r.json()["id"] == cid

    # Update
    r = client.put(
        f"/api/categories/{cid}",
        headers=headers,
        json={"name": "Adjunto Senior", "level": 1},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Adjunto Senior"
    assert r.json()["level"] == 1

    # Delete
    r = client.delete(f"/api/categories/{cid}", headers=headers)
    assert r.status_code == 204

    r = client.get(f"/api/categories/{cid}", headers=headers)
    assert r.status_code == 404


def test_categories_tenant_isolation(auth_client, second_tenant):
    client, headers_a, _info_a = auth_client
    headers_b, _info_b = second_tenant

    # A creates Adjunto
    r = client.post(
        "/api/categories", headers=headers_a, json={"name": "Adjunto", "level": 1}
    )
    assert r.status_code == 201
    a_id = r.json()["id"]

    # B creates Residente
    r = client.post(
        "/api/categories", headers=headers_b, json={"name": "Residente", "level": 5}
    )
    assert r.status_code == 201
    b_id = r.json()["id"]

    # Each tenant only sees its own
    r = client.get("/api/categories", headers=headers_a)
    names = {c["name"] for c in r.json()}
    assert names == {"Adjunto"}

    r = client.get("/api/categories", headers=headers_b)
    names = {c["name"] for c in r.json()}
    assert names == {"Residente"}

    # B cannot fetch A's category
    r = client.get(f"/api/categories/{a_id}", headers=headers_b)
    assert r.status_code == 404
    r = client.put(
        f"/api/categories/{a_id}", headers=headers_b, json={"name": "X"}
    )
    assert r.status_code == 404
    r = client.delete(f"/api/categories/{a_id}", headers=headers_b)
    assert r.status_code == 404


def test_categories_rls_raw_probe(auth_client):
    """Raw SQL probe as albus_app: setting tenant_id only shows that tenant's rows."""
    client, headers, info = auth_client
    r = client.post(
        "/api/categories", headers=headers, json={"name": "Adjunto"}
    )
    assert r.status_code == 201

    engine = create_engine(settings.runtime_db_url, future=True)
    with engine.begin() as conn:
        # No tenant context: must see nothing.
        conn.execute(text("RESET app.tenant_id"))
        rows = conn.execute(text("SELECT * FROM categories")).all()
        assert rows == []

        # With tenant context: only A's rows.
        conn.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(info["tenant_id"])})
        rows = conn.execute(text("SELECT name, tenant_id FROM categories")).all()
        assert all(r.tenant_id == info["tenant_id"] for r in rows)
        assert any(r.name == "Adjunto" for r in rows)
    engine.dispose()

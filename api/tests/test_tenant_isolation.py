"""Verify RLS does the isolation work — not application WHERE clauses.

Strategy: create two tenants, seed departments + role_types directly via SQL
(bypassing app code), then issue raw queries through a Postgres session that
has SET LOCAL app.tenant_id = <A>, and confirm tenant B's rows are invisible.
"""
import uuid

from sqlalchemy import create_engine, text

from app.core.config import settings

# RLS-probing engine MUST be the non-superuser role; superusers bypass RLS.
def _app_engine_url() -> str:
    # Re-read settings each call so the test-database session fixture
    # (which mutates settings before any test runs) takes effect.
    return settings.runtime_db_url


def _seed(conn, tenant_id: int, label: str):
    conn.execute(
        text("INSERT INTO departments (tenant_id, name) VALUES (:t, :n)"),
        {"t": tenant_id, "n": f"dept-{label}"},
    )
    conn.execute(
        text(
            "INSERT INTO role_types (tenant_id, name, defaults_jsonb) "
            "VALUES (:t, :n, '{}'::jsonb)"
        ),
        {"t": tenant_id, "n": f"role-{label}"},
    )


def test_rls_blocks_cross_tenant_reads():
    engine = create_engine(_app_engine_url(), future=True)
    suffix = uuid.uuid4().hex[:6]

    # Seed (no RLS context — superuser-like role inside the tx still sees,
    # but FORCE ROW LEVEL SECURITY makes the policy apply even to the table
    # owner. So we set tenant_id explicitly during seeding.)
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO tenants (slug, name) VALUES (:s, 'A') RETURNING id"),
            {"s": f"a-{suffix}"},
        )
        a_id = conn.execute(text("SELECT id FROM tenants WHERE slug = :s"), {"s": f"a-{suffix}"}).scalar_one()
        conn.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(a_id)})
        _seed(conn, a_id, "A")

    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO tenants (slug, name) VALUES (:s, 'B')"),
            {"s": f"b-{suffix}"},
        )
        b_id = conn.execute(text("SELECT id FROM tenants WHERE slug = :s"), {"s": f"b-{suffix}"}).scalar_one()
        conn.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(b_id)})
        _seed(conn, b_id, "B")

    # Read as tenant A: should see only A rows
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(a_id)})
        depts = conn.execute(text("SELECT name, tenant_id FROM departments")).all()
        roles = conn.execute(text("SELECT name, tenant_id FROM role_types")).all()
        assert all(d.tenant_id == a_id for d in depts), f"A leak: {depts}"
        assert all(r.tenant_id == a_id for r in roles), f"A leak: {roles}"
        assert any(d.name == "dept-A" for d in depts)
        assert not any(d.name == "dept-B" for d in depts)

    # Read as tenant B: should see only B rows
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(b_id)})
        depts = conn.execute(text("SELECT name, tenant_id FROM departments")).all()
        assert all(d.tenant_id == b_id for d in depts), f"B leak: {depts}"
        assert any(d.name == "dept-B" for d in depts)
        assert not any(d.name == "dept-A" for d in depts)

    # Read with NO tenant set: must see nothing.
    with engine.begin() as conn:
        # Explicitly RESET in case session vars leak
        conn.execute(text("RESET app.tenant_id"))
        depts = conn.execute(text("SELECT * FROM departments")).all()
        roles = conn.execute(text("SELECT * FROM role_types")).all()
        memb = conn.execute(text("SELECT * FROM memberships")).all()
        assert depts == [], f"RLS failed open on departments: {depts}"
        assert roles == [], f"RLS failed open on role_types: {roles}"
        assert memb == [], f"RLS failed open on memberships: {memb}"

    engine.dispose()


def test_me_endpoint_isolates_memberships(client):
    """End-to-end: tenant A's /me must not list tenant B's data, and vice versa."""
    suffix = uuid.uuid4().hex[:6]

    # Tenant A admin
    r = client.post("/api/signup", json={
        "tenant_name": "A", "tenant_slug": f"aa-{suffix}",
        "person_name": "Alice", "email": f"alice-{suffix}@x.com",
        "password": "supersecret1",
    })
    assert r.status_code == 201
    a_token = r.json()["access_token"]

    # Tenant B admin (different person)
    r = client.post("/api/signup", json={
        "tenant_name": "B", "tenant_slug": f"bb-{suffix}",
        "person_name": "Bob", "email": f"bob-{suffix}@x.com",
        "password": "supersecret1",
    })
    assert r.status_code == 201
    b_token = r.json()["access_token"]

    # Seed departments for B directly
    engine = create_engine(_app_engine_url(), future=True)
    with engine.begin() as conn:
        b_id = conn.execute(
            text("SELECT id FROM tenants WHERE slug = :s"), {"s": f"bb-{suffix}"}
        ).scalar_one()
        conn.execute(text("SET LOCAL app.tenant_id = :t"), {"t": str(b_id)})
        conn.execute(
            text("INSERT INTO departments (tenant_id, name) VALUES (:t, 'B-secret')"),
            {"t": b_id},
        )
    engine.dispose()

    # A's /me must not include B-secret
    r = client.get("/api/me", headers={"Authorization": f"Bearer {a_token}"})
    assert r.status_code == 200
    body = r.json()
    assert all(d["name"] != "B-secret" for d in body["departments"])
    assert len(body["memberships"]) == 1
    assert body["current_tenant"]["slug"] == f"aa-{suffix}"

    # B's /me does see B-secret
    r = client.get("/api/me", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 200
    body = r.json()
    assert any(d["name"] == "B-secret" for d in body["departments"])

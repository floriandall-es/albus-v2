"""Holidays CRUD + import + tenant isolation."""

from __future__ import annotations


def test_holidays_crud_round_trip(auth_client, client):
    _client, headers, _info = auth_client

    # Empty initially
    r = client.get("/api/holidays", headers=headers)
    assert r.status_code == 200
    assert r.json() == []

    # Create custom
    r = client.post(
        "/api/holidays",
        headers=headers,
        json={"date": "2026-05-15", "name": "San Isidro", "source": "custom"},
    )
    assert r.status_code == 201, r.text
    hid = r.json()["id"]
    assert r.json()["source"] == "custom"

    # Year filter
    r = client.get("/api/holidays?year=2026", headers=headers)
    assert len(r.json()) == 1
    r = client.get("/api/holidays?year=2025", headers=headers)
    assert r.json() == []

    # Delete
    r = client.delete(f"/api/holidays/{hid}", headers=headers)
    assert r.status_code == 204
    r = client.get("/api/holidays", headers=headers)
    assert r.json() == []


def test_holidays_import_es_2026(auth_client, client):
    _client, headers, _info = auth_client

    r = client.post(
        "/api/holidays/import",
        headers=headers,
        json={"country_code": "ES", "region_code": "ES-MD", "year": 2026},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["inserted"] > 0
    inserted_first = body["inserted"]
    assert body["skipped"] == 0

    # Re-import skips duplicates.
    r = client.post(
        "/api/holidays/import",
        headers=headers,
        json={"country_code": "ES", "region_code": "ES-MD", "year": 2026},
    )
    assert r.status_code == 200
    body2 = r.json()
    assert body2["inserted"] == 0
    assert body2["skipped"] == inserted_first

    # Confirm rows exist
    r = client.get("/api/holidays?year=2026", headers=headers)
    rows = r.json()
    assert any(h["source"] == "national" for h in rows)
    assert any(h["source"] == "regional" and h["region_code"] == "ES-MD" for h in rows)


def test_holidays_import_unknown_country(auth_client, client):
    _client, headers, _info = auth_client
    r = client.post(
        "/api/holidays/import",
        headers=headers,
        json={"country_code": "ZZ", "year": 2026},
    )
    assert r.status_code == 200
    assert r.json() == {"inserted": 0, "skipped": 0}


def test_holidays_tenant_isolation(auth_client, second_tenant, client):
    _client, headers_a, _info = auth_client
    headers_b, _info_b = second_tenant

    client.post(
        "/api/holidays",
        headers=headers_a,
        json={"date": "2026-07-04", "name": "A only", "source": "custom"},
    )
    client.post(
        "/api/holidays",
        headers=headers_b,
        json={"date": "2026-07-04", "name": "B only", "source": "custom"},
    )

    r = client.get("/api/holidays", headers=headers_a)
    names_a = {h["name"] for h in r.json()}
    assert "A only" in names_a and "B only" not in names_a

    r = client.get("/api/holidays", headers=headers_b)
    names_b = {h["name"] for h in r.json()}
    assert "B only" in names_b and "A only" not in names_b


def test_holidays_admin_required(auth_client, client):
    _client, headers, _info = auth_client
    # Onboard a member
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "memberH@example.com", "person_name": "M", "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"accept_terms": True, "password": "memberH123"},
    )
    member_jwt = r.json()["access_token"]
    member_headers = {"Authorization": f"Bearer {member_jwt}"}

    # GET allowed for any member
    r = client.get("/api/holidays", headers=member_headers)
    assert r.status_code == 200

    # POST denied
    r = client.post(
        "/api/holidays",
        headers=member_headers,
        json={"date": "2026-12-31", "name": "Foo", "source": "custom"},
    )
    assert r.status_code == 403


def test_tenants_me_patch_country_region(auth_client, client):
    _client, headers, _info = auth_client
    r = client.patch(
        "/api/tenants/me",
        headers=headers,
        json={"country_code": "ES", "region_code": "ES-MD"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["country_code"] == "ES"
    assert r.json()["region_code"] == "ES-MD"

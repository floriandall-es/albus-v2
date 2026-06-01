"""CSV bulk-invite flow: /api/team/invite/bulk/preview and /commit."""

from __future__ import annotations

import io


def _csv_bytes(text: str) -> bytes:
    return text.encode("utf-8")


def _upload(client, headers, content: bytes, filename: str = "team.csv"):
    return client.post(
        "/api/team/invite/bulk/preview",
        headers=headers,
        files={"file": (filename, io.BytesIO(content), "text/csv")},
    )


def _make_category(client, headers, name: str) -> int:
    r = client.post("/api/categories", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# preview
# ---------------------------------------------------------------------------
def test_preview_happy_path(auth_client, client):
    _c, headers, _ = auth_client
    cat_id = _make_category(client, headers, "Adjunto")

    csv = (
        "email,name,category\n"
        "ana@example.com,Ana,Adjunto\n"
        "luis@example.com,Luis,Adjunto\n"
        "marta@example.com,Marta,\n"
    )
    r = _upload(client, headers, _csv_bytes(csv))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"] == {
        "total_rows": 3,
        "valid_rows": 3,
        "warning_rows": 0,
        "error_rows": 0,
    }
    assert all(row["status"] == "ok" for row in body["rows"])
    # Category resolved
    assert body["rows"][0]["category_id"] == cat_id
    assert body["rows"][2]["category_id"] is None
    # No invitations created (preview only)
    inv = client.get("/api/invitations", headers=headers).json()
    assert inv == []


def test_preview_rejects_wrong_header(auth_client, client):
    _c, headers, _ = auth_client
    # `mail` isn't a known alias for email; `categoria` (no accent) IS
    # accepted, so this tests the unknown-column path.
    csv = "mail,name,categoria\nana@example.com,Ana,\n"
    r = _upload(client, headers, _csv_bytes(csv))
    assert r.status_code == 400
    assert "no reconocidas" in r.json()["detail"].lower()


def test_preview_row_errors(auth_client, client):
    _c, headers, _ = auth_client
    _make_category(client, headers, "Adjunto")

    csv = (
        "email,name,category\n"
        "not-an-email,Ana,Adjunto\n"
        "luis@example.com,,Adjunto\n"
        "marta@example.com,Marta,DoesNotExist\n"
        "dup@example.com,Dup1,\n"
        "dup@example.com,Dup2,\n"
    )
    r = _upload(client, headers, _csv_bytes(csv))
    assert r.status_code == 200, r.text
    rows = r.json()["rows"]
    statuses = [row["status"] for row in rows]
    assert statuses == ["error", "error", "error", "ok", "error"]
    assert "no válido" in rows[0]["error"].lower() or "valido" in rows[0]["error"].lower()
    assert "nombre" in rows[1]["error"].lower()
    assert "categoría" in rows[2]["error"].lower() or "categoria" in rows[2]["error"].lower()
    assert "duplicado" in rows[4]["error"].lower()


def test_preview_warning_for_pending_invite(auth_client, client):
    _c, headers, _ = auth_client
    # Create a pending invite first
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "pending@example.com", "person_name": "Pending"},
    )
    assert r.status_code == 201

    csv = "email,name,category\npending@example.com,New Name,\n"
    r = _upload(client, headers, _csv_bytes(csv))
    assert r.status_code == 200
    row = r.json()["rows"][0]
    assert row["status"] == "warning"
    assert "pendiente" in row["warning"].lower()


def test_preview_already_member(auth_client, client):
    _c, headers, info = auth_client
    csv = f"email,name,category\n{info['email']},Whoever,\n"
    r = _upload(client, headers, _csv_bytes(csv))
    assert r.status_code == 200
    row = r.json()["rows"][0]
    assert row["status"] == "error"
    assert "miembro" in row["error"].lower()


def test_file_size_cap(auth_client, client):
    _c, headers, _ = auth_client
    big = "email,name,category\n" + ("a@b.com,X,\n" * 200_000)
    r = _upload(client, headers, big.encode("utf-8"))
    assert r.status_code == 413


def test_row_cap(auth_client, client):
    _c, headers, _ = auth_client
    # Build > 5000 rows but stay well under 1 MB
    rows = "\n".join(f"u{i}@example.com,Name,," for i in range(5001))
    csv = "email,name,category\n" + rows
    r = _upload(client, headers, csv.encode("utf-8"))
    assert r.status_code == 400
    assert "5000" in r.json()["detail"]


def test_preview_strips_bom(auth_client, client):
    _c, headers, _ = auth_client
    csv = "﻿email,name,category\nana@example.com,Ana,\n"
    r = _upload(client, headers, csv.encode("utf-8"))
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["valid_rows"] == 1


def test_non_admin_cannot_preview_or_commit(auth_client, client):
    _c, headers, _info = auth_client
    # Provision a member
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "regular@example.com", "person_name": "Reg", "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"accept_terms": True, "password": "memberpass1"},
    )
    member_token = r.json()["access_token"]
    member_headers = {"Authorization": f"Bearer {member_token}"}

    csv = "email,name,category\nx@example.com,X,\n"
    r = client.post(
        "/api/team/invite/bulk/preview",
        headers=member_headers,
        files={"file": ("t.csv", io.BytesIO(csv.encode("utf-8")), "text/csv")},
    )
    assert r.status_code == 403
    r = client.post(
        "/api/team/invite/bulk/commit",
        headers=member_headers,
        json={"rows": [{"row_number": 1, "email": "x@example.com", "name": "X"}]},
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# commit
# ---------------------------------------------------------------------------
def test_commit_happy_path(auth_client, client):
    _c, headers, _ = auth_client
    cat_id = _make_category(client, headers, "Adjunto")
    payload = {
        "rows": [
            {"row_number": 1, "email": "a@example.com", "name": "A", "category_id": cat_id},
            {"row_number": 2, "email": "b@example.com", "name": "B", "category_id": cat_id},
            {"row_number": 3, "email": "c@example.com", "name": "C", "category_id": None},
        ]
    }
    r = client.post("/api/team/invite/bulk/commit", headers=headers, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"] == {"committed": 3, "skipped": 0, "errored": 0}
    accept_urls = [row["invitation"]["accept_url"] for row in body["results"]]
    assert len(set(accept_urls)) == 3
    # Each token resolves
    for url in accept_urls:
        token = url.rsplit("/", 1)[-1]
        r = client.get(f"/api/invitations/by-token/{token}")
        assert r.status_code == 200


def test_commit_revokes_prior_pending(auth_client, client):
    _c, headers, _ = auth_client
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "again@example.com", "person_name": "A"},
    )
    old_token = r.json()["accept_url"].rsplit("/", 1)[-1]
    old_id = r.json()["invitation_id"]

    r = client.post(
        "/api/team/invite/bulk/commit",
        headers=headers,
        json={
            "rows": [
                {"row_number": 1, "email": "again@example.com", "name": "A2"}
            ]
        },
    )
    assert r.status_code == 200
    new_token = r.json()["results"][0]["invitation"]["accept_url"].rsplit("/", 1)[-1]

    # Old token no longer works
    assert client.get(f"/api/invitations/by-token/{old_token}").status_code == 404
    # New one does
    assert client.get(f"/api/invitations/by-token/{new_token}").status_code == 200
    # And the IDs differ
    assert r.json()["results"][0]["invitation"]["id"] != old_id


def test_commit_partial_skips_already_member(auth_client, client, second_tenant):
    """Simulate: between preview and commit, one of the rows became a member.
    We do this by inviting + accepting in tenant A for one of the emails."""
    _c, headers, _info = auth_client

    # Plant a member for "alreadyhere@example.com" in tenant A directly
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": "alreadyhere@example.com", "person_name": "Here"},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"accept_terms": True, "password": "secret123"},
    )
    assert r.status_code == 200

    payload = {
        "rows": [
            {"row_number": 1, "email": "alreadyhere@example.com", "name": "X"},
            {"row_number": 2, "email": "fresh@example.com", "name": "Fresh"},
        ]
    }
    r = client.post("/api/team/invite/bulk/commit", headers=headers, json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["summary"]["committed"] == 1
    assert body["summary"]["skipped"] == 1
    statuses = {row["row_number"]: row["status"] for row in body["results"]}
    assert statuses[1] == "skipped"
    assert statuses[2] == "ok"


def test_commit_tenant_isolation(auth_client, second_tenant, client):
    """Tenant A admin's commit only creates invitations under tenant A."""
    _c, headers_a, _info_a = auth_client
    headers_b, info_b = second_tenant

    # Tenant A invites someone
    r = client.post(
        "/api/team/invite/bulk/commit",
        headers=headers_a,
        json={
            "rows": [
                {"row_number": 1, "email": "isol@example.com", "name": "Iso"}
            ]
        },
    )
    assert r.status_code == 200
    # Tenant B's invitations list shouldn't contain it
    r = client.get("/api/invitations", headers=headers_b)
    emails_b = {i["email"] for i in r.json()}
    assert "isol@example.com" not in emails_b
    r = client.get("/api/invitations", headers=headers_a)
    emails_a = {i["email"] for i in r.json()}
    assert "isol@example.com" in emails_a


def test_template_endpoint(auth_client, client):
    _c, headers, _ = auth_client
    r = client.get("/api/team/invite/bulk/template", headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.text.startswith("email,nombre,categoría")


def test_preview_accepts_spanish_headers_and_arbitrary_order(auth_client, client):
    """Spanish admins typing CSVs in their own language. Header mapping is
    alias-based and case/accent-insensitive, and column order is free."""
    _c, headers, _info = auth_client
    # All-Spanish, accents present, columns reordered (categoría first).
    csv = (
        "categoría,nombre,email\n"
        "Adjunto,Maria Lopez,maria@hospital.es\n"
        ",Juan Garcia,juan@hospital.es\n"
    )
    r = client.post(
        "/api/team/invite/bulk/preview",
        headers=headers,
        files={"file": ("equipo.csv", csv.encode("utf-8"), "text/csv")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"]["total_rows"] == 2
    # Both rows parsed correctly despite reordered columns.
    by_email = {r["email"]: r for r in body["rows"]}
    assert by_email["maria@hospital.es"]["name"] == "Maria Lopez"
    assert by_email["juan@hospital.es"]["name"] == "Juan Garcia"


def test_preview_rejects_unknown_header(auth_client, client):
    _c, headers, _info = auth_client
    csv = "email,name,team\nx@y.com,X,Cardio\n"
    r = client.post(
        "/api/team/invite/bulk/preview",
        headers=headers,
        files={"file": ("equipo.csv", csv.encode("utf-8"), "text/csv")},
    )
    assert r.status_code == 400
    assert "no reconocidas" in r.json()["detail"].lower()


def test_preview_accepts_semicolon_separator(auth_client, client):
    """Excel in Spanish / EU locales defaults to ';' as the field
    separator because comma is used for decimals. The parser should
    auto-detect and treat ';' the same as ','."""
    _c, headers, _info = auth_client
    csv = (
        "email;nombre;categoría\n"
        "ana@example.com;Ana López;\n"
        "luis@example.com;Luis García;\n"
    )
    r = client.post(
        "/api/team/invite/bulk/preview",
        headers=headers,
        files={"file": ("equipo.csv", csv.encode("utf-8"), "text/csv")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"]["total_rows"] == 2
    by_email = {r["email"]: r for r in body["rows"]}
    assert by_email["ana@example.com"]["name"] == "Ana López"
    assert by_email["luis@example.com"]["name"] == "Luis García"

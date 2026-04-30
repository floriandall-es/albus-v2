"""Self-service availability requests + admin approval workflow."""

from __future__ import annotations


def _onboard(client, headers, email, name="P"):
    r = client.post(
        "/api/team/invite",
        headers=headers,
        json={"email": email, "person_name": name, "roles": ["member"]},
    )
    token = r.json()["accept_url"].rsplit("/", 1)[-1]
    r = client.post(
        f"/api/invitations/by-token/{token}/accept",
        json={"password": "memberpass"},
    )
    return r.json()["person"]["id"], r.json()["access_token"]


def _create_slot(client, headers):
    body = {
        "name": "Día",
        "days_applied": "all",
        "staffing_mode": "single",
        "headcount": 1,
        "post_slot_rest": False,
        "counts_for_equity": True,
        "team_roles": [],
        "skills_required": [],
    }
    r = client.post("/api/slots", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_member_creates_pending_request(auth_client, client):
    _client, headers, _info = auth_client
    pid, member_token = _onboard(client, headers, "m@example.com", "Miembro")
    member_h = {"Authorization": f"Bearer {member_token}"}
    r = client.post(
        "/api/me/availability-requests",
        headers=member_h,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-15",
            "block_type": "vacation",
            "notes": "Boda hermana",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert body["person_id"] == pid
    assert body["requested_by_membership_id"] is not None


def test_list_my_requests_only_own(auth_client, client):
    _client, headers, _info = auth_client
    _, ta = _onboard(client, headers, "a@example.com", "A")
    _, tb = _onboard(client, headers, "b@example.com", "B")
    ha = {"Authorization": f"Bearer {ta}"}
    hb = {"Authorization": f"Bearer {tb}"}
    client.post(
        "/api/me/availability-requests",
        headers=ha,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-12",
            "block_type": "vacation",
        },
    )
    client.post(
        "/api/me/availability-requests",
        headers=hb,
        json={
            "start_date": "2026-05-15",
            "end_date": "2026-05-18",
            "block_type": "personal",
        },
    )
    r = client.get("/api/me/availability-requests", headers=ha)
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["start_date"] == "2026-05-10"


def test_delete_my_pending_request(auth_client, client):
    _client, headers, _info = auth_client
    _, t = _onboard(client, headers, "d@example.com", "D")
    h = {"Authorization": f"Bearer {t}"}
    r = client.post(
        "/api/me/availability-requests",
        headers=h,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-12",
            "block_type": "vacation",
        },
    )
    bid = r.json()["id"]
    r = client.delete(f"/api/me/availability-requests/{bid}", headers=h)
    assert r.status_code == 204


def test_cannot_delete_my_approved_request(auth_client, client):
    _client, headers, _info = auth_client
    _, t = _onboard(client, headers, "ap@example.com", "AP")
    h = {"Authorization": f"Bearer {t}"}
    r = client.post(
        "/api/me/availability-requests",
        headers=h,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-12",
            "block_type": "vacation",
        },
    )
    bid = r.json()["id"]
    # Admin approves.
    client.post(f"/api/availability-blocks/{bid}/approve", headers=headers)
    # Member cannot delete it now.
    r = client.delete(f"/api/me/availability-requests/{bid}", headers=h)
    assert r.status_code == 404


def test_admin_approve_sets_status(auth_client, client):
    _client, headers, _info = auth_client
    _, t = _onboard(client, headers, "ax@example.com", "AX")
    h = {"Authorization": f"Bearer {t}"}
    r = client.post(
        "/api/me/availability-requests",
        headers=h,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-12",
            "block_type": "vacation",
        },
    )
    bid = r.json()["id"]
    r = client.post(f"/api/availability-blocks/{bid}/approve", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "approved"
    assert body["reviewed_by_membership_id"] is not None


def test_admin_deny_with_notes(auth_client, client):
    _client, headers, _info = auth_client
    _, t = _onboard(client, headers, "dn@example.com", "DN")
    h = {"Authorization": f"Bearer {t}"}
    r = client.post(
        "/api/me/availability-requests",
        headers=h,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-12",
            "block_type": "vacation",
        },
    )
    bid = r.json()["id"]
    r = client.post(
        f"/api/availability-blocks/{bid}/deny",
        headers=headers,
        json={"review_notes": "Imposible esa semana"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "denied"
    assert body["review_notes"] == "Imposible esa semana"


def test_solver_ignores_pending_blocks(auth_client, client):
    """A pending request must NOT prevent assignment — only approved
    blocks gate the solver."""
    _client, headers, _info = auth_client
    pid, t = _onboard(client, headers, "px@example.com", "PX")
    _create_slot(client, headers)
    h = {"Authorization": f"Bearer {t}"}
    # Member files a pending request covering the entire month.
    client.post(
        "/api/me/availability-requests",
        headers=h,
        json={
            "start_date": "2026-05-01",
            "end_date": "2026-05-31",
            "block_type": "vacation",
        },
    )
    # Generate as admin.
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    persons = {a["person_id"] for a in body["assignments"] if a["person_id"]}
    assert pid in persons, "pending block should not have blocked the member"


def test_solver_respects_approved_blocks(auth_client, client):
    """The Sprint 4 behavior must still hold — admin-approved blocks gate
    assignment."""
    _client, headers, _info = auth_client
    pid_a, _ = _onboard(client, headers, "ka@example.com", "KA")
    pid_b, _ = _onboard(client, headers, "kb@example.com", "KB")
    _create_slot(client, headers)
    # Admin-create defaults to approved.
    client.post(
        "/api/availability-blocks",
        headers=headers,
        json={
            "person_id": pid_a,
            "start_date": "2026-05-01",
            "end_date": "2026-05-31",
            "block_type": "vacation",
        },
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    persons = {a["person_id"] for a in body["assignments"] if a["person_id"]}
    assert pid_a not in persons
    assert pid_b in persons


def test_tenant_isolation_for_requests(auth_client, client, second_tenant):
    _client, headers, _info = auth_client
    _, t = _onboard(client, headers, "ti@example.com", "TI")
    h = {"Authorization": f"Bearer {t}"}
    r = client.post(
        "/api/me/availability-requests",
        headers=h,
        json={
            "start_date": "2026-05-10",
            "end_date": "2026-05-12",
            "block_type": "vacation",
        },
    )
    bid = r.json()["id"]
    other_headers, _other_info = second_tenant
    # Other tenant's admin trying to approve this block — RLS scopes by
    # tenant_id, so they should see it as not-found.
    r = client.post(
        f"/api/availability-blocks/{bid}/approve", headers=other_headers
    )
    assert r.status_code == 404

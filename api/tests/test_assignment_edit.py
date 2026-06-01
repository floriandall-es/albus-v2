"""Manual assignment editing + locking (Sprint 5 part B)."""

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
        json={"accept_terms": True, "password": "memberpass"},
    )
    return r.json()["person"]["id"], r.json()["access_token"]


def _create_slot(client, headers, **overrides):
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
    body.update(overrides)
    r = client.post("/api/slots", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _generate(client, headers, period="2026-05-01"):
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": period}
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_patch_with_eligible_person_succeeds(auth_client, client):
    _client, headers, _info = auth_client
    pid_a, _ = _onboard(client, headers, "a@example.com", "A")
    pid_b, _ = _onboard(client, headers, "b@example.com", "B")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    current = sched["assignments"][0]["person_id"]
    other = pid_b if current != pid_b else pid_a
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{aid}",
        headers=headers,
        json={"person_id": other},
    )
    assert r.status_code == 200, r.text
    assert r.json()["person_id"] == other


def test_patch_with_ineligible_person_returns_422(auth_client, client):
    """Person blocked by an availability block — solver wouldn't pick
    them, manual edit must reject too."""
    _client, headers, _info = auth_client
    pid_a, _ = _onboard(client, headers, "ia@example.com", "IA")
    pid_b, _ = _onboard(client, headers, "ib@example.com", "IB")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    # Block pid_b on the date of the first assignment.
    a0 = sched["assignments"][0]
    client.post(
        "/api/availability-blocks",
        headers=headers,
        json={
            "person_id": pid_b,
            "start_date": a0["date"],
            "end_date": a0["date"],
            "block_type": "vacation",
        },
    )
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{a0['id']}",
        headers=headers,
        json={"person_id": pid_b},
    )
    assert r.status_code == 422
    assert "bloqueo" in r.json()["detail"].lower()


def test_patch_on_published_schedule_returns_400(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "p@example.com")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    client.post(f"/api/schedules/{sched['id']}/publish", headers=headers)
    aid = sched["assignments"][0]["id"]
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{aid}",
        headers=headers,
        json={"clear_person": True},
    )
    assert r.status_code == 400


def test_patch_clears_person(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "c@example.com")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{aid}",
        headers=headers,
        json={"clear_person": True},
    )
    assert r.status_code == 200
    assert r.json()["person_id"] is None


def test_lock_then_patch_still_works(auth_client, client):
    """Locking does NOT prevent further edits — it means "preserve on
    regenerate", per spec."""
    _client, headers, _info = auth_client
    pid_a, _ = _onboard(client, headers, "la@example.com", "LA")
    pid_b, _ = _onboard(client, headers, "lb@example.com", "LB")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    current = sched["assignments"][0]["person_id"]
    other = pid_b if current != pid_b else pid_a
    r = client.post(
        f"/api/schedules/{sched['id']}/assignments/{aid}/lock", headers=headers
    )
    assert r.status_code == 200
    assert r.json()["locked_at"] is not None
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{aid}",
        headers=headers,
        json={"person_id": other},
    )
    assert r.status_code == 200, r.text


def test_lock_survives_regenerate(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "r1@example.com", "R1")
    _onboard(client, headers, "r2@example.com", "R2")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    a = sched["assignments"][0]
    client.post(
        f"/api/schedules/{sched['id']}/assignments/{a['id']}/lock",
        headers=headers,
    )
    locked_pid = a["person_id"]
    locked_date = a["date"]

    # Regenerate.
    sched2 = _generate(client, headers)
    on_date = [
        x for x in sched2["assignments"] if x["date"] == locked_date
    ]
    assert any(
        x["person_id"] == locked_pid and x["locked_at"] is not None
        for x in on_date
    )


def test_unlock_clears_lock_metadata(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "u@example.com")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    client.post(
        f"/api/schedules/{sched['id']}/assignments/{aid}/lock", headers=headers
    )
    r = client.delete(
        f"/api/schedules/{sched['id']}/assignments/{aid}/lock", headers=headers
    )
    assert r.status_code == 200
    assert r.json()["locked_at"] is None


def test_non_admin_forbidden(auth_client, client):
    _client, headers, _info = auth_client
    pid_member, member_token = _onboard(client, headers, "m@example.com", "Mem")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    member_headers = {"Authorization": f"Bearer {member_token}"}
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{aid}",
        headers=member_headers,
        json={"clear_person": True},
    )
    assert r.status_code == 403
    r = client.post(
        f"/api/schedules/{sched['id']}/assignments/{aid}/lock",
        headers=member_headers,
    )
    assert r.status_code == 403


def test_tenant_isolation(auth_client, client, second_tenant):
    _client, headers, _info = auth_client
    _onboard(client, headers, "ti@example.com")
    _create_slot(client, headers)
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    other_headers, _other_info = second_tenant
    r = client.patch(
        f"/api/schedules/{sched['id']}/assignments/{aid}",
        headers=other_headers,
        json={"clear_person": True},
    )
    assert r.status_code == 404


def test_eligible_persons_lists_only_eligible(auth_client, client):
    _client, headers, _info = auth_client
    pid_a, _ = _onboard(client, headers, "ea@example.com", "EA")
    pid_b, _ = _onboard(client, headers, "eb@example.com", "EB")
    _create_slot(client, headers, name="G", guardia_type="presencial_24h")
    # Give pid_a the matching guardia_type; pid_b has none.
    team = client.get("/api/team", headers=headers).json()
    for m in team:
        if m["person_id"] == pid_a:
            client.put(
                f"/api/team/{m['id']}",
                headers=headers,
                json={"guardia_types": ["presencial_24h"]},
            )
    sched = _generate(client, headers)
    aid = sched["assignments"][0]["id"]
    r = client.get(
        f"/api/schedules/{sched['id']}/assignments/{aid}/eligible-persons",
        headers=headers,
    )
    assert r.status_code == 200
    pids = {p["person_id"] for p in r.json()}
    assert pid_a in pids
    assert pid_b not in pids

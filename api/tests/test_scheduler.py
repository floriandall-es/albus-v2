"""Greedy scheduler stub: applies dates rules, respects holidays + blocks,
honours hard skills, balances round-robin, fills empty slots with NULL
person_id when no one is eligible."""

from __future__ import annotations

from collections import Counter
from datetime import date


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
    return r.json()["person"]["id"]


def _create_slot(client, headers, **overrides):
    body = {
        "name": "Guardia",
        "days_applied": "weekdays",
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


def test_generate_fills_every_weekday(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "p1@example.com", "Persona Uno")
    _onboard(client, headers, "p2@example.com", "Persona Dos")
    _create_slot(client, headers, name="Día")

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # May 2026: 21 weekdays
    assignments = body["assignments"]
    assert len(assignments) == 21
    for a in assignments:
        d = date.fromisoformat(a["date"])
        assert d.weekday() < 5
        assert a["person_id"] is not None


def test_generate_skips_holidays_and_includes_in_weekend_holiday_slot(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "h1@example.com")

    # Add a holiday on a weekday in May 2026 — May 1st is Friday (Fiesta del
    # Trabajo). Use 2026-05-01.
    client.post(
        "/api/holidays",
        headers=headers,
        json={"date": "2026-05-01", "name": "Trabajo", "source": "national"},
    )
    _create_slot(client, headers, name="Día", days_applied="weekdays")
    _create_slot(
        client,
        headers,
        name="Festivo",
        days_applied="weekends_holidays",
    )

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    body = r.json()
    weekday_slot_dates = {
        a["date"] for a in body["assignments"] if a["slot_name"] == "Día"
    }
    holiday_slot_dates = {
        a["date"] for a in body["assignments"] if a["slot_name"] == "Festivo"
    }
    assert "2026-05-01" not in weekday_slot_dates
    assert "2026-05-01" in holiday_slot_dates


def test_availability_block_excludes_person(auth_client, client):
    _client, headers, _info = auth_client
    pid_a = _onboard(client, headers, "a@example.com", "A")
    pid_b = _onboard(client, headers, "b@example.com", "B")
    _create_slot(client, headers, name="Día")

    # Block A for the entire month.
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
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    body = r.json()
    persons = {a["person_id"] for a in body["assignments"] if a["person_id"] is not None}
    assert pid_a not in persons
    assert pid_b in persons


def test_team_composition_respects_categories(auth_client, client):
    _client, headers, info = auth_client

    # Two categories
    r = client.post("/api/categories", headers=headers, json={"name": "Senior"})
    cat_senior = r.json()["id"]
    r = client.post("/api/categories", headers=headers, json={"name": "Junior"})
    cat_junior = r.json()["id"]

    pid_s = _onboard(client, headers, "s@example.com", "Senior P")
    pid_j = _onboard(client, headers, "j@example.com", "Junior P")

    # Assign categories via PUT /api/team
    r = client.get("/api/team", headers=headers)
    for m in r.json():
        if m["person_id"] == pid_s:
            client.put(
                f"/api/team/{m['id']}",
                headers=headers,
                json={"category_id": cat_senior},
            )
        elif m["person_id"] == pid_j:
            client.put(
                f"/api/team/{m['id']}",
                headers=headers,
                json={"category_id": cat_junior},
            )

    _create_slot(
        client,
        headers,
        name="Equipo",
        staffing_mode="team_composition",
        team_roles=[
            {"role_label": "Senior", "headcount": 1, "category_ids": [cat_senior]},
            {"role_label": "Junior", "headcount": 1, "category_ids": [cat_junior]},
        ],
    )

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    body = r.json()
    senior_assignments = [
        a for a in body["assignments"] if a["team_role_label"] == "Senior"
    ]
    junior_assignments = [
        a for a in body["assignments"] if a["team_role_label"] == "Junior"
    ]
    assert all(a["person_id"] == pid_s for a in senior_assignments)
    assert all(a["person_id"] == pid_j for a in junior_assignments)


def test_round_robin_is_balanced(auth_client, client):
    _client, headers, _info = auth_client
    p1 = _onboard(client, headers, "rr1@example.com", "R1")
    p2 = _onboard(client, headers, "rr2@example.com", "R2")
    p3 = _onboard(client, headers, "rr3@example.com", "R3")
    _create_slot(client, headers, name="Día", days_applied="all")

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    body = r.json()
    cnt = Counter(a["person_id"] for a in body["assignments"])
    counts = sorted(cnt.values(), reverse=True)
    # 31 days / 3 people = 10–11 each, ±1.
    assert max(counts) - min(counts) <= 1
    assert sum(counts) == 31


def test_publish_locks_regeneration(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "lock@example.com")
    _create_slot(client, headers, name="Día")

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    sid = r.json()["id"]

    r = client.post(f"/api/schedules/{sid}/publish", headers=headers)
    assert r.status_code == 200
    assert r.json()["status"] == "published"

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    assert r.status_code == 400



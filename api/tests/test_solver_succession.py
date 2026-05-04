"""Integration tests for slot succession rules in the solver."""

from __future__ import annotations

from datetime import date, timedelta


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
    return r.json()["person"]["id"]


def _create_slot(client, headers, **overrides):
    body = {
        "name": "X",
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


def _create_succession(client, headers, after_id, forbid_id, days_after=1, severity="hard", weight=5):
    r = client.post(
        "/api/slot-succession-rules",
        headers=headers,
        json={
            "after_slot_id": after_id,
            "forbid_slot_id": forbid_id,
            "days_after": days_after,
            "severity": severity,
            "weight": weight,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_hard_no_quirofano_after_guardia(auth_client, client):
    _, headers, _ = auth_client
    for i in range(3):
        _onboard(client, headers, f"p{i}@example.com", f"P{i}")
    g = _create_slot(client, headers, name="Guardia", days_applied="all")
    q = _create_slot(client, headers, name="Quirofano", days_applied="weekdays")
    _create_succession(client, headers, g["id"], q["id"], days_after=1, severity="hard")

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    by_person_date_slot: dict[int, dict[str, set[str]]] = {}
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        by_person_date_slot.setdefault(a["person_id"], {}).setdefault(
            a["date"], set()
        ).add(a["slot_name"])

    for pid, days in by_person_date_slot.items():
        for ds, slots in days.items():
            if "Guardia" not in slots:
                continue
            d = date.fromisoformat(ds)
            next_ds = (d + timedelta(days=1)).isoformat()
            slots_next = days.get(next_ds, set())
            assert "Quirofano" not in slots_next, (
                f"person {pid} did Guardia on {ds} and Quirofano on {next_ds}"
            )


def test_self_succession_no_guardia_3_days_after(auth_client, client):
    _, headers, _ = auth_client
    # Five people on weekdays only — plenty of slack for a 3-day rule.
    for i in range(5):
        _onboard(client, headers, f"p{i}@example.com", f"P{i}")
    g = _create_slot(client, headers, name="Guardia", days_applied="weekdays")
    _create_succession(client, headers, g["id"], g["id"], days_after=3, severity="hard")

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    by_pid: dict[int, list[date]] = {}
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        by_pid.setdefault(a["person_id"], []).append(date.fromisoformat(a["date"]))

    for pid, days in by_pid.items():
        days.sort()
        for i in range(len(days)):
            for j in range(i + 1, len(days)):
                gap = (days[j] - days[i]).days
                if gap == 0:
                    continue
                assert gap > 3, (
                    f"person {pid} guardias on {days[i]} and {days[j]} (gap {gap})"
                )


def test_soft_succession_allows_violation_when_no_alternative(auth_client, client):
    """Soft rule with high weight — solver should still produce a
    schedule (no rejection)."""
    _, headers, _ = auth_client
    # Just one person — so any succession violation is unavoidable.
    _onboard(client, headers, "only@example.com", "Only")
    g = _create_slot(client, headers, name="Guardia", days_applied="all")
    q = _create_slot(client, headers, name="Quirofano", days_applied="weekdays")
    _create_succession(client, headers, g["id"], q["id"], days_after=1, severity="soft", weight=100)

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    # Schedule produced; not all NULLs.
    filled = [a for a in body["assignments"] if a["person_id"] is not None]
    assert len(filled) > 0

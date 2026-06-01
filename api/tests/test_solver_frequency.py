"""Integration tests for slot frequency caps in the solver."""

from __future__ import annotations

from collections import Counter
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
        json={"accept_terms": True, "password": "memberpass"},
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


def _create_cap(client, headers, slot_id, period, max_count, severity="hard", weight=5):
    r = client.post(
        "/api/slot-frequency-caps",
        headers=headers,
        json={
            "slot_id": slot_id,
            "period": period,
            "max_count": max_count,
            "severity": severity,
            "weight": weight,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_hard_rolling_7_cap(auth_client, client):
    _, headers, _ = auth_client
    # Enough people that the solver can satisfy the cap.
    for i in range(5):
        _onboard(client, headers, f"p{i}@example.com", f"P{i}")
    q = _create_slot(client, headers, name="Quirofano", days_applied="weekdays")
    _create_cap(client, headers, q["id"], "rolling_7", 2, "hard")

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    by_pid: dict[int, list[date]] = {}
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        if a["slot_name"] != "Quirofano":
            continue
        by_pid.setdefault(a["person_id"], []).append(date.fromisoformat(a["date"]))

    # No 7-day rolling window has > 2 quirofanos for any single person.
    for pid, days in by_pid.items():
        days.sort()
        # For each anchor day, count entries in [anchor-6, anchor].
        for anchor in days:
            window_start = anchor - timedelta(days=6)
            count = sum(1 for d in days if window_start <= d <= anchor)
            assert count <= 2, (
                f"person {pid}: {count} quirofanos in window ending {anchor}"
            )


def test_soft_cap_minimizes_excess(auth_client, client):
    """Soft cap with one person — solver still produces schedule."""
    _, headers, _ = auth_client
    _onboard(client, headers, "only@example.com", "Only")
    q = _create_slot(client, headers, name="Quirofano", days_applied="weekdays")
    _create_cap(client, headers, q["id"], "rolling_7", 1, "soft", weight=10)

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    filled = [a for a in body["assignments"] if a["person_id"] is not None]
    # Soft -> still produces some assignments even if the cap can't be honoured.
    assert len(filled) > 0

"""Tests for the time-overlap helper and the solver-level constraint
that replaced the old "one slot per (person, date)" rule."""

from __future__ import annotations

from datetime import date, time
from types import SimpleNamespace


def _slot(name: str, start: str | None, end: str | None) -> SimpleNamespace:
    """Lightweight stand-in for a Slot row — only the attributes the
    overlap helper reads."""
    return SimpleNamespace(
        name=name,
        start_time=time.fromisoformat(start) if start else None,
        end_time=time.fromisoformat(end) if end else None,
    )


def test_consulta_then_guardia_no_overlap():
    from app.services.scheduler import slots_overlap_in_time

    consulta = _slot("Consulta", "08:00", "14:00")
    guardia = _slot("Guardia", "14:00", "08:00")  # crosses midnight
    d = date(2026, 5, 4)
    assert not slots_overlap_in_time(consulta, d, guardia, d)


def test_overlapping_segments():
    from app.services.scheduler import slots_overlap_in_time

    a = _slot("A", "08:00", "14:00")
    b = _slot("B", "13:00", "15:00")
    d = date(2026, 5, 4)
    assert slots_overlap_in_time(a, d, b, d)


def test_crosses_midnight_overlaps_next_day():
    from app.services.scheduler import slots_overlap_in_time

    night = _slot("Night", "20:00", "08:00")
    morning = _slot("Morning", "08:00", "14:00")
    d = date(2026, 5, 4)
    next_d = date(2026, 5, 5)
    # Night ends exactly at 08:00 of next day, morning starts at 08:00.
    # By half-open interval [s,e) they touch but don't overlap.
    assert not slots_overlap_in_time(night, d, morning, next_d)
    # But a morning that starts at 07:30 of next day DOES overlap.
    early_morning = _slot("Early", "07:30", "12:00")
    assert slots_overlap_in_time(night, d, early_morning, next_d)


def test_localizada_never_conflicts():
    from app.services.scheduler import slots_overlap_in_time

    localizada = _slot("Localizada", None, None)
    quirofano = _slot("Quirofano", "08:00", "14:00")
    d = date(2026, 5, 4)
    assert not slots_overlap_in_time(localizada, d, quirofano, d)
    assert not slots_overlap_in_time(quirofano, d, localizada, d)


def test_one_endpoint_null_treated_as_oncall():
    from app.services.scheduler import slots_overlap_in_time

    half = _slot("HalfNull", "08:00", None)
    other = _slot("Other", "10:00", "12:00")
    d = date(2026, 5, 4)
    assert not slots_overlap_in_time(half, d, other, d)


# ---------------------------------------------------------------------------
# Integration: the solver allows / disallows the right same-day combos.
# ---------------------------------------------------------------------------


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


def test_solver_allows_back_to_back_consulta_plus_guardia(auth_client, client):
    """The whole point of the rewrite: a doctor can do consulta 08-14
    AND start a guardia 14-08 the same calendar day."""
    _, headers, _ = auth_client
    _onboard(client, headers, "solo@example.com", "Solo")
    _create_slot(
        client,
        headers,
        name="Consulta",
        start_time="08:00",
        end_time="14:00",
        days_applied="weekdays",
    )
    _create_slot(
        client,
        headers,
        name="Guardia",
        start_time="14:00",
        end_time="08:00",
        days_applied="weekdays",
    )
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    # With only one person, both slots fall to that same person on every
    # weekday — the test asserts this happens at least once (not blocked
    # by the old per-day uniqueness).
    by_day: dict[str, set[str]] = {}
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        by_day.setdefault(a["date"], set()).add(a["slot_name"])
    same_day_combo = any(
        "Consulta" in s and "Guardia" in s for s in by_day.values()
    )
    assert same_day_combo, "expected at least one day with both Consulta+Guardia"


def test_solver_forbids_overlapping_segments(auth_client, client):
    _, headers, _ = auth_client
    _onboard(client, headers, "alone@example.com", "Alone")
    _create_slot(
        client,
        headers,
        name="Morning",
        start_time="08:00",
        end_time="14:00",
        days_applied="weekdays",
    )
    _create_slot(
        client,
        headers,
        name="Late",
        start_time="13:00",
        end_time="15:00",
        days_applied="weekdays",
    )
    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    body = r.json()
    # No person should appear on BOTH Morning and Late on the same day.
    by_pid_date: dict[tuple[int, str], set[str]] = {}
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        by_pid_date.setdefault((a["person_id"], a["date"]), set()).add(
            a["slot_name"]
        )
    for (pid, d), slots in by_pid_date.items():
        assert not ("Morning" in slots and "Late" in slots), (pid, d)

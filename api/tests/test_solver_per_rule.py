"""CP-SAT solver, per-rule strategies (sprint 6).

These tests exercise the rule-driven branching: pure-solver slots still
work as before; rotation rules deterministically pick by member position;
fixed_weekly pins; manual rules emit empty cells; and a person can't be
double-booked across slots that use different strategies.
"""

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
        json={"password": "memberpass"},
    )
    return r.json()["person"]["id"]


def _create_slot(client, headers, **overrides):
    body = {
        "name": "Guardia",
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


def test_default_solver_rule_regression(auth_client, client):
    """A slot with the default 7-day solver rule produces the same shape
    of schedule as before this feature (every weekday is filled)."""
    _client, headers, _info = auth_client
    _onboard(client, headers, "p1@example.com", "P1")
    _onboard(client, headers, "p2@example.com", "P2")
    _create_slot(client, headers, name="Día", days_applied="weekdays")
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    # 21 weekdays in May 2026 with default 7-day solver rule.
    assignments = [a for a in body["assignments"] if a["slot_name"] == "Día"]
    assert len(assignments) == 21
    assert all(a["person_id"] is not None for a in assignments)


def test_rotation_picks_deterministic(auth_client, client):
    """Rotation: weekday-only rotation with 4 members + Mon-Thu daily
    blocks. Verify member position computed from the anchor matches what
    the solver picks."""
    _client, headers, _info = auth_client
    p1 = _onboard(client, headers, "r1@example.com", "R1")
    p2 = _onboard(client, headers, "r2@example.com", "R2")
    p3 = _onboard(client, headers, "r3@example.com", "R3")
    p4 = _onboard(client, headers, "r4@example.com", "R4")
    members = [p1, p2, p3, p4]
    s = _create_slot(client, headers, name="Rot", days_applied="weekdays")
    anchor = date(2026, 5, 4)  # Monday
    rules = [
        {
            "days_bitmap": 0b0001111,  # Mon-Thu
            "strategy": "rotation",
            "anchor_date": anchor.isoformat(),
            "rotation_blocks": [
                {"position": 0, "days_bitmap": 1 << 0},  # Mon
                {"position": 1, "days_bitmap": 1 << 1},  # Tue
                {"position": 2, "days_bitmap": 1 << 2},  # Wed
                {"position": 3, "days_bitmap": 1 << 3},  # Thu
            ],
            "rotation_members": [
                {"position": i, "person_id": pid} for i, pid in enumerate(members)
            ],
        },
        {"days_bitmap": 0b1110000, "strategy": "manual"},  # Fri-Sun manual
    ]
    r = client.put(f"/api/slots/{s['id']}/rules", headers=headers, json={"rules": rules})
    assert r.status_code == 200, r.text

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()

    # Build expected: for each Mon-Thu in May 2026, compute expected pid.
    # Cycle: position = (rank + weeks*K) % N, where rank is the block's
    # CALENDAR rank from the anchor's weekday. Anchor=Mon, so blocks
    # already align: rank == b_idx.
    K = 4
    N = 4
    by_date: dict[str, list[int | None]] = {}
    for a in body["assignments"]:
        if a["slot_name"] != "Rot":
            continue
        by_date.setdefault(a["date"], []).append(a["person_id"])

    for d_iso, pids in by_date.items():
        d = date.fromisoformat(d_iso)
        if d.weekday() <= 3:
            weeks = (d - anchor).days // 7
            b_idx = d.weekday()  # rank == b_idx for anchor=Mon
            expected = members[(b_idx + weeks * K) % N]
            assert pids == [expected], (
                f"{d_iso} expected {expected} got {pids}"
            )
        else:
            # Manual on Fri/Sat/Sun → person_id None
            assert pids == [None]


def test_rotation_plus_solver_no_double_booking(auth_client, client):
    """Two slots: A=weekday rotation with 2 members, B=weekday solver.
    Both with times that OVERLAP — the rotation pre-pins one of the two
    members per day; solver must put the OTHER on slot B that day
    (no double-booking via the time-overlap constraint).

    Slots without times set are treated as on-call and CAN coexist —
    this test pins explicit overlapping times so the constraint
    actually fires.
    """
    _client, headers, _info = auth_client
    p1 = _onboard(client, headers, "p1@example.com", "P1")
    p2 = _onboard(client, headers, "p2@example.com", "P2")
    s_a = _create_slot(
        client,
        headers,
        name="A",
        days_applied="weekdays",
        start_time="08:00:00",
        end_time="14:00:00",
    )
    s_b = _create_slot(
        client,
        headers,
        name="B",
        days_applied="weekdays",
        start_time="10:00:00",
        end_time="16:00:00",
    )
    anchor = date(2026, 5, 4)
    client.put(
        f"/api/slots/{s_a['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0011111,
                    "strategy": "rotation",
                    "anchor_date": anchor.isoformat(),
                    "rotation_blocks": [
                        {"position": i, "days_bitmap": 1 << i} for i in range(5)
                    ],
                    "rotation_members": [
                        {"position": 0, "person_id": p1},
                        {"position": 1, "person_id": p2},
                    ],
                }
            ]
        },
    )
    # Slot B keeps the default solver rule.

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    a_by_date = {
        a["date"]: a["person_id"]
        for a in body["assignments"]
        if a["slot_name"] == "A"
    }
    b_by_date = {
        a["date"]: a["person_id"]
        for a in body["assignments"]
        if a["slot_name"] == "B"
    }
    for d_iso, a_pid in a_by_date.items():
        if a_pid in (p1, p2):
            assert b_by_date.get(d_iso) != a_pid, (
                f"{d_iso} double-booked: A={a_pid} B={b_by_date.get(d_iso)}"
            )


def test_fixed_weekly_pins_assigned(auth_client, client):
    _client, headers, _info = auth_client
    p_mon = _onboard(client, headers, "mon@example.com", "Mon")
    p_wed = _onboard(client, headers, "wed@example.com", "Wed")
    s = _create_slot(client, headers, name="FW", days_applied="weekdays")
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0011111,
                    "strategy": "fixed_weekly",
                    "weekly_pins": [
                        {"weekday": 0, "person_id": p_mon},
                        {"weekday": 2, "person_id": p_wed},
                    ],
                }
            ]
        },
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    by_date = {
        a["date"]: a["person_id"]
        for a in body["assignments"]
        if a["slot_name"] == "FW"
    }
    for d_iso, pid in by_date.items():
        d = date.fromisoformat(d_iso)
        if d.weekday() == 0:
            assert pid == p_mon, f"{d_iso} expected Mon-pin"
        elif d.weekday() == 2:
            assert pid == p_wed, f"{d_iso} expected Wed-pin"
        else:
            # Tue/Thu/Fri have no pin — should be NULL.
            assert pid is None, f"{d_iso} should have no pin"


def test_manual_rule_emits_only_nulls(auth_client, client):
    _client, headers, _info = auth_client
    _onboard(client, headers, "x@example.com", "X")
    s = _create_slot(client, headers, name="M", days_applied="weekdays")
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={"rules": [{"days_bitmap": 0b0011111, "strategy": "manual"}]},
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    cells = [a for a in body["assignments"] if a["slot_name"] == "M"]
    assert len(cells) > 0
    assert all(a["person_id"] is None for a in cells)


def test_two_rotations_independent(auth_client, client):
    """Mon-Thu daily rotation (3 members) + Fri-Sun weekly rotation
    (2 members). Each cycles independently. Confirms position math holds
    across multiple weeks."""
    _client, headers, _info = auth_client
    a = _onboard(client, headers, "a@example.com", "A")
    b = _onboard(client, headers, "b@example.com", "B")
    c = _onboard(client, headers, "c@example.com", "C")
    d = _onboard(client, headers, "d@example.com", "D")
    e = _onboard(client, headers, "e@example.com", "E")
    s = _create_slot(client, headers, name="Mix", days_applied="all")
    anchor_wd = date(2026, 5, 4)  # Monday
    anchor_we = date(2026, 5, 1)  # Friday
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0001111,  # Mon-Thu
                    "strategy": "rotation",
                    "anchor_date": anchor_wd.isoformat(),
                    "rotation_blocks": [
                        {"position": i, "days_bitmap": 1 << i} for i in range(4)
                    ],
                    "rotation_members": [
                        {"position": 0, "person_id": a},
                        {"position": 1, "person_id": b},
                        {"position": 2, "person_id": c},
                    ],
                },
                {
                    "days_bitmap": 0b1110000,  # Fri-Sun
                    "strategy": "rotation",
                    "anchor_date": anchor_we.isoformat(),
                    "rotation_blocks": [
                        {"position": 0, "days_bitmap": 0b1110000}
                    ],
                    "rotation_members": [
                        {"position": 0, "person_id": d},
                        {"position": 1, "person_id": e},
                    ],
                },
            ]
        },
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()

    wd_members = [a, b, c]
    we_members = [d, e]
    for asn in body["assignments"]:
        if asn["slot_name"] != "Mix":
            continue
        dt = date.fromisoformat(asn["date"])
        wd = dt.weekday()
        if wd <= 3:
            weeks = (dt - anchor_wd).days // 7
            expected = wd_members[(weeks * 4 + wd) % 3]
            assert asn["person_id"] == expected, (
                f"{asn['date']} expected {expected}"
            )
        else:
            # Same Fri-Sun share one block; same week → same person.
            weeks = (dt - anchor_we).days // 7
            expected = we_members[weeks % 2]
            assert asn["person_id"] == expected, (
                f"{asn['date']} expected {expected}"
            )

"""Multi-person teams in fixed_weekly and rotation rules (sprint 15).

Verifies:
- fixed_weekly with N pins on a weekday for a headcount=N slot fills all
  N spots from the team.
- fixed_weekly with fewer pins than headcount pads with NULL "Plaza
  adicional pendiente" rows (the gap is visible to the admin).
- rotation with M people per position and headcount=M cycles the team as
  a unit, with position math driven by P (number of positions), unchanged
  from the single-person case.
- multi-person pre-pins still feed correctly into the time-overlap
  detection: a person pinned 08-14 is free for an evening slot but
  blocked from a noon-overlap slot. This is the load-bearing invariant
  for sprint 14 cross-slot constraints — get it wrong and admins will
  see overbooked persons in team rotations.
"""

from __future__ import annotations

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


def test_fixed_weekly_full_team_assigned(auth_client, client):
    """3 pins on Monday for a headcount=3 multiple_same slot → all three
    persons appear on every Monday in the period."""
    _client, headers, _info = auth_client
    p_a = _onboard(client, headers, "fwa@example.com", "A")
    p_b = _onboard(client, headers, "fwb@example.com", "B")
    p_c = _onboard(client, headers, "fwc@example.com", "C")
    s = _create_slot(
        client,
        headers,
        name="EquipoFW",
        days_applied="weekdays",
        staffing_mode="multiple_same",
        headcount=3,
    )
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0011111,
                    "strategy": "fixed_weekly",
                    "weekly_pins": [
                        {"weekday": 0, "person_id": p_a},
                        {"weekday": 0, "person_id": p_b},
                        {"weekday": 0, "person_id": p_c},
                    ],
                }
            ]
        },
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    by_date: dict[str, list[int | None]] = {}
    for a in body["assignments"]:
        if a["slot_name"] != "EquipoFW":
            continue
        by_date.setdefault(a["date"], []).append(a["person_id"])

    expected = {p_a, p_b, p_c}
    saw_monday = False
    for d_iso, pids in by_date.items():
        d = date.fromisoformat(d_iso)
        if d.weekday() == 0:
            saw_monday = True
            assert len(pids) == 3, f"{d_iso} pids={pids}"
            assert set(pids) == expected, f"{d_iso} got {pids}"
    assert saw_monday, "expected at least one Monday in the period"


def test_fixed_weekly_partial_team_pads_nulls(auth_client, client):
    """2 pins on Monday for a headcount=3 slot → 2 pinned + 1 NULL row
    with notes='Plaza adicional pendiente'."""
    _client, headers, _info = auth_client
    p_a = _onboard(client, headers, "pa@example.com", "A")
    p_b = _onboard(client, headers, "pb@example.com", "B")
    s = _create_slot(
        client,
        headers,
        name="ParcialFW",
        days_applied="weekdays",
        staffing_mode="multiple_same",
        headcount=3,
    )
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0000001,  # Monday only
                    "strategy": "fixed_weekly",
                    "weekly_pins": [
                        {"weekday": 0, "person_id": p_a},
                        {"weekday": 0, "person_id": p_b},
                    ],
                }
            ]
        },
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()

    mondays_seen = 0
    for d_iso in {a["date"] for a in body["assignments"] if a["slot_name"] == "ParcialFW"}:
        d = date.fromisoformat(d_iso)
        if d.weekday() != 0:
            continue
        mondays_seen += 1
        rows = [
            a for a in body["assignments"]
            if a["slot_name"] == "ParcialFW" and a["date"] == d_iso
        ]
        assert len(rows) == 3, f"{d_iso} rows={rows}"
        pids = [r["person_id"] for r in rows]
        assert pids.count(None) == 1, f"{d_iso} expected one NULL, got {pids}"
        assert {p_a, p_b}.issubset(set(p for p in pids if p is not None))
        # The NULL row should carry the gap explanation.
        null_row = next(r for r in rows if r["person_id"] is None)
        assert null_row["notes"] == "Plaza adicional pendiente"
    assert mondays_seen >= 1


def test_rotation_team_per_position(auth_client, client):
    """3 members per position × 4 positions × headcount=3 weekly rotation
    over Mon-Sun. Each weekday's 3 assignees come from the same team and
    teams cycle in lockstep with the position math."""
    _client, headers, _info = auth_client
    pids = [
        _onboard(client, headers, f"r{i}@example.com", f"R{i}")
        for i in range(12)  # 4 teams × 3 people
    ]
    teams = [pids[0:3], pids[3:6], pids[6:9], pids[9:12]]
    s = _create_slot(
        client,
        headers,
        name="EquipoRot",
        days_applied="weekdays",  # Mon-Fri to keep things simple
        staffing_mode="multiple_same",
        headcount=3,
    )
    anchor = date(2026, 5, 4)  # Monday
    client.put(
        f"/api/slots/{s['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0011111,  # Mon-Fri
                    "strategy": "rotation",
                    "anchor_date": anchor.isoformat(),
                    # 4 positions = 4 weekday-block groups (Mon, Tue,
                    # Wed-Thu, Fri) so the cycle math has K=4.
                    "rotation_blocks": [
                        {"position": 0, "days_bitmap": 0b0000001},  # Mon
                        {"position": 1, "days_bitmap": 0b0000010},  # Tue
                        {"position": 2, "days_bitmap": 0b0001100},  # Wed+Thu
                        {"position": 3, "days_bitmap": 0b0010000},  # Fri
                    ],
                    "rotation_members": [
                        {"position": pos, "person_id": pid}
                        for pos in range(4)
                        for pid in teams[pos]
                    ],
                }
            ]
        },
    )
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()

    by_date: dict[str, list[int | None]] = {}
    for a in body["assignments"]:
        if a["slot_name"] == "EquipoRot":
            by_date.setdefault(a["date"], []).append(a["person_id"])

    # Position math: positions_sorted = [0,1,2,3].
    # position = (b_idx + weeks) % P (sprint 17 — was weeks*K+b_idx).
    block_for_weekday = {0: 0, 1: 1, 2: 2, 3: 2, 4: 3}
    P = 4
    for d_iso, got in by_date.items():
        d = date.fromisoformat(d_iso)
        if d.weekday() > 4:
            continue
        weeks = (d - anchor).days // 7
        b_idx = block_for_weekday[d.weekday()]
        position_idx = (b_idx + weeks) % P
        assert len(got) == 3, f"{d_iso} got {got}"
        assert set(got) == set(teams[position_idx]), (
            f"{d_iso} expected team {teams[position_idx]} got {got}"
        )


def test_rotation_team_pre_pins_feed_overlap_constraint(auth_client, client):
    """The critical sprint-14 cross-slot invariant: every member of a
    team rotation must be in the pre-pin set used by the time-overlap
    constraint, not just the first member.

    Setup:
      - Slot X (08-14) Mon: rotation, 1 position with team [A,B,C], hc=3
      - Slot Y (14-20) Mon: solver, hc=1 (no overlap with X)
      - Slot Z (12-16) Mon: solver, hc=1 (overlaps with X)

    Assert:
      - All three of A,B,C are pinned to slot X on Monday.
      - None of A,B,C land on slot Z any Monday (overlap forbidden).
      - At least one of A,B,C may land on slot Y (no overlap allowed).
    """
    _client, headers, _info = auth_client
    p_a = _onboard(client, headers, "ovl_a@example.com", "A")
    p_b = _onboard(client, headers, "ovl_b@example.com", "B")
    p_c = _onboard(client, headers, "ovl_c@example.com", "C")
    # Filler people so slots Y and Z have someone other than A/B/C.
    p_d = _onboard(client, headers, "ovl_d@example.com", "D")
    p_e = _onboard(client, headers, "ovl_e@example.com", "E")

    s_x = _create_slot(
        client,
        headers,
        name="X_pin",
        days_applied="custom",
        custom_days_bitmap=0b0000001,  # Monday only
        staffing_mode="multiple_same",
        headcount=3,
        start_time="08:00:00",
        end_time="14:00:00",
    )
    s_y = _create_slot(
        client,
        headers,
        name="Y_evening",
        days_applied="custom",
        custom_days_bitmap=0b0000001,
        staffing_mode="single",
        headcount=1,
        start_time="14:00:00",
        end_time="20:00:00",
    )
    s_z = _create_slot(
        client,
        headers,
        name="Z_overlap",
        days_applied="custom",
        custom_days_bitmap=0b0000001,
        staffing_mode="single",
        headcount=1,
        start_time="12:00:00",
        end_time="16:00:00",
    )

    anchor = date(2026, 5, 4)  # Monday
    client.put(
        f"/api/slots/{s_x['id']}/rules",
        headers=headers,
        json={
            "rules": [
                {
                    "days_bitmap": 0b0000001,
                    "strategy": "rotation",
                    "anchor_date": anchor.isoformat(),
                    "rotation_blocks": [
                        {"position": 0, "days_bitmap": 0b0000001}
                    ],
                    "rotation_members": [
                        {"position": 0, "person_id": p_a},
                        {"position": 0, "person_id": p_b},
                        {"position": 0, "person_id": p_c},
                    ],
                }
            ]
        },
    )

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()

    team = {p_a, p_b, p_c}
    # p_d, p_e (and the implicit admin user from auth_client) act as
    # fillers for the non-team slots — we don't assert on which one
    # exactly the solver picked, only that the team isn't double-booked.

    x_by_date: dict[str, set[int | None]] = {}
    y_by_date: dict[str, set[int | None]] = {}
    z_by_date: dict[str, set[int | None]] = {}
    for a in body["assignments"]:
        bucket = {
            "X_pin": x_by_date,
            "Y_evening": y_by_date,
            "Z_overlap": z_by_date,
        }.get(a["slot_name"])
        if bucket is not None:
            bucket.setdefault(a["date"], set()).add(a["person_id"])

    assert x_by_date, "rotation slot must have produced assignments"
    for d_iso, pids in x_by_date.items():
        # Whole team pinned every Monday.
        assert team.issubset(pids), f"{d_iso}: X expected {team} got {pids}"

    # On every Monday: Z (overlapping with X) must NOT have any team
    # member — the multi-person pre-pin must feed the overlap constraint.
    for d_iso, pids in z_by_date.items():
        chosen = pids - {None}
        assert chosen.isdisjoint(team), (
            f"{d_iso}: Z assigned a team member {chosen & team}; "
            "multi-person pre-pin overlap missed"
        )

    # Y (no overlap with X) is fine to take a team member or not — just
    # check it didn't go unfilled.
    for d_iso, pids in y_by_date.items():
        assert any(p is not None for p in pids), f"{d_iso}: Y unfilled"

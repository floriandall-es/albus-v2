"""CP-SAT solver tests.

These exist alongside test_scheduler.py: that file's tests covered the
greedy stub but happen to hold for the solver too (skill filter, holidays,
pool, blocks, etc.). This file tests the new things only the solver knows
about: post_slot_rest, guardia_type, FTE-weighted fairness, and the
locked-assignment pinning that lands in Part B.
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


def _set_fte(client, headers, person_id, fte):
    r = client.get("/api/team", headers=headers)
    for m in r.json():
        if m["person_id"] == person_id:
            client.put(
                f"/api/team/{m['id']}", headers=headers, json={"fte_pct": fte}
            )
            return
    raise AssertionError("not found")


def test_solver_post_rest_constraint(auth_client, client):
    _client, headers, _info = auth_client
    pid = _onboard(client, headers, "rest@example.com", "Rest")
    _onboard(client, headers, "buddy@example.com", "Buddy")
    # Slot A: weekdays, post-rest. Slot B: weekdays, no rest.
    _create_slot(client, headers, name="A", post_slot_rest=True, days_applied="all")
    _create_slot(client, headers, name="B", post_slot_rest=False, days_applied="all")

    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    # Build per-person daily slot map.
    by_person: dict[int, dict[str, set[str]]] = {}
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        by_person.setdefault(a["person_id"], {}).setdefault(a["date"], set()).add(
            a["slot_name"]
        )
    # If a person worked slot A on day D, they MUST NOT appear on D+1.
    from datetime import timedelta

    for pid_, days in by_person.items():
        for ds, slots in days.items():
            if "A" not in slots:
                continue
            d = date.fromisoformat(ds)
            next_ds = (d + timedelta(days=1)).isoformat()
            if next_ds in days:
                assert pid_ not in by_person.get(pid_, {}).get(next_ds, set()), (
                    f"{pid_} broke post_slot_rest from {ds}"
                )
                # Person should not have ANY slot on next day.
                # (next_ds present in `days` means they did — fail.)
                raise AssertionError(
                    f"Person {pid_} worked A on {ds} and was scheduled again on {next_ds}"
                )


def test_solver_fairness(auth_client, client):
    _client, headers, _info = auth_client
    p1 = _onboard(client, headers, "f1@example.com", "F1")
    p2 = _onboard(client, headers, "f2@example.com", "F2")
    p3 = _onboard(client, headers, "f3@example.com", "F3")
    _create_slot(client, headers, name="Día", days_applied="all")
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    cnt = Counter(a["person_id"] for a in body["assignments"] if a["person_id"])
    counts = sorted(cnt.values(), reverse=True)
    # 31 days, 4 eligible people (admin + the 3 onboarded). The solver
    # should split close to evenly (±2 of mean) — fairness is FTE-weighted
    # but everyone here is FTE 100.
    assert max(counts) - min(counts) <= 2
    assert sum(counts) == 31
    assert p1 in cnt and p2 in cnt and p3 in cnt


def test_solver_fte_weighted(auth_client, client):
    """A 50% FTE member should get ~half the assignments of a 100% one over
    a long enough horizon. Admin (FTE 100 by default) is also eligible —
    we measure the half-vs-full ratio between the two test members."""
    _client, headers, _info = auth_client
    p100 = _onboard(client, headers, "full@example.com", "Full")
    p50 = _onboard(client, headers, "half@example.com", "Half")
    _set_fte(client, headers, p100, 100)
    _set_fte(client, headers, p50, 50)
    _create_slot(client, headers, name="Día", days_applied="all")
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    cnt = Counter(a["person_id"] for a in body["assignments"] if a["person_id"])
    full = cnt[p100]
    half = cnt[p50]
    # The half-FTE member should have strictly fewer assignments than the
    # full-FTE one. Exact ratio depends on solver tie-breaking + the admin
    # also competing — so just assert ordering + a sane bound.
    assert full > half, f"half={half} full={full}"
    # Half should still get SOME work (not zero — solver must spread).
    assert half >= 3, f"half got too few: {half}"


def test_solver_locked_assignment_preserved(auth_client, client):
    """Pre-existing locked assignment survives a regenerate. Locks live in
    Part B and the lock endpoint isn't here yet — set the lock columns
    directly via SQL to model what Part B will do."""
    _client, headers, info = auth_client
    p1 = _onboard(client, headers, "lk1@example.com", "L1")
    p2 = _onboard(client, headers, "lk2@example.com", "L2")
    _create_slot(client, headers, name="Día", days_applied="all")
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    sid = r.json()["id"]
    # Pick an assignment owned by p1 and lock it.
    target = next(
        a for a in r.json()["assignments"] if a["person_id"] == p1
    )
    aid = target["id"]
    target_date = target["date"]
    # We need lock columns. They land in Part B's migration. Skip if
    # they don't exist yet.
    from sqlalchemy import create_engine, text
    from app.core.config import settings

    eng = create_engine(settings.database_url, future=True)
    with eng.begin() as conn:
        cols = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='assignments'"
            )
        ).scalars().all()
    if "locked_at" not in cols:
        eng.dispose()
        import pytest

        pytest.skip("locked_at column not yet in this migration set")
    with eng.begin() as conn:
        conn.execute(
            text(
                "UPDATE assignments SET locked_at = NOW(), "
                "locked_by_membership_id = :m WHERE id = :i"
            ),
            {"m": info["membership_id"], "i": aid},
        )
    eng.dispose()
    # Regenerate.
    r = client.post(
        "/api/schedules/generate", headers=headers, json={"period": "2026-05-01"}
    )
    body = r.json()
    on_date = [a for a in body["assignments"] if a["date"] == target_date]
    persons_on_date = {a["person_id"] for a in on_date}
    assert p1 in persons_on_date


def test_solver_balances_per_equity_group(auth_client, client):
    """When two slot types have different equity_group_key values, each
    group must balance independently. Without grouping, the solver could
    give person A all of one type and person B all of the other and
    declare the totals "fair" — that is exactly what equity_group_key
    prevents."""
    _client, headers, _info = auth_client
    pid_a = _onboard(client, headers, "alpha@example.com", "Alpha")
    pid_b = _onboard(client, headers, "beta@example.com", "Beta")

    # Two slots, different groups, both single-staff weekdays.
    _create_slot(
        client,
        headers,
        name="Guardia 24h",
        equity_group_key="guardia",
    )
    _create_slot(
        client,
        headers,
        name="Quirofano",
        equity_group_key="quirofano",
    )

    r = client.post(
        "/api/schedules/generate",
        headers=headers,
        json={"period": "2026-05-01"},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()

    # Count assignments per (slot_name, person_id).
    by_slot: dict[str, Counter] = {}
    slot_id_to_name = {}
    for s in client.get("/api/slots", headers=headers).json():
        slot_id_to_name[s["id"]] = s["name"]
    for a in body["assignments"]:
        if a["person_id"] is None:
            continue
        slot_name = slot_id_to_name[a["slot_id"]]
        by_slot.setdefault(slot_name, Counter())[a["person_id"]] += 1

    # In each group separately, the two members should be within 1 of each
    # other. Without grouping, the solver could give A all guardias and B
    # all quirófanos — both groups would have spread = (N, 0) which would
    # fail this assertion.
    for slot_name, counts in by_slot.items():
        a = counts.get(pid_a, 0)
        b = counts.get(pid_b, 0)
        assert abs(a - b) <= 1, (
            f"slot={slot_name} unbalanced: alpha={a} beta={b}"
        )

"""Rule-violation detector for an existing schedule.

The CP-SAT solver enforces every rule by construction when it
builds a schedule. But assignments can also arrive via paths that
bypass the solver:

  - Manual edits in the planning grid (PATCH /assignments)
  - Manual-strategy slots (admin assigns each occurrence by hand)
  - Fixed-weekly / rotation pins that the solver pre-places before
    its constraint pass

This module re-evaluates the same rules against the current set of
assignments and returns a flat list of violations. Used by:

  - GET /api/schedules/{id}/violations → drives the banner + cell
    markers on the admin schedule view
  - PATCH/POST /assignments responses → returns warnings so the
    admin sees what their edit created (warning only, never blocks)

Coverage:

  - **incompatibility** — SlotSuccessionRule with days_after=0
  - **succession**      — SlotSuccessionRule with days_after≥1
  - **frequency**       — SlotFrequencyCap (any period)
  - **time_overlap**    — same person, two slots same day with
                          overlapping wall-clock times
  - **post_rest**       — Slot.post_slot_rest=True on day D, same
                          person assigned on D+1

Soft / hard rule severity is NOT consulted — we surface every
violation regardless. The hard/soft distinction matters to the
solver (hard = constraint, soft = objective penalty); for an
already-saved assignment it's just "is the rule broken?".

Cross-month windows: rolling frequency caps that look back past
the schedule's start are evaluated only against in-period
assignments. A future improvement could load the previous month's
published assignments too; for v1 this matches what the admin
sees on the page.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable

from sqlalchemy.orm import Session

from app.models import (
    Assignment,
    Person,
    Schedule,
    Slot,
    SlotFrequencyCap,
    SlotSuccessionRule,
    SlotTeamRole,
)
from app.services.scheduler import slots_overlap_in_time


# ---------------------------------------------------------------------------
# Output shape — kept as a plain dataclass; the route layer wraps it in a
# Pydantic model for serialization.
# ---------------------------------------------------------------------------


@dataclass
class Violation:
    kind: str  # "incompatibility" | "succession" | "frequency" | "time_overlap" | "post_rest"
    message: str
    # Cells involved in the violation. The frontend uses these to mark
    # the offending grid cells. A violation may involve 1 (freq cap)
    # or 2 (pair-wise) cells; we always list every assignment touched.
    cells: list["ViolationCell"]
    # When the violation comes from a tenant-wide rule row, this is
    # its id — useful for "edit the rule" deep-links from the UI.
    rule_id: int | None = None
    # Hard vs soft severity from the rule definition (the rule still
    # applies regardless; this is only metadata for the UI to colour
    # the banner). None for implicit checks (time_overlap, post_rest)
    # which don't have a rule row.
    severity: str | None = None


@dataclass
class ViolationCell:
    assignment_id: int
    date: date
    slot_id: int
    person_id: int


# ---------------------------------------------------------------------------
# Stable identity for "hide / overrule" suppressions
# ---------------------------------------------------------------------------


def violation_signature(v: Violation) -> str:
    """Stable sha256 hex identifying this violation across reloads
    and (when possible) across schedule regenerations.

    We deliberately exclude `assignment_id` from the signature —
    assignment ids churn on regeneration but the conflict itself is
    really about WHO is doing WHAT on WHICH DAY. Including only
    (date, slot_id, person_id) keeps a hidden conflict hidden if it
    re-appears with new ids; if the regeneration eliminates the
    conflict the suppression simply doesn't match anything and goes
    dormant.

    Canonical JSON: cells sorted by (date, slot_id, person_id) so
    "Pastor + Hernández" and "Hernández + Pastor" hash to the same
    value. `sort_keys=True` covers field ordering. The output is
    64 chars matching the `String(64)` column.
    """
    cells = sorted(
        (
            (c.date.isoformat(), int(c.slot_id), int(c.person_id))
            for c in v.cells
        ),
    )
    canonical = json.dumps(
        {
            "kind": v.kind,
            "cells": cells,
            "rule_id": v.rule_id,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


def find_violations(db: Session, schedule: Schedule) -> list[Violation]:
    """Compute every rule violation in `schedule`'s current assignments.

    Loads only what's needed (assignments + slots + person names +
    succession rules + freq caps) — no solver setup, no CP-SAT, just
    a few cheap queries and a couple of nested loops. Typical schedule
    (40 ppl × 30 days × ~5 slots ≈ 6k assignments) runs in <100ms.
    """
    tenant_id = schedule.tenant_id

    assignments = (
        db.query(Assignment)
        .filter(
            Assignment.schedule_id == schedule.id,
            Assignment.person_id.isnot(None),
        )
        .all()
    )
    if not assignments:
        return []

    slot_ids_used = {a.slot_id for a in assignments}
    slots: dict[int, Slot] = {
        s.id: s
        for s in db.query(Slot)
        .filter(Slot.tenant_id == tenant_id, Slot.id.in_(slot_ids_used))
        .all()
    }

    person_ids_used = {a.person_id for a in assignments if a.person_id}
    person_name_by_id: dict[int, str] = {
        pid: name
        for pid, name in db.query(Person.id, Person.name)
        .filter(Person.id.in_(person_ids_used))
        .all()
    }

    succession_rules = (
        db.query(SlotSuccessionRule)
        .filter(SlotSuccessionRule.tenant_id == tenant_id)
        .all()
    )
    freq_caps = (
        db.query(SlotFrequencyCap)
        .filter(SlotFrequencyCap.tenant_id == tenant_id)
        .all()
    )

    # Resolve team-role labels for richer messages. Only fetched when
    # at least one rule has a role filter, otherwise skip the query.
    team_role_labels: dict[int, str] = {}
    role_ids = {
        r.after_team_role_id for r in succession_rules if r.after_team_role_id
    } | {
        r.forbid_team_role_id for r in succession_rules if r.forbid_team_role_id
    } | {
        c.team_role_id for c in freq_caps if c.team_role_id
    }
    if role_ids:
        team_role_labels = {
            tr.id: tr.role_label
            for tr in db.query(SlotTeamRole).filter(SlotTeamRole.id.in_(role_ids))
        }

    out: list[Violation] = []
    out.extend(
        _check_succession_rules(
            assignments, slots, succession_rules,
            person_name_by_id, team_role_labels,
        )
    )
    out.extend(
        _check_frequency_caps(
            assignments, slots, freq_caps,
            person_name_by_id, team_role_labels,
        )
    )
    out.extend(
        _check_time_overlap(assignments, slots, person_name_by_id)
    )
    out.extend(
        _check_post_shift_rest(assignments, slots, person_name_by_id)
    )
    return out


# ---------------------------------------------------------------------------
# Rule-by-rule checkers
# ---------------------------------------------------------------------------


def _person_label(person_id: int, names: dict[int, str]) -> str:
    return names.get(person_id) or f"Persona #{person_id}"


def _slot_label(slot_id: int, slots: dict[int, Slot]) -> str:
    s = slots.get(slot_id)
    return s.name if s else f"Slot #{slot_id}"


def _role_label(role_id: int | None, labels: dict[int, str]) -> str:
    if role_id is None:
        return ""
    return f" ({labels.get(role_id, f'#{role_id}')})"


def _check_succession_rules(
    assignments: list[Assignment],
    slots: dict[int, Slot],
    rules: list[SlotSuccessionRule],
    names: dict[int, str],
    role_labels: dict[int, str],
) -> Iterable[Violation]:
    """SlotSuccessionRule covers two distinct UX concepts:

      - days_after=0  → same-day incompatibility (kind="incompatibility")
      - days_after>=1 → "tras X, no se puede Y durante N días" (kind="succession")

    Both share the same logic: for each rule, scan all (after, forbid)
    assignment pairs that fall inside the rule's day-offset window. If
    `applies_to='same_person'`, both sides must belong to the same
    person; if 'whole_team', any pair counts.
    """
    # Index by (slot_id, role_filter): role_filter=None means "any role
    # of the slot". We always include the slot-wide bucket so a
    # role-less rule matches assignments that DO have a role set.
    by_slot_role: dict[tuple[int, int | None], list[Assignment]] = defaultdict(list)
    for a in assignments:
        by_slot_role[(a.slot_id, None)].append(a)
        if a.team_role_id is not None:
            by_slot_role[(a.slot_id, a.team_role_id)].append(a)

    for rule in rules:
        offsets = (
            [0]
            if rule.days_after == 0
            else list(range(1, rule.days_after + 1))
        )
        after_pool = by_slot_role.get(
            (rule.after_slot_id, rule.after_team_role_id), []
        )
        forbid_pool = by_slot_role.get(
            (rule.forbid_slot_id, rule.forbid_team_role_id), []
        )
        if not after_pool or not forbid_pool:
            continue

        # Group forbid_pool by date for cheap offset lookups.
        forbid_by_date: dict[date, list[Assignment]] = defaultdict(list)
        for f in forbid_pool:
            forbid_by_date[f.date].append(f)

        for a in after_pool:
            for offset in offsets:
                target_date = a.date + timedelta(days=offset)
                for f in forbid_by_date.get(target_date, []):
                    if rule.applies_to == "same_person" and a.person_id != f.person_id:
                        continue
                    # Self-referential same-day rule (after_slot ==
                    # forbid_slot, days_after=0): after_pool and
                    # forbid_pool are the SAME list, so iterating both
                    # would emit each (a, f) pair twice (once as a→f
                    # and once as f→a). Skip the higher-id side.
                    #
                    # Cross-slot rules (the normal case) don't need
                    # this — `a` always comes from `after_slot` and
                    # `f` from `forbid_slot`, so each pair shows up
                    # exactly once. Earlier versions applied the
                    # id-ordering check unconditionally, which
                    # silently dropped same-day cross-slot conflicts
                    # whenever the assignment ids happened to land
                    # in the "wrong" order (e.g. rotation pre-pinning
                    # made the Consulta row's id higher than the
                    # Quirófano row's id, hiding Consulta+Quirófano).
                    if (
                        rule.days_after == 0
                        and rule.after_slot_id == rule.forbid_slot_id
                        and rule.after_team_role_id == rule.forbid_team_role_id
                        and a.id >= f.id
                    ):
                        continue
                    msg = _format_succession_message(
                        rule, a, f, slots, names, role_labels
                    )
                    yield Violation(
                        kind=(
                            "incompatibility"
                            if rule.days_after == 0
                            else "succession"
                        ),
                        message=msg,
                        cells=[
                            ViolationCell(
                                assignment_id=a.id,
                                date=a.date,
                                slot_id=a.slot_id,
                                person_id=a.person_id,
                            ),
                            ViolationCell(
                                assignment_id=f.id,
                                date=f.date,
                                slot_id=f.slot_id,
                                person_id=f.person_id,
                            ),
                        ],
                        rule_id=rule.id,
                        severity=rule.severity,
                    )


def _format_succession_message(
    rule: SlotSuccessionRule,
    a: Assignment,
    f: Assignment,
    slots: dict[int, Slot],
    names: dict[int, str],
    role_labels: dict[int, str],
) -> str:
    a_slot = _slot_label(a.slot_id, slots) + _role_label(rule.after_team_role_id, role_labels)
    f_slot = _slot_label(f.slot_id, slots) + _role_label(rule.forbid_team_role_id, role_labels)
    if rule.days_after == 0:
        # Same-day incompatibility — same person doubled up.
        person = _person_label(a.person_id, names)
        return f"{person}: {a_slot} y {f_slot} el mismo día ({a.date.isoformat()})"
    person = _person_label(a.person_id, names)
    return (
        f"{person}: tras {a_slot} el {a.date.isoformat()} no debería hacer "
        f"{f_slot} en {rule.days_after} día(s) — encontrado el {f.date.isoformat()}"
    )


def _check_frequency_caps(
    assignments: list[Assignment],
    slots: dict[int, Slot],
    caps: list[SlotFrequencyCap],
    names: dict[int, str],
    role_labels: dict[int, str],
) -> Iterable[Violation]:
    """Count assignments per (person, slot, optional role) over each
    cap's window. If the count exceeds `max_count`, emit one violation
    citing every assignment in the offending window.

    NB on rolling windows: this only sees in-schedule assignments.
    A rolling_28 cap whose window starts before the schedule's first
    day undercounts by the assignments that pre-date the schedule.
    Cross-month back-fill is out of scope for v1.
    """
    for cap in caps:
        # Filter to assignments of this slot (and role, if set).
        relevant = [
            a
            for a in assignments
            if a.slot_id == cap.slot_id
            and (cap.team_role_id is None or a.team_role_id == cap.team_role_id)
        ]
        if not relevant:
            continue

        # Group by person.
        by_person: dict[int, list[Assignment]] = defaultdict(list)
        for a in relevant:
            by_person[a.person_id].append(a)

        for pid, items in by_person.items():
            items.sort(key=lambda x: x.date)
            offenders = _windows_over_cap(items, cap)
            for window_items in offenders:
                yield Violation(
                    kind="frequency",
                    message=_format_freq_message(
                        cap, pid, window_items, slots, names, role_labels
                    ),
                    cells=[
                        ViolationCell(
                            assignment_id=a.id,
                            date=a.date,
                            slot_id=a.slot_id,
                            person_id=a.person_id,
                        )
                        for a in window_items
                    ],
                    rule_id=cap.id,
                    severity=cap.severity,
                )


def _windows_over_cap(
    items: list[Assignment], cap: SlotFrequencyCap
) -> list[list[Assignment]]:
    """Return one window per offending span.

    For rolling windows: sliding N-day window anchored on each
    assignment date; emit the window if count > max. De-duplicate
    so the same overflow doesn't get emitted N times for the N
    days it overlaps.

    For iso_week / calendar_month: bucket by week or month; emit
    each bucket where count > max.
    """
    if cap.period.startswith("rolling_"):
        n_days = int(cap.period.split("_")[1])
        out: list[list[Assignment]] = []
        seen_keys: set[tuple[int, ...]] = set()
        for i, anchor in enumerate(items):
            window_start = anchor.date - timedelta(days=n_days - 1)
            window = [
                x for x in items if window_start <= x.date <= anchor.date
            ]
            if len(window) > cap.max_count:
                key = tuple(sorted(x.id for x in window))
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                out.append(window)
        return out
    # iso_week / calendar_month: simple bucketed counting.
    buckets: dict[tuple[int, int], list[Assignment]] = defaultdict(list)
    if cap.period == "iso_week":
        for a in items:
            iso = a.date.isocalendar()
            buckets[(iso.year, iso.week)].append(a)
    elif cap.period == "calendar_month":
        for a in items:
            buckets[(a.date.year, a.date.month)].append(a)
    else:
        return []
    return [bucket for bucket in buckets.values() if len(bucket) > cap.max_count]


def _format_freq_message(
    cap: SlotFrequencyCap,
    person_id: int,
    items: list[Assignment],
    slots: dict[int, Slot],
    names: dict[int, str],
    role_labels: dict[int, str],
) -> str:
    person = _person_label(person_id, names)
    slot = _slot_label(cap.slot_id, slots) + _role_label(cap.team_role_id, role_labels)
    period_label = {
        "rolling_7": "en 7 días",
        "rolling_14": "en 14 días",
        "rolling_28": "en 28 días",
        "iso_week": "por semana",
        "calendar_month": "por mes",
    }.get(cap.period, cap.period)
    return (
        f"{person}: {len(items)} {slot} {period_label} — el máximo configurado es {cap.max_count}"
    )


def _check_time_overlap(
    assignments: list[Assignment],
    slots: dict[int, Slot],
    names: dict[int, str],
) -> Iterable[Violation]:
    """Same person, two slots whose wall-clock times overlap on the
    same date (or D / D+1 when one slot crosses midnight).

    Uses the same `slots_overlap_in_time` helper the solver uses, so
    the two stay in lockstep on edge cases like 22:00–08:00.
    """
    # Group by person, then by date.
    by_person_date: dict[tuple[int, date], list[Assignment]] = defaultdict(list)
    for a in assignments:
        by_person_date[(a.person_id, a.date)].append(a)
        # Also surface in the previous day's bucket for overnight slots
        # — the overlap check itself handles D vs D+1 either way.

    seen_pairs: set[tuple[int, int]] = set()
    for (pid, _d), items in by_person_date.items():
        # Compare each assignment to every other for the same person
        # within ±1 day, to catch overnight overlaps.
        for a in items:
            a_slot = slots.get(a.slot_id)
            if a_slot is None:
                continue
            for other_d in (a.date, a.date + timedelta(days=1)):
                for b in by_person_date.get((pid, other_d), []):
                    if b.id == a.id:
                        continue
                    pair = tuple(sorted([a.id, b.id]))
                    if pair in seen_pairs:
                        continue
                    b_slot = slots.get(b.slot_id)
                    if b_slot is None:
                        continue
                    if not slots_overlap_in_time(a_slot, a.date, b_slot, b.date):
                        continue
                    seen_pairs.add(pair)
                    person = _person_label(pid, names)
                    yield Violation(
                        kind="time_overlap",
                        message=(
                            f"{person}: {a_slot.name} y {b_slot.name} "
                            f"se solapan en horario el {a.date.isoformat()}"
                        ),
                        cells=[
                            ViolationCell(
                                assignment_id=a.id,
                                date=a.date,
                                slot_id=a.slot_id,
                                person_id=pid,
                            ),
                            ViolationCell(
                                assignment_id=b.id,
                                date=b.date,
                                slot_id=b.slot_id,
                                person_id=pid,
                            ),
                        ],
                    )


def _check_post_shift_rest(
    assignments: list[Assignment],
    slots: dict[int, Slot],
    names: dict[int, str],
) -> Iterable[Violation]:
    """If slot S has post_slot_rest=True, no assignments for the same
    person on D+1 after S on day D.

    The column is soft-deprecated from the UI (sprint 25) — new slots
    leave it false — but historical slots may still have it true and
    the solver still treats it as a hard constraint. We surface the
    violation so the admin can see the mismatch.
    """
    # Build (person, date) → assignments
    by_person_date: dict[tuple[int, date], list[Assignment]] = defaultdict(list)
    for a in assignments:
        by_person_date[(a.person_id, a.date)].append(a)

    for a in assignments:
        slot = slots.get(a.slot_id)
        if slot is None or not slot.post_slot_rest:
            continue
        next_day = a.date + timedelta(days=1)
        for b in by_person_date.get((a.person_id, next_day), []):
            person = _person_label(a.person_id, names)
            yield Violation(
                kind="post_rest",
                message=(
                    f"{person}: descanso post-guardia tras "
                    f"{slot.name} ({a.date.isoformat()}) violado por "
                    f"{slots.get(b.slot_id).name if slots.get(b.slot_id) else 'turno'} "
                    f"el {b.date.isoformat()}"
                ),
                cells=[
                    ViolationCell(
                        assignment_id=a.id,
                        date=a.date,
                        slot_id=a.slot_id,
                        person_id=a.person_id,
                    ),
                    ViolationCell(
                        assignment_id=b.id,
                        date=b.date,
                        slot_id=b.slot_id,
                        person_id=b.person_id,
                    ),
                ],
            )

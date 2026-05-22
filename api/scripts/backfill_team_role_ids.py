"""Backfill team_role_id on migrated Assignment rows.

Historical assignments imported before the team_composition
restructure (task #71) ended up with team_role_id = NULL even
though the slots they belong to are now team_composition with
named roles (Cirujano 1/2, Explante, Implante 1/2). The planning
grid keys rows by (slot_id, team_role_label) so those legacy
rows collapse into ONE row labelled just "Trasplante" / "Quirófano"
instead of the per-role rows the newly generated schedules show.

This script walks every team_composition slot in the target
tenant, finds each (schedule_id, slot_id, date) group of
NULL-role assignments, and distributes them across the slot's
SlotTeamRole rows by id-order. We don't have historical "who did
which role" data, so the assignment is deterministic but
arbitrary — the goal is just to make the grid show role labels
on existing data, matching what new generations produce.

Usage (from `api/`):

    python -m scripts.backfill_team_role_ids \\
        --tenant-slug cirugia-toracica-hospital-la-fe

Add --commit to actually write; default is dry-run.

Safety guards:
  - Only touches rows where team_role_id IS NULL on slots whose
    staffing_mode is currently "team_composition".
  - Idempotent: re-runs are no-ops because the first run set the
    team_role_id and the WHERE clause skips them next time.
  - Doesn't touch person_id, locked_at, dismissed_at, notes, etc.
  - Refuses to run if a (schedule, slot, date) group has MORE
    NULL rows than the slot has team_role demand slots (suggests
    something other than migration legacy and shouldn't be
    silently rebalanced).
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict

from sqlalchemy.orm import Session

from app.db.session import SessionLocal, set_tenant
from app.models import Assignment, Slot, SlotTeamRole, Tenant


def _resolve_tenant(db: Session, slug: str) -> Tenant:
    t = db.query(Tenant).filter(Tenant.slug == slug).first()
    if t is None:
        raise SystemExit(f"No tenant found with slug={slug!r}")
    return t


def backfill(db: Session, tenant: Tenant, *, commit: bool) -> dict:
    set_tenant(db, tenant.id)
    report: dict = {
        "tenant_id": tenant.id,
        "tenant_slug": tenant.slug,
        "commit": commit,
        "slots_scanned": 0,
        "groups_examined": 0,
        "rows_backfilled": 0,
        "groups_skipped_too_many": 0,
        "groups_skipped_no_demand": 0,
        "by_slot": defaultdict(int),
    }
    # Every team_composition slot in this tenant. RLS narrows by
    # tenant_id automatically via set_tenant() above.
    tc_slots = (
        db.query(Slot)
        .filter(Slot.staffing_mode == "team_composition")
        .all()
    )
    report["slots_scanned"] = len(tc_slots)
    for slot in tc_slots:
        # Demand-slot vector: each role contributes role.headcount
        # entries, ordered by team_role id so the backfill is
        # deterministic across runs.
        roles = (
            db.query(SlotTeamRole)
            .filter(SlotTeamRole.slot_id == slot.id)
            .order_by(SlotTeamRole.id)
            .all()
        )
        if not roles:
            report["groups_skipped_no_demand"] += 1
            continue
        demand: list[SlotTeamRole] = []
        for r in roles:
            for _ in range(max(1, r.headcount)):
                demand.append(r)
        # Every NULL-role assignment on this slot, grouped by
        # (schedule_id, date).
        rows = (
            db.query(Assignment)
            .filter(
                Assignment.slot_id == slot.id,
                Assignment.team_role_id.is_(None),
            )
            .order_by(Assignment.id)
            .all()
        )
        by_group: dict[tuple[int, object], list[Assignment]] = defaultdict(list)
        for a in rows:
            by_group[(a.schedule_id, a.date)].append(a)
        for key, group in by_group.items():
            report["groups_examined"] += 1
            if len(group) > len(demand):
                report["groups_skipped_too_many"] += 1
                continue
            for assignment, role in zip(group, demand):
                assignment.team_role_id = role.id
                report["rows_backfilled"] += 1
                report["by_slot"][slot.name] += 1

    if commit:
        db.commit()
    else:
        db.rollback()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-slug", required=True)
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Actually write the changes. Default is dry-run.",
    )
    args = parser.parse_args()

    with SessionLocal() as db:
        tenant = _resolve_tenant(db, args.tenant_slug)
        report = backfill(db, tenant, commit=args.commit)

    mode = "COMMITTED" if args.commit else "DRY-RUN (no changes saved)"
    print(f"=== Backfill team_role_id — {mode} ===")
    print(f"tenant: id={report['tenant_id']} slug={report['tenant_slug']}")
    print(f"team_composition slots scanned : {report['slots_scanned']}")
    print(f"(schedule, slot, date) groups  : {report['groups_examined']}")
    print(f"rows backfilled                : {report['rows_backfilled']}")
    if report["groups_skipped_too_many"]:
        print(
            "groups skipped (too many rows): "
            f"{report['groups_skipped_too_many']} "
            "(more NULL rows than slot has demand slots — investigate)"
        )
    if report["groups_skipped_no_demand"]:
        print(
            "slots skipped (no team_roles)  : "
            f"{report['groups_skipped_no_demand']}"
        )
    if report["by_slot"]:
        print("by slot:")
        for name, n in sorted(report["by_slot"].items()):
            print(f"  - {name}: {n}")
    if not args.commit and report["rows_backfilled"]:
        print("\nRe-run with --commit to persist these changes.")


if __name__ == "__main__":
    sys.exit(main() or 0)

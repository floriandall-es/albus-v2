"""Phase B dry-run — what does the residentes → peer-tenant
migration actually look like on this database?

Read-only inspection of every `groups` row, showing what would
move where + flagging edge cases that need surgical attention.
NO writes — safe to run any time.

Run with:
    cd api && python -m scripts.equipos_phase_b_dry_run

The script uses AdminSessionLocal (owner role) so RLS doesn't
hide anything, since the migration itself will need owner-level
access too.

Output sections per group:
  - identity (which tenant + hospital + servicio it currently lives under)
  - slots that would move
  - memberships that would move + which carry the 'lead' role
  - dual-membership warnings (person also has main-team membership)
  - categories referenced by those memberships → need copying to the new tenant
  - schedules whose assignments would split out into a new Schedule under the new tenant
  - ScheduleGroupPublication rows that translate to the new Schedule's status
  - bloqueos (AvailabilityBlock) by group members
  - meetings that include this group as an audience target

Plus a sanity-check footer that surfaces any data inconsistencies
the migration script will need to refuse to run on.
"""

from __future__ import annotations

import os
import sys
from collections import defaultdict

# Import path: this file lives in api/scripts/, so `app.*` is one
# level up. The same pattern other scripts in this directory use.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import func

from app.db.session import AdminSessionLocal
from app.models import (
    Assignment,
    AvailabilityBlock,
    Category,
    Group,
    Hospital,
    Meeting,
    MeetingAudienceGroup,
    Membership,
    Person,
    Schedule,
    ScheduleGroupPublication,
    Servicio,
    ShiftSwapOffer,
    Slot,
    Tenant,
)


# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------


def hr(char: str = "=") -> str:
    return char * 72


def section(title: str) -> None:
    print()
    print(hr())
    print(title)
    print(hr())


def warn(msg: str) -> None:
    print(f"  ⚠  {msg}")


def ok(msg: str) -> None:
    print(f"  ✓  {msg}")


def info(msg: str, indent: int = 2) -> None:
    print(" " * indent + msg)


# ---------------------------------------------------------------------------
# Per-group inspection
# ---------------------------------------------------------------------------


def inspect_group(db, group: Group) -> dict:
    """Return a stats dict for the summary while printing details."""
    section(f"GROUP #{group.id}: {group.name!r}")

    stats = {
        "group_id": group.id,
        "group_name": group.name,
        "slots": 0,
        "memberships": 0,
        "lead_memberships": 0,
        "dual_membership_persons": 0,
        "categories_to_copy": 0,
        "schedules_to_split": 0,
        "publications": 0,
        "bloqueos": 0,
        "audience_meetings": 0,
        "warnings": [],
    }

    # ------------------------------------------------------------
    # Parent tenant + servicio context
    # ------------------------------------------------------------
    parent = db.get(Tenant, group.tenant_id)
    if parent is None:
        warn(f"parent tenant id={group.tenant_id} does not exist — orphan group!")
        stats["warnings"].append("orphan-group")
        return stats
    info(f"parent_tenant   id={parent.id}  name={parent.name!r}")
    info(f"hospital_id     {parent.hospital_id}")
    info(f"servicio_id     {parent.servicio_id}")
    if parent.hospital_id is None:
        warn("parent tenant has hospital_id=NULL — Phase A 0069 backfill skipped it. "
             "Operator must attach a hospital before Phase B can run.")
        stats["warnings"].append("parent-no-hospital")
    if parent.servicio_id is None:
        warn("parent tenant has servicio_id=NULL — Phase A 0069 didn't link it. "
             "Operator must run the servicio backfill manually first.")
        stats["warnings"].append("parent-no-servicio")
    if parent.servicio_id is not None:
        sv = db.get(Servicio, parent.servicio_id)
        if sv is not None:
            info(f"servicio_name   {sv.name!r}  (hospital_id={sv.hospital_id})")

    # ------------------------------------------------------------
    # Slots that would move
    # ------------------------------------------------------------
    slots = db.query(Slot).filter(Slot.group_id == group.id).all()
    stats["slots"] = len(slots)
    print()
    info(f"Slots to move ({len(slots)}):")
    for s in slots:
        info(
            f"  - id={s.id}  name={s.name!r}  mode={s.staffing_mode}  position={s.position}",
            indent=2,
        )

    # ------------------------------------------------------------
    # Lead — stored as Group.lead_membership_id, NOT as a string in
    # Membership.roles. The lead's own membership may sit in the
    # main team (group_id IS NULL) — i.e. someone from the adjuntos
    # who oversees the residentes — or it may belong to the group
    # itself. Both are valid; the migration treats them differently.
    # ------------------------------------------------------------
    lead_person_id: int | None = None
    if group.lead_membership_id is not None:
        lead_mem = db.get(Membership, group.lead_membership_id)
        if lead_mem is None:
            warn(f"group.lead_membership_id={group.lead_membership_id} "
                 "doesn't resolve to a Membership row — orphan FK")
            stats["warnings"].append("orphan-lead-fk")
        else:
            lead_person = db.get(Person, lead_mem.person_id)
            lead_person_id = lead_mem.person_id
            scope_label = (
                "main-team member"
                if lead_mem.group_id is None
                else f"group member (group_id={lead_mem.group_id})"
            )
            print()
            info("Lead:")
            info(
                f"  - person={lead_person.name if lead_person else '???'!r}  "
                f"membership_id={lead_mem.id}  "
                f"tenant_id={lead_mem.tenant_id}  "
                f"scope={scope_label}",
                indent=2,
            )
            stats["lead_memberships"] = 1
            if lead_mem.tenant_id != group.tenant_id:
                warn(f"lead membership tenant_id={lead_mem.tenant_id} ≠ "
                     f"group.tenant_id={group.tenant_id} — unusual, verify "
                     "this is intentional")
                stats["warnings"].append("lead-cross-tenant")
    else:
        info("Lead: (none assigned)")
        warn("This group has no lead. The migration will copy the parent "
             "tenant's admins into the new tenant as admins. The residentes "
             "can promote one of their own later.")
        stats["warnings"].append("no-lead")

    # ------------------------------------------------------------
    # Memberships that would move
    # ------------------------------------------------------------
    members = db.query(Membership).filter(Membership.group_id == group.id).all()
    stats["memberships"] = len(members)
    print()
    info(f"Memberships to move ({len(members)}):")
    member_person_ids: set[int] = set()
    cat_ids: set[int] = set()
    for m in members:
        member_person_ids.add(m.person_id)
        if m.category_id is not None:
            cat_ids.add(m.category_id)
        p = db.get(Person, m.person_id)
        roles = ",".join(m.roles or [])
        is_lead_membership = m.id == group.lead_membership_id
        marker = "  [LEAD]" if is_lead_membership else ""
        disabled = "  [disabled]" if m.disabled_at else ""
        info(
            f"  - membership_id={m.id}  person={p.name if p else '???'!r}  "
            f"roles=[{roles}]{marker}{disabled}",
            indent=2,
        )

    # ------------------------------------------------------------
    # Dual-membership: persons who ALSO have a main-team membership
    # ------------------------------------------------------------
    if member_person_ids:
        duals = (
            db.query(Membership)
            .filter(
                Membership.tenant_id == group.tenant_id,
                Membership.person_id.in_(member_person_ids),
                Membership.group_id.is_(None),
            )
            .all()
        )
        if duals:
            stats["dual_membership_persons"] = len(duals)
            print()
            info(f"Dual-membership persons ({len(duals)}):")
            for m in duals:
                p = db.get(Person, m.person_id)
                roles = ",".join(m.roles or [])
                info(
                    f"  - person={p.name if p else '???'!r}  "
                    f"main-membership_id={m.id}  roles=[{roles}]",
                    indent=2,
                )
            warn("These persons have BOTH a main-team membership AND a group "
                 "membership in the parent tenant. The migration will keep their "
                 "main-team row in place and create a fresh membership in the new "
                 "tenant for the group side (so they become full members of both).")

    # ------------------------------------------------------------
    # Categories referenced by migrating members
    # ------------------------------------------------------------
    if cat_ids:
        cats = db.query(Category).filter(Category.id.in_(cat_ids)).all()
        stats["categories_to_copy"] = len(cats)
        print()
        info(f"Categories used by group members ({len(cats)}):")
        for c in cats:
            # Count main-team members using the same category — if zero,
            # the category could be moved instead of copied (cleaner).
            main_use = (
                db.query(func.count(Membership.id))
                .filter(
                    Membership.tenant_id == group.tenant_id,
                    Membership.group_id.is_(None),
                    Membership.category_id == c.id,
                )
                .scalar()
                or 0
            )
            shared = " (also used by main team — must COPY)" if main_use > 0 else " (only this group — could MOVE)"
            info(f"  - id={c.id}  name={c.name!r}{shared}", indent=2)

    # ------------------------------------------------------------
    # Schedules + assignments to split
    # ------------------------------------------------------------
    schedule_rows = (
        db.query(
            Schedule.id,
            Schedule.period,
            Schedule.status,
            func.count(Assignment.id),
        )
        .join(Assignment, Assignment.schedule_id == Schedule.id)
        .join(Slot, Slot.id == Assignment.slot_id)
        .filter(Slot.group_id == group.id)
        .group_by(Schedule.id, Schedule.period, Schedule.status)
        .order_by(Schedule.period)
        .all()
    )
    stats["schedules_to_split"] = len(schedule_rows)
    print()
    info(f"Schedules with group assignments ({len(schedule_rows)}):")
    for sid, period, status, count in schedule_rows:
        info(
            f"  - schedule_id={sid}  period={period.isoformat()}  status={status}  "
            f"assignments={count}",
            indent=2,
        )

    # ------------------------------------------------------------
    # Per-group publication state
    # ------------------------------------------------------------
    pubs = (
        db.query(ScheduleGroupPublication)
        .filter(ScheduleGroupPublication.group_id == group.id)
        .all()
    )
    stats["publications"] = len(pubs)
    if pubs:
        print()
        info(f"Group publication rows ({len(pubs)}):")
        for p in pubs:
            s = db.get(Schedule, p.schedule_id)
            period = s.period.isoformat() if s else "???"
            info(
                f"  - schedule_id={p.schedule_id}  period={period}  "
                f"published_at={p.published_at.isoformat()}",
                indent=2,
            )

    # ------------------------------------------------------------
    # Bloqueos by group members
    # ------------------------------------------------------------
    if member_person_ids:
        bloqueos = (
            db.query(AvailabilityBlock.status, func.count(AvailabilityBlock.id))
            .filter(
                AvailabilityBlock.tenant_id == group.tenant_id,
                AvailabilityBlock.person_id.in_(member_person_ids),
            )
            .group_by(AvailabilityBlock.status)
            .all()
        )
        total_bloqueos = sum(c for _, c in bloqueos)
        stats["bloqueos"] = total_bloqueos
        if total_bloqueos:
            print()
            info(f"Bloqueos by group members ({total_bloqueos}):")
            for status, count in bloqueos:
                info(f"  - {status}: {count}", indent=2)
            warn("Decision: do these bloqueos move to the new tenant, or stay "
                 "in the parent tenant? Recommendation: MOVE (they're scoped to "
                 "the person + tenant; the person's tenant changes). Dual-"
                 "membership cases may need duplication.")

    # ------------------------------------------------------------
    # Shift swap offers attached to assignments that will move
    # ------------------------------------------------------------
    # The model keys swap offers off (tenant_id, assignment_id,
    # requested_by_membership_id) — there is no requester_person_id
    # column. We care about offers tied to assignments on slots
    # owned by this group; those follow the assignments when the
    # migration moves them.
    swap_rows = (
        db.query(
            ShiftSwapOffer.status,
            func.count(ShiftSwapOffer.id),
        )
        .join(Assignment, Assignment.id == ShiftSwapOffer.assignment_id)
        .join(Slot, Slot.id == Assignment.slot_id)
        .filter(Slot.group_id == group.id)
        .group_by(ShiftSwapOffer.status)
        .all()
    )
    total_swaps = sum(c for _, c in swap_rows)
    if total_swaps:
        print()
        info(f"Shift swap offers on group assignments ({total_swaps}):")
        for status, count in swap_rows:
            info(f"  - {status}: {count}", indent=2)
        warn("Open swap offers follow their assignment when it moves to the "
             "new tenant. Closed/cancelled rows are history only. Consider "
             "cancelling any 'open' offers before running Phase B to keep "
             "the audience semantics clean.")

    # ------------------------------------------------------------
    # Meetings that include this group as audience
    # ------------------------------------------------------------
    audience_meetings = (
        db.query(Meeting.id, Meeting.title)
        .join(MeetingAudienceGroup, MeetingAudienceGroup.meeting_id == Meeting.id)
        .filter(MeetingAudienceGroup.group_id == group.id)
        .all()
    )
    stats["audience_meetings"] = len(audience_meetings)
    if audience_meetings:
        print()
        info(f"Meetings targeting this group in audience ({len(audience_meetings)}):")
        for mid, title in audience_meetings:
            info(f"  - meeting_id={mid}  title={title!r}", indent=2)
        warn("After Phase B the MeetingAudienceGroup rows will dangle (the "
             "group no longer exists). Phase C must translate them: turn each "
             "'group X is invited' into 'every member of new tenant X is "
             "invited' via MeetingAudiencePerson or a tenant-level audience "
             "concept (TBD when meetings get the cross-tenant invite support).")

    return stats


# ---------------------------------------------------------------------------
# Sanity checks across the whole DB
# ---------------------------------------------------------------------------


def global_sanity_checks(db) -> None:
    section("SANITY CHECKS")

    # 1. Every Assignment's tenant_id should match its slot's tenant_id.
    #    If not, our "move slot → move assignment" step will be wrong.
    mismatches = (
        db.query(
            Assignment.id,
            Assignment.tenant_id,
            Slot.tenant_id,
        )
        .join(Slot, Slot.id == Assignment.slot_id)
        .filter(Assignment.tenant_id != Slot.tenant_id)
        .limit(20)
        .all()
    )
    if mismatches:
        warn(f"{len(mismatches)}+ assignments where assignment.tenant_id ≠ slot.tenant_id")
        for aid, atid, stid in mismatches:
            info(f"  - assignment_id={aid}  assignment.tenant_id={atid}  slot.tenant_id={stid}",
                 indent=2)
    else:
        ok("All assignments have tenant_id matching their slot's tenant_id")

    # 2. Every Membership.group_id points at a group whose tenant_id
    #    matches the membership's tenant_id.
    bad_memberships = (
        db.query(Membership.id, Membership.tenant_id, Group.id, Group.tenant_id)
        .join(Group, Group.id == Membership.group_id)
        .filter(Membership.tenant_id != Group.tenant_id)
        .limit(20)
        .all()
    )
    if bad_memberships:
        warn(f"{len(bad_memberships)}+ memberships where membership.tenant_id ≠ group.tenant_id")
        for mid, mtid, gid, gtid in bad_memberships:
            info(f"  - membership_id={mid}  m.tenant_id={mtid}  group_id={gid}  g.tenant_id={gtid}",
                 indent=2)
    else:
        ok("All group memberships have matching tenant_id")

    # 3. Every Slot.group_id points at a group whose tenant_id matches
    #    the slot's tenant_id.
    bad_slots = (
        db.query(Slot.id, Slot.tenant_id, Group.id, Group.tenant_id)
        .join(Group, Group.id == Slot.group_id)
        .filter(Slot.tenant_id != Group.tenant_id)
        .limit(20)
        .all()
    )
    if bad_slots:
        warn(f"{len(bad_slots)}+ slots where slot.tenant_id ≠ group.tenant_id")
        for sid, stid, gid, gtid in bad_slots:
            info(f"  - slot_id={sid}  s.tenant_id={stid}  group_id={gid}  g.tenant_id={gtid}",
                 indent=2)
    else:
        ok("All group slots have matching tenant_id")

    # 4. servicio_id backfill from Phase A (migration 0069) covered
    #    every tenant with a hospital_id.
    orphan_tenants = (
        db.query(Tenant.id, Tenant.name)
        .filter(Tenant.hospital_id.isnot(None), Tenant.servicio_id.is_(None))
        .all()
    )
    if orphan_tenants:
        warn(f"{len(orphan_tenants)} tenant(s) with a hospital_id but no servicio_id")
        for tid, name in orphan_tenants:
            info(f"  - tenant_id={tid}  name={name!r}", indent=2)
        info("  → re-run the migration 0069 backfill to clear this.", indent=4)
    else:
        ok("All hospital-linked tenants have a servicio_id (Phase A backfill OK)")

    # 5. Tenants without a hospital_id at all — these are leftovers
    #    from pre-sprint-28 and can't enter the new model until
    #    an operator attaches a hospital.
    no_hospital = db.query(Tenant.id, Tenant.name).filter(Tenant.hospital_id.is_(None)).all()
    if no_hospital:
        warn(f"{len(no_hospital)} tenant(s) with hospital_id=NULL — these are "
             "outside the new model and Phase D signup will reject creating "
             "more like them. Attach hospitals before Phase B if any need to "
             "be migrated.")
        for tid, name in no_hospital:
            info(f"  - tenant_id={tid}  name={name!r}", indent=2)
    else:
        ok("Every tenant has a hospital_id")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    db = AdminSessionLocal()
    try:
        section("PHASE B DRY-RUN")
        info("Read-only inspection. No writes will be performed.")

        groups = db.query(Group).order_by(Group.tenant_id, Group.id).all()
        info(f"Found {len(groups)} group(s) in the database.")
        if not groups:
            ok("Nothing to migrate — Phase B is a no-op on this DB.")
            global_sanity_checks(db)
            return

        all_stats = [inspect_group(db, g) for g in groups]

        global_sanity_checks(db)

        # Summary
        section("SUMMARY")
        info(f"Groups to convert: {len(all_stats)}")
        totals = defaultdict(int)
        warnings_per_group = []
        for s in all_stats:
            for k in (
                "slots",
                "memberships",
                "lead_memberships",
                "dual_membership_persons",
                "categories_to_copy",
                "schedules_to_split",
                "publications",
                "bloqueos",
                "audience_meetings",
            ):
                totals[k] += s.get(k, 0)
            if s.get("warnings"):
                warnings_per_group.append((s["group_id"], s["group_name"], s["warnings"]))
        info(f"  total slots to move:                 {totals['slots']}")
        info(f"  total memberships to move:           {totals['memberships']}")
        info(f"  of which lead memberships:           {totals['lead_memberships']}")
        info(f"  dual-membership persons:             {totals['dual_membership_persons']}")
        info(f"  categories needing copy/move:        {totals['categories_to_copy']}")
        info(f"  schedules to split:                  {totals['schedules_to_split']}")
        info(f"  group publication rows to translate: {totals['publications']}")
        info(f"  bloqueos to move:                    {totals['bloqueos']}")
        info(f"  meetings with group audience:        {totals['audience_meetings']}")
        if warnings_per_group:
            print()
            info("Per-group warnings:")
            for gid, name, ws in warnings_per_group:
                info(f"  - group_id={gid} ({name!r}): {', '.join(ws)}", indent=2)
        print()
        info("Phase B will need decisions on (per above): bloqueo movement, "
             "swap-offer handling, meeting audience translation. Categories "
             "marked 'only this group' can be moved instead of copied for "
             "a cleaner result.")
        print()
    finally:
        db.close()


if __name__ == "__main__":
    main()

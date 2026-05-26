"""Phase B — promote each sub-equipo (Group) to a peer Tenant.

The actual data migration that follows Phase A's schema and
Phase C.1's cross-tenant meeting visibility. Run by an operator
inside the API container:

    docker compose -f infra/docker-compose.prod.yml exec api \\
        python -m scripts.equipos_phase_b_apply

For each `groups` row whose parent tenant has a `servicio_id`
(i.e. is in the new model), the script creates a new Tenant
under the same Servicio + Hospital and moves:

  - slots + their per-slot rows (slot_team_roles,
    slot_allowed_persons, slot_categories,
    slot_team_role_categories, slot_rules + children)
  - memberships (lead's role list gains 'admin')
  - categories (MOVE when only this group uses them; COPY
    when shared with the main team)
  - bloqueos (AvailabilityBlock) by moving members
  - schedules: one new Schedule per affected period in the new
    tenant; status = 'published' with the
    ScheduleGroupPublication timestamp when present, otherwise
    inherits the parent Schedule's status
  - assignments under those schedules
  - shift swap offers attached to moved assignments
  - meeting audiences: each MeetingAudienceGroup row is
    translated into MeetingAudiencePerson rows (one per
    current group member). Phase C.1's relaxed RLS keeps
    those visible cross-tenant.

Groups whose parent tenant has no servicio_id are skipped
(test/legacy data). The dry-run inspector
(scripts/equipos_phase_b_dry_run.py) lists exactly what each
group will contribute before this script runs — read it first.

Safety
------
Everything happens inside one transaction. Any error → rollback,
no DB changes. The script prints a "what's about to happen"
summary and waits for the operator to type 'yes'. After commit
it prints a "what just happened" summary.

The `groups` rows are left in place after migration — Phase E
drops the table once we're sure nothing else references them.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from app.db.session import AdminSessionLocal
from app.models import (
    AvailabilityBlock,  # noqa: F401  (model attached to metadata)
    Category,
    Group,
    Meeting,  # noqa: F401
    MeetingAudienceGroup,
    MeetingAudiencePerson,
    Membership,
    Person,
    Schedule,
    ScheduleGroupPublication,
    ShiftSwapOffer,  # noqa: F401
    Slot,
    SlotRule,
    Tenant,
)


# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------


def section(title: str) -> None:
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def info(msg: str, indent: int = 2) -> None:
    print(" " * indent + msg)


def confirm() -> bool:
    print()
    resp = input(
        "Apply migration? Type exactly 'yes' to commit (anything else aborts): "
    ).strip()
    return resp == "yes"


# ---------------------------------------------------------------------------
# Data gather + plan per group
# ---------------------------------------------------------------------------


class GroupPlan:
    """Everything we computed up-front for one group's migration.

    Computing before mutating lets us print a coherent summary AND
    avoids the trap of "we already cleared group_id, now we can't
    find the slot list anymore."
    """

    def __init__(self, group: Group, parent: Tenant) -> None:
        self.group = group
        self.parent = parent
        self.slot_ids: list[int] = []
        self.member_ids: list[int] = []
        self.member_person_ids: list[int] = []
        self.lead_membership_id: int | None = group.lead_membership_id
        self.categories_to_move: list[Category] = []
        self.categories_to_copy: list[Category] = []
        # schedule_id → (period, status, generated_at, generated_by,
        # solver_used, published_at, reopened_at, reopened_by)
        self.schedules_to_split: dict[int, dict] = {}
        # schedule_id → group publication timestamp (if any)
        self.group_pub_for_schedule: dict[int, datetime] = {}
        self.bloqueo_count = 0
        self.swap_count = 0
        self.meeting_audience_groups: list[MeetingAudienceGroup] = []
        self.new_tenant_name = f"{group.name} — {parent.name}"
        self.new_tenant_slug = self._compute_slug()

    def _compute_slug(self) -> str:
        """`<group-name-slugged>-<parent-slug>` so we get something
        like `residentes-cirugia-toracica-la-fe`. Group has no
        `slug` column (the model identifies it by name within a
        tenant), so we derive one from the name with the same
        normalisation the signup flow uses elsewhere: lowercase,
        accents stripped, spaces → hyphens, anything non-alnum
        collapsed. Tenant slugs are already globally unique so
        appending the parent slug gives us global uniqueness too.
        If a collision somehow exists we fail loudly on insert
        (UNIQUE constraint) and the txn rolls back — safe."""
        import re
        import unicodedata

        raw = self.group.name.strip().lower()
        # Decompose accents and drop the combining marks. Same trick
        # the directory's name-normalize uses elsewhere in the API.
        nfkd = unicodedata.normalize("NFKD", raw)
        ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
        # Replace anything that's not alphanumeric with hyphen, then
        # collapse runs and trim.
        slugged = re.sub(r"[^a-z0-9]+", "-", ascii_only).strip("-")
        if not slugged:
            slugged = f"group-{self.group.id}"
        return f"{slugged}-{self.parent.slug}"


def gather(db, group: Group) -> GroupPlan | None:
    parent = db.get(Tenant, group.tenant_id)
    if parent is None:
        info(f"Skipping group #{group.id}: orphan parent (tenant {group.tenant_id} missing)")
        return None
    if parent.servicio_id is None or parent.hospital_id is None:
        info(
            f"Skipping group #{group.id} ({group.name!r}): parent tenant "
            f"{parent.id} ({parent.name!r}) has no servicio_id."
        )
        return None

    plan = GroupPlan(group, parent)

    # Slots
    plan.slot_ids = [
        s.id for s in db.query(Slot).filter(Slot.group_id == group.id).all()
    ]

    # Memberships
    members = db.query(Membership).filter(Membership.group_id == group.id).all()
    plan.member_ids = [m.id for m in members]
    plan.member_person_ids = [m.person_id for m in members]

    # Categories used by group memberships
    cat_ids = {m.category_id for m in members if m.category_id is not None}
    if cat_ids:
        for cat in db.query(Category).filter(Category.id.in_(cat_ids)).all():
            main_use = (
                db.query(Membership)
                .filter(
                    Membership.tenant_id == parent.id,
                    Membership.group_id.is_(None),
                    Membership.category_id == cat.id,
                )
                .count()
            )
            if main_use > 0:
                plan.categories_to_copy.append(cat)
            else:
                plan.categories_to_move.append(cat)

    # Schedules to split (only if there are group slots)
    if plan.slot_ids:
        # Distinct schedules that have any assignment on a moving slot.
        rows = db.execute(
            text(
                """
                SELECT DISTINCT s.id, s.period, s.status,
                                s.generated_at, s.generated_by_membership_id,
                                s.solver_used, s.published_at,
                                s.reopened_at, s.reopened_by_membership_id
                FROM schedules s
                JOIN assignments a ON a.schedule_id = s.id
                WHERE a.slot_id = ANY(:slot_ids)
                """
            ),
            {"slot_ids": plan.slot_ids},
        ).mappings().all()
        for r in rows:
            plan.schedules_to_split[r["id"]] = dict(r)

        # Per-schedule group publication overrides
        pubs = (
            db.query(ScheduleGroupPublication)
            .filter(ScheduleGroupPublication.group_id == group.id)
            .all()
        )
        for p in pubs:
            plan.group_pub_for_schedule[p.schedule_id] = p.published_at

    # Bloqueos by group members in the parent tenant
    if plan.member_person_ids:
        plan.bloqueo_count = (
            db.query(AvailabilityBlock)
            .filter(
                AvailabilityBlock.tenant_id == parent.id,
                AvailabilityBlock.person_id.in_(plan.member_person_ids),
            )
            .count()
        )

    # Swap offers attached to assignments on moving slots
    if plan.slot_ids:
        plan.swap_count = db.execute(
            text(
                """
                SELECT COUNT(*) FROM shift_swap_offers o
                JOIN assignments a ON a.id = o.assignment_id
                WHERE a.slot_id = ANY(:slot_ids)
                """
            ),
            {"slot_ids": plan.slot_ids},
        ).scalar() or 0

    # Meeting audience rows referring to this group
    plan.meeting_audience_groups = (
        db.query(MeetingAudienceGroup)
        .filter(MeetingAudienceGroup.group_id == group.id)
        .all()
    )

    return plan


def print_plan(plan: GroupPlan) -> None:
    section(f"PLAN — group #{plan.group.id} '{plan.group.name}'")
    info(f"new tenant:  name={plan.new_tenant_name!r}  slug={plan.new_tenant_slug!r}")
    info(f"parent:      tenant_id={plan.parent.id} ({plan.parent.name!r})")
    info(f"  → servicio_id={plan.parent.servicio_id}  hospital_id={plan.parent.hospital_id}")
    info(f"slots to move:          {len(plan.slot_ids)}  -> {plan.slot_ids}")
    info(f"memberships to move:    {len(plan.member_ids)}  -> {plan.member_ids}")
    if plan.lead_membership_id:
        info(f"  → promote membership #{plan.lead_membership_id} to 'admin'")
    info(
        f"categories: MOVE={[c.id for c in plan.categories_to_move]}  "
        f"COPY={[c.id for c in plan.categories_to_copy]}"
    )
    info(f"bloqueos to move:       {plan.bloqueo_count}")
    info(f"swap offers to follow:  {plan.swap_count}")
    info(f"schedules to split:     {len(plan.schedules_to_split)}")
    for sid, row in plan.schedules_to_split.items():
        pub_at = plan.group_pub_for_schedule.get(sid)
        # The residentes' visibility comes ONLY from
        # ScheduleGroupPublication, not from Schedule.status. A
        # parent Schedule with status='published' just means adjuntos
        # see it — the residentes only saw their plan when a group
        # publication row existed. Mirror that exactly.
        status_after = "published" if pub_at else "draft"
        info(
            f"  - schedule_id={sid}  period={row['period']}  "
            f"new_status={status_after}",
            indent=4,
        )
    info(f"meeting audience rows:  {len(plan.meeting_audience_groups)}")
    for mag in plan.meeting_audience_groups:
        info(
            f"  - meeting_id={mag.meeting_id}  "
            f"(will fan out to {len(plan.member_person_ids)} person rows)",
            indent=4,
        )


# ---------------------------------------------------------------------------
# Mutators — operate strictly off the GroupPlan, after confirmation
# ---------------------------------------------------------------------------


def apply_plan(db, plan: GroupPlan) -> dict:
    """Execute the plan in dependency order. All inside the caller's
    transaction — caller commits or rolls back. Returns a stats dict
    for the post-commit summary."""

    g, parent = plan.group, plan.parent
    stats: dict = {"group_id": g.id, "group_name": g.name}

    # ---------------------------------------------------------------
    # 1. Create the new Tenant
    # ---------------------------------------------------------------
    new_t = Tenant(
        slug=plan.new_tenant_slug,
        name=plan.new_tenant_name,
        hospital_id=parent.hospital_id,
        servicio_id=parent.servicio_id,
        country=parent.country,
        locale=parent.locale,
        country_code=parent.country_code,
        region_code=parent.region_code,
        preset_kind=parent.preset_kind,
        transplants_enabled=False,
        share_policy="full",
        approval_state="approved",
        max_swaps_per_member_per_month=parent.max_swaps_per_member_per_month,
        # Inherit setup-completion stamps so the new tenant doesn't
        # nag its admin with the "configura tu equipo" banners.
        onboarding_completed_at=parent.onboarding_completed_at,
        setup_activities_completed_at=parent.setup_activities_completed_at,
        setup_rules_completed_at=parent.setup_rules_completed_at,
        setup_team_completed_at=parent.setup_team_completed_at,
        setup_subteams_completed_at=parent.setup_subteams_completed_at,
    )
    db.add(new_t)
    db.flush()
    new_tenant_id = new_t.id
    stats["new_tenant_id"] = new_tenant_id

    # ---------------------------------------------------------------
    # 2. Parent share_policy → 'full' (preserves residentes' view of
    #    adjuntos schedule, per the migration design).
    # ---------------------------------------------------------------
    parent.share_policy = "full"

    # ---------------------------------------------------------------
    # 3. Categories
    # ---------------------------------------------------------------
    for cat in plan.categories_to_move:
        cat.tenant_id = new_tenant_id
    for cat in plan.categories_to_copy:
        # The (tenant_id, name) UNIQUE protects us from name collisions
        # within the new tenant — but a brand-new tenant has no
        # categories yet so we're fine to insert with the same name.
        new_cat = Category(
            tenant_id=new_tenant_id,
            name=cat.name,
            level=cat.level,
            description=cat.description,
        )
        db.add(new_cat)
        db.flush()
        # Re-key group memberships pointing at the old category to
        # the new one (must happen before the membership tenant_id
        # update — otherwise the old category_id sits orphan).
        db.execute(
            text(
                "UPDATE memberships SET category_id = :new "
                "WHERE id = ANY(:mids) AND category_id = :old"
            ),
            {"new": new_cat.id, "mids": plan.member_ids, "old": cat.id},
        )

    # ---------------------------------------------------------------
    # 4. Slots + per-slot tables. Update by id in bulk SQL — ORM
    #    auto-flush gets confused with mass FK re-key.
    # ---------------------------------------------------------------
    if plan.slot_ids:
        db.execute(
            text(
                "UPDATE slots SET tenant_id = :nt, group_id = NULL "
                "WHERE id = ANY(:ids)"
            ),
            {"nt": new_tenant_id, "ids": plan.slot_ids},
        )
        # These three reference the slot directly.
        for tbl in (
            "slot_team_roles",
            "slot_allowed_persons",
            "slot_categories",
        ):
            db.execute(
                text(
                    f"UPDATE {tbl} SET tenant_id = :nt "
                    f"WHERE slot_id = ANY(:ids)"
                ),
                {"nt": new_tenant_id, "ids": plan.slot_ids},
            )
        # slot_team_role_categories joins via slot_team_role_id —
        # there is no slot_id column on it. Find the role ids that
        # belong to the moving slots first, then re-key.
        db.execute(
            text(
                "UPDATE slot_team_role_categories SET tenant_id = :nt "
                "WHERE slot_team_role_id IN ("
                "  SELECT id FROM slot_team_roles "
                "  WHERE slot_id = ANY(:ids)"
                ")"
            ),
            {"nt": new_tenant_id, "ids": plan.slot_ids},
        )
        # Slot rules + children. The child tables use `rule_id` as
        # the FK (NOT `slot_rule_id`) — checked against the models.
        rule_ids = [
            r.id for r in db.query(SlotRule).filter(SlotRule.slot_id.in_(plan.slot_ids)).all()
        ]
        if rule_ids:
            db.execute(
                text("UPDATE slot_rules SET tenant_id = :nt WHERE id = ANY(:ids)"),
                {"nt": new_tenant_id, "ids": rule_ids},
            )
            for child_tbl in (
                "slot_rule_weekly_pins",
                "slot_rule_rotation_blocks",
                "slot_rule_rotation_members",
            ):
                db.execute(
                    text(
                        f"UPDATE {child_tbl} SET tenant_id = :nt "
                        f"WHERE rule_id = ANY(:ids)"
                    ),
                    {"nt": new_tenant_id, "ids": rule_ids},
                )
        # Slot dependencies: succession + frequency caps that reference
        # any moving slot. These are tenant-wide rules. If a rule
        # touches BOTH moving and non-moving slots that's a real
        # mixing problem we'd need to split; for the alpha customer
        # the residentes use manual strategy with no rules. Surface
        # a count and bail if any are mixed.
        mixed_succession = db.execute(
            text(
                """
                SELECT id FROM slot_succession_rules
                WHERE (after_slot_id = ANY(:ids) OR forbid_slot_id = ANY(:ids))
                  AND NOT (after_slot_id = ANY(:ids) AND forbid_slot_id = ANY(:ids))
                """
            ),
            {"ids": plan.slot_ids},
        ).all()
        if mixed_succession:
            raise RuntimeError(
                f"Group {g.id} has SlotSuccessionRule rows that mix group + "
                f"main-team slots (ids: {[r.id for r in mixed_succession]}). "
                "These need manual cleanup before Phase B."
            )
        db.execute(
            text(
                "UPDATE slot_succession_rules SET tenant_id = :nt "
                "WHERE after_slot_id = ANY(:ids) AND forbid_slot_id = ANY(:ids)"
            ),
            {"nt": new_tenant_id, "ids": plan.slot_ids},
        )
        db.execute(
            text(
                "UPDATE slot_frequency_caps SET tenant_id = :nt "
                "WHERE slot_id = ANY(:ids)"
            ),
            {"nt": new_tenant_id, "ids": plan.slot_ids},
        )

    # ---------------------------------------------------------------
    # 5. Memberships + lead promotion
    # ---------------------------------------------------------------
    members = db.query(Membership).filter(Membership.id.in_(plan.member_ids)).all()
    promoted_lead = False
    for m in members:
        m.tenant_id = new_tenant_id
        m.group_id = None
        if m.id == plan.lead_membership_id and "admin" not in (m.roles or []):
            m.roles = list(m.roles or []) + ["admin"]
            promoted_lead = True
    stats["lead_promoted"] = promoted_lead

    # ---------------------------------------------------------------
    # 6. Bloqueos
    # ---------------------------------------------------------------
    moved_bloqueos = 0
    if plan.member_person_ids:
        moved_bloqueos = db.execute(
            text(
                "UPDATE availability_blocks SET tenant_id = :nt "
                "WHERE tenant_id = :ot AND person_id = ANY(:pids)"
            ),
            {
                "nt": new_tenant_id,
                "ot": parent.id,
                "pids": plan.member_person_ids,
            },
        ).rowcount or 0
    stats["bloqueos_moved"] = moved_bloqueos

    # ---------------------------------------------------------------
    # 7. Schedules + assignments
    # ---------------------------------------------------------------
    new_schedule_ids: list[int] = []
    moved_assignments = 0
    for old_sid, row in plan.schedules_to_split.items():
        pub_at = plan.group_pub_for_schedule.get(old_sid)
        # See note in print_plan above — residentes' status mirrors
        # the existence of a ScheduleGroupPublication row, NOT the
        # parent's Schedule.status (which only describes adjuntos
        # visibility). published_at follows the same rule: only
        # carry over when the group really had it published.
        if pub_at:
            status_after = "published"
            published_at_after = pub_at
        else:
            status_after = "draft"
            published_at_after = None
        new_sched = Schedule(
            tenant_id=new_tenant_id,
            period=row["period"],
            status=status_after,
            generated_at=row["generated_at"],
            generated_by_membership_id=row["generated_by_membership_id"],
            solver_used=row["solver_used"],
            published_at=published_at_after,
            reopened_at=row["reopened_at"],
            reopened_by_membership_id=row["reopened_by_membership_id"],
        )
        db.add(new_sched)
        db.flush()
        new_schedule_ids.append(new_sched.id)
        # Move the assignments on group slots to the new schedule.
        result = db.execute(
            text(
                "UPDATE assignments "
                "SET tenant_id = :nt, schedule_id = :ns "
                "WHERE schedule_id = :os AND slot_id = ANY(:slots)"
            ),
            {
                "nt": new_tenant_id,
                "ns": new_sched.id,
                "os": old_sid,
                "slots": plan.slot_ids,
            },
        )
        moved_assignments += result.rowcount or 0
    stats["new_schedules"] = new_schedule_ids
    stats["assignments_moved"] = moved_assignments

    # ---------------------------------------------------------------
    # 8. Swap offers — follow their assignments
    # ---------------------------------------------------------------
    moved_swaps = 0
    if plan.slot_ids:
        moved_swaps = db.execute(
            text(
                "UPDATE shift_swap_offers SET tenant_id = :nt "
                "WHERE assignment_id IN ("
                "  SELECT id FROM assignments WHERE tenant_id = :nt "
                "    AND slot_id = ANY(:slots)"
                ")"
            ),
            {"nt": new_tenant_id, "slots": plan.slot_ids},
        ).rowcount or 0
    stats["swap_offers_moved"] = moved_swaps

    # ---------------------------------------------------------------
    # 9. Meeting audience translation: each MeetingAudienceGroup row
    #    becomes one MeetingAudiencePerson per current group member
    #    (keyed on person_id, tenant_id stays the meeting's tenant_id).
    # ---------------------------------------------------------------
    translated_meetings = 0
    audience_rows_added = 0
    for mag in plan.meeting_audience_groups:
        meeting_tenant_id = mag.tenant_id
        meeting_id = mag.meeting_id
        for pid in plan.member_person_ids:
            # INSERT … ON CONFLICT to handle the case where the same
            # person is already individually invited.
            res = db.execute(
                text(
                    "INSERT INTO meeting_audience_persons "
                    "(tenant_id, meeting_id, person_id) "
                    "VALUES (:tid, :mid, :pid) "
                    "ON CONFLICT (meeting_id, person_id) DO NOTHING"
                ),
                {"tid": meeting_tenant_id, "mid": meeting_id, "pid": pid},
            )
            audience_rows_added += res.rowcount or 0
        # Drop the now-redundant group row.
        db.delete(mag)
        translated_meetings += 1
    stats["meeting_audiences_translated"] = translated_meetings
    stats["audience_person_rows_added"] = audience_rows_added

    # ---------------------------------------------------------------
    # 10. Clean the Group row's lead_membership_id (the membership
    #     it pointed at is now in a different tenant). Don't drop
    #     the Group row — Phase E does that.
    # ---------------------------------------------------------------
    g.lead_membership_id = None

    return stats


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    db = AdminSessionLocal()
    try:
        section("PHASE B — RESIDENTES → PEER TENANT")
        info("Read-only gathering first; nothing written until you confirm.")

        groups = db.query(Group).order_by(Group.id).all()
        info(f"Found {len(groups)} group(s).")

        plans: list[GroupPlan] = []
        for g in groups:
            p = gather(db, g)
            if p is not None:
                plans.append(p)

        if not plans:
            section("NOTHING TO DO")
            info("No groups eligible for migration (all parents lack a "
                 "servicio_id, or no groups exist).")
            return

        for plan in plans:
            print_plan(plan)

        if not confirm():
            section("ABORTED")
            info("Nothing committed.")
            db.rollback()
            return

        section("APPLYING")
        results = []
        for plan in plans:
            res = apply_plan(db, plan)
            results.append(res)
            info(
                f"group #{res['group_id']} → new tenant {res['new_tenant_id']}: "
                f"{res['assignments_moved']} assignments, "
                f"{res['bloqueos_moved']} bloqueos, "
                f"{res['swap_offers_moved']} swaps, "
                f"{res['meeting_audiences_translated']} meeting audiences "
                f"({res['audience_person_rows_added']} person rows added)",
                indent=2,
            )

        db.commit()

        section("DONE")
        info(f"Committed. {len(results)} group(s) migrated.")
    except Exception as e:
        db.rollback()
        section("ERROR — ROLLED BACK")
        info(f"{type(e).__name__}: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()

"""Greedy stub schedule generator.

THIS IS A STUB. The real constraint solver lands in Sprint 5/6. The point
here is to (a) lock in the schedule + assignment data shapes and (b) prove
the Sprint 2 domain model has everything the generator needs. We pick
people round-robin by current assignment count — that's it. No fairness
score, no weighting, no objective function.

Inputs that ARE respected:
- slot.days_applied + custom_days_bitmap (which dates the slot occurs)
- holidays (for weekdays/weekends_holidays/custom)
- availability_blocks (skipped dates per person)
- slot.staffing_mode (single | multiple_same | team_composition)
- slot.headcount (number of people needed when single/multiple_same)
- slot_team_roles + slot_team_role_categories (per-role headcount + category filter)
- slot_skills_required (hard skills only — soft are TODO)

Inputs IGNORED in the stub (deliberately):
- fairness across the period (we just pick the lowest-count person)
- shift continuity, post_slot_rest, crosses_midnight implications
- soft skills
- equity counts, exemptions (other than the existing membership data)
- vacations vs sick vs training (all treated as "blocked")
"""

from __future__ import annotations

import calendar
import logging
from collections import Counter, defaultdict
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from app.models import (
    Assignment,
    AvailabilityBlock,
    Holiday,
    Membership,
    PersonSkill,
    PoolMembership,
    Schedule,
    Slot,
    SlotSkillRequired,
    SlotTeamRole,
    SlotTeamRoleCategory,
)

logger = logging.getLogger("app.scheduler")


# ---------------------------------------------------------------------------
# Date application
# ---------------------------------------------------------------------------


def _dates_in_month(period: date) -> list[date]:
    year = period.year
    month = period.month
    days = calendar.monthrange(year, month)[1]
    return [date(year, month, d) for d in range(1, days + 1)]


def _slot_applies(slot: Slot, d: date, holiday_dates: set[date]) -> bool:
    weekday = d.weekday()  # Mon=0 .. Sun=6
    is_weekend = weekday >= 5
    is_holiday = d in holiday_dates
    if slot.days_applied == "all":
        return True
    if slot.days_applied == "weekdays":
        return not is_weekend and not is_holiday
    if slot.days_applied == "weekends_holidays":
        return is_weekend or is_holiday
    if slot.days_applied == "custom":
        bitmap = slot.custom_days_bitmap or 0
        return bool(bitmap & (1 << weekday))
    return False


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------


class _Context:
    """Pre-loaded schedule context. Single DB hit per kind, then everything
    is in-memory dicts/sets so the inner loop stays cheap."""

    def __init__(self, db: Session, tenant_id: int, period: date):
        self.tenant_id = tenant_id
        self.period = period

        # Active members of this tenant (RLS enforces tenant scoping).
        self.memberships: list[Membership] = (
            db.query(Membership).all()
        )
        self.member_by_person_id: dict[int, Membership] = {
            m.person_id: m for m in self.memberships
        }

        # Slots + their team_roles + skills_required
        self.slots: list[Slot] = db.query(Slot).all()
        self.team_roles_by_slot: dict[int, list[SlotTeamRole]] = defaultdict(list)
        for tr in db.query(SlotTeamRole).all():
            self.team_roles_by_slot[tr.slot_id].append(tr)
        self.team_role_categories: dict[int, set[int]] = defaultdict(set)
        for trc in db.query(SlotTeamRoleCategory).all():
            self.team_role_categories[trc.slot_team_role_id].add(trc.category_id)
        self.slot_hard_skills: dict[int, set[int]] = defaultdict(set)
        for ssr in db.query(SlotSkillRequired).all():
            if ssr.strength == "hard":
                self.slot_hard_skills[ssr.slot_id].add(ssr.skill_id)

        # Person skills — for hard-skill filtering.
        self.person_skills: dict[int, set[int]] = defaultdict(set)
        for ps in db.query(PersonSkill).all():
            self.person_skills[ps.person_id].add(ps.skill_id)

        # Pool memberships — for slot.pool_id eligibility filtering. When a
        # slot is scoped to a pool only members of that pool are eligible;
        # when slot.pool_id is None every active member is eligible.
        self.pool_members: dict[int, set[int]] = defaultdict(set)
        for pm in db.query(PoolMembership).all():
            self.pool_members[pm.pool_id].add(pm.person_id)

        # Holidays in the period.
        days = _dates_in_month(period)
        self.holiday_dates: set[date] = {
            h.date for h in db.query(Holiday).all() if h.date in set(days)
        }

        # Availability blocks intersecting the period.
        period_start = days[0]
        period_end = days[-1]
        self.blocks_by_person: dict[int, list[tuple[date, date]]] = defaultdict(list)
        for b in db.query(AvailabilityBlock).all():
            if b.end_date < period_start or b.start_date > period_end:
                continue
            self.blocks_by_person[b.person_id].append((b.start_date, b.end_date))

        self.dates = days

    def is_blocked(self, person_id: int, d: date) -> bool:
        for s, e in self.blocks_by_person.get(person_id, ()):
            if s <= d <= e:
                return True
        return False

    def has_required_skills(self, person_id: int, slot_id: int) -> bool:
        needed = self.slot_hard_skills.get(slot_id)
        if not needed:
            return True
        return needed.issubset(self.person_skills.get(person_id, set()))

    def candidates_for_slot(
        self, slot: Slot, d: date, category_filter: set[int] | None = None
    ) -> list[int]:
        """Return person_ids eligible for (slot, date), respecting blocks,
        hard skills, the slot's pool (if any), and an optional category
        filter (for team_composition roles)."""
        pool_filter: set[int] | None = (
            self.pool_members.get(slot.pool_id, set())
            if slot.pool_id is not None
            else None
        )
        out: list[int] = []
        for m in self.memberships:
            if pool_filter is not None and m.person_id not in pool_filter:
                continue
            if category_filter and (m.category_id not in category_filter):
                continue
            if self.is_blocked(m.person_id, d):
                continue
            if not self.has_required_skills(m.person_id, slot.id):
                continue
            out.append(m.person_id)
        return out


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------


def generate_draft(
    db: Session,
    *,
    tenant_id: int,
    period: date,
    membership_id: int | None,
) -> Schedule:
    """Create a draft schedule for `period` (first of the month). If a draft
    already exists for that period it MUST be deleted by the caller before
    invoking this; if a published one exists the caller should reject the
    request entirely.

    Returns the persisted Schedule with assignments flushed to the session
    (caller commits).
    """
    period = date(period.year, period.month, 1)
    ctx = _Context(db, tenant_id, period)

    schedule = Schedule(
        tenant_id=tenant_id,
        period=period,
        status="draft",
        generated_at=datetime.now(timezone.utc),
        generated_by_membership_id=membership_id,
    )
    db.add(schedule)
    db.flush()

    # Per-person count across the schedule, to drive the round-robin.
    counts: Counter[int] = Counter()

    def pick(candidates: list[int], picked_today: set[int]) -> int | None:
        """Lowest current count; ties broken by person_id for determinism.
        Skip anyone already chosen for this slot/date."""
        pool = [p for p in candidates if p not in picked_today]
        if not pool:
            return None
        pool.sort(key=lambda pid: (counts[pid], pid))
        return pool[0]

    for d in ctx.dates:
        for slot in ctx.slots:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                continue

            mode = slot.staffing_mode
            if mode in ("single", "multiple_same"):
                head = 1 if mode == "single" else max(1, slot.headcount)
                cands = ctx.candidates_for_slot(slot, d)
                picked: set[int] = set()
                for _ in range(head):
                    pid = pick(cands, picked)
                    if pid is None:
                        db.add(
                            Assignment(
                                tenant_id=tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=None,
                                team_role_id=None,
                                notes="No hay personal disponible",
                            )
                        )
                        continue
                    picked.add(pid)
                    counts[pid] += 1
                    db.add(
                        Assignment(
                            tenant_id=tenant_id,
                            schedule_id=schedule.id,
                            slot_id=slot.id,
                            date=d,
                            person_id=pid,
                            team_role_id=None,
                        )
                    )
            elif mode == "team_composition":
                # One slot may need multiple roles, each with their own
                # category filter + headcount. People already picked for any
                # role on this slot/date should not be picked again.
                roles = ctx.team_roles_by_slot.get(slot.id, [])
                if not roles:
                    # No roles defined yet — record an unfilled placeholder
                    # so the admin notices.
                    db.add(
                        Assignment(
                            tenant_id=tenant_id,
                            schedule_id=schedule.id,
                            slot_id=slot.id,
                            date=d,
                            person_id=None,
                            notes="Slot sin roles definidos",
                        )
                    )
                    continue
                picked_for_slot: set[int] = set()
                for role in roles:
                    cat_filter = ctx.team_role_categories.get(role.id) or None
                    cands = ctx.candidates_for_slot(slot, d, category_filter=cat_filter)
                    for _ in range(max(1, role.headcount)):
                        pid = pick(cands, picked_for_slot)
                        if pid is None:
                            db.add(
                                Assignment(
                                    tenant_id=tenant_id,
                                    schedule_id=schedule.id,
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=None,
                                    team_role_id=role.id,
                                    notes="No hay personal disponible",
                                )
                            )
                            continue
                        picked_for_slot.add(pid)
                        counts[pid] += 1
                        db.add(
                            Assignment(
                                tenant_id=tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=pid,
                                team_role_id=role.id,
                            )
                        )
            else:  # pragma: no cover - guarded by DB CHECK
                logger.warning("Unknown staffing_mode=%s for slot=%s", mode, slot.id)

    db.flush()
    return schedule


def delete_draft(db: Session, schedule: Schedule) -> None:
    if schedule.status != "draft":
        raise ValueError("Only draft schedules can be deleted")
    db.delete(schedule)
    db.flush()


def publish(db: Session, schedule: Schedule) -> None:
    if schedule.status != "draft":
        raise ValueError("Only draft schedules can be published")
    schedule.status = "published"
    schedule.published_at = datetime.now(timezone.utc)
    db.flush()


def archive(db: Session, schedule: Schedule) -> None:
    if schedule.status == "archived":
        return
    schedule.status = "archived"
    db.flush()

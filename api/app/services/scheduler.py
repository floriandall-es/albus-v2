"""Schedule generator.

Sprint 5 replaced the round-robin stub with a CP-SAT model (Google
OR-Tools). The greedy stub stays as `_greedy_fallback` for the rare case
where the solver can't even start (e.g. ortools missing in some
environment, or the model has zero candidate variables anywhere).

Hard constraints (model rejects any solution that breaks them):
- For each (date, slot, team_role): exactly `headcount` people are picked,
  or fewer if there aren't enough eligible candidates (the gap becomes
  person_id=NULL "Sin cubrir" rows).
- A person works at most one slot per date.
- Eligibility filters (the model only creates an x-variable when ALL hold):
  pool membership (if slot.pool_id), hard skills, team-role categories,
  guardia_type matching Membership.guardia_types[], approved availability
  blocks, does_guardias respected for guardia-typed slots.
- post_slot_rest=True: assignment on day D forbids any assignment on D+1.
- Locked assignments (Sprint 5 part B) are pinned: the variable is forced
  to 1 and competing variables on the same (date, slot, role) are forced
  off.

Soft objective (minimize):
- Fairness: spread `counts_for_equity=True` assignments evenly,
  FTE-weighted (max - min of count*100/fte_pct, weight 10).
- Weekend balance: same idea but only counting weekend/holiday work
  (weight 5).
- Soft skill misses: weight 2 per missing soft skill on each assignment.
- Guardia spread: penalize same-person guardias <4 days apart (weight 3).

Weights are module constants — tune in code for now.
"""

from __future__ import annotations

import calendar
import itertools
import logging
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (
    Assignment,
    AvailabilityBlock,
    Holiday,
    Membership,
    PersonSkill,
    PoolMembership,
    Schedule,
    Slot,
    SlotFrequencyCap,
    SlotRule,
    SlotRuleRotationBlock,
    SlotRuleRotationMember,
    SlotRuleWeeklyPin,
    SlotSkillRequired,
    SlotSuccessionRule,
    SlotTeamRole,
    SlotTeamRoleCategory,
)

logger = logging.getLogger("app.scheduler")


# ---------------------------------------------------------------------------
# Objective weights
# ---------------------------------------------------------------------------

W_FAIRNESS = 10
W_WEEKEND = 5
W_SOFT_SKILL = 2
W_GUARDIA_SPREAD = 3
GUARDIA_MIN_GAP_DAYS = 4


# ---------------------------------------------------------------------------
# Date application
# ---------------------------------------------------------------------------


def _dates_in_month(period: date) -> list[date]:
    year = period.year
    month = period.month
    days = calendar.monthrange(year, month)[1]
    return [date(year, month, d) for d in range(1, days + 1)]


def slot_time_interval(
    slot: Slot, d: date
) -> tuple[datetime, datetime] | None:
    """Return (start, end) datetime interval for `slot` on date `d`, or
    None if the slot has no defined times (treat as on-call — never
    conflicts on time grounds with another slot).

    Slots whose end_time <= start_time cross midnight: the interval ends
    on (d + 1 day).
    """
    if slot.start_time is None or slot.end_time is None:
        return None
    s = datetime.combine(d, slot.start_time)
    e = datetime.combine(d, slot.end_time)
    if slot.end_time <= slot.start_time:
        # Crosses midnight (or zero-length — treat as crossing for safety).
        e = datetime.combine(d + timedelta(days=1), slot.end_time)
    return (s, e)


def slots_overlap_in_time(slot_a: Slot, d_a: date, slot_b: Slot, d_b: date) -> bool:
    """True iff slot A on date d_a and slot B on date d_b have overlapping
    wall-clock intervals.

    A slot with no start_time or no end_time is treated as on-call —
    on-call slots never conflict on time grounds with anything else
    (same date or adjacent date). This is the canonical "guardia
    localizada" case: someone can be on-call AND working a regular
    shift in the same window.

    Two intervals [s1, e1) and [s2, e2) overlap iff s1 < e2 AND s2 < e1.
    """
    iv_a = slot_time_interval(slot_a, d_a)
    iv_b = slot_time_interval(slot_b, d_b)
    if iv_a is None or iv_b is None:
        return False
    s1, e1 = iv_a
    s2, e2 = iv_b
    return s1 < e2 and s2 < e1


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
# Context (eligibility data, shared by solver + greedy fallback + edit API)
# ---------------------------------------------------------------------------


class _Context:
    """Pre-loaded schedule context. Single DB hit per kind, then everything
    is in-memory dicts/sets so the inner loop stays cheap."""

    def __init__(self, db: Session, tenant_id: int, period: date):
        self.tenant_id = tenant_id
        self.period = period

        self.memberships: list[Membership] = db.query(Membership).all()
        self.member_by_person_id: dict[int, Membership] = {
            m.person_id: m for m in self.memberships
        }

        self.slots: list[Slot] = db.query(Slot).all()
        self.slot_by_id: dict[int, Slot] = {s.id: s for s in self.slots}
        self.team_roles_by_slot: dict[int, list[SlotTeamRole]] = defaultdict(list)
        for tr in db.query(SlotTeamRole).all():
            self.team_roles_by_slot[tr.slot_id].append(tr)
        self.team_role_categories: dict[int, set[int]] = defaultdict(set)
        for trc in db.query(SlotTeamRoleCategory).all():
            self.team_role_categories[trc.slot_team_role_id].add(trc.category_id)

        self.slot_hard_skills: dict[int, set[int]] = defaultdict(set)
        self.slot_soft_skills: dict[int, set[int]] = defaultdict(set)
        for ssr in db.query(SlotSkillRequired).all():
            if ssr.strength == "hard":
                self.slot_hard_skills[ssr.slot_id].add(ssr.skill_id)
            elif ssr.strength == "soft":
                self.slot_soft_skills[ssr.slot_id].add(ssr.skill_id)

        self.person_skills: dict[int, set[int]] = defaultdict(set)
        for ps in db.query(PersonSkill).all():
            self.person_skills[ps.person_id].add(ps.skill_id)

        self.pool_members: dict[int, set[int]] = defaultdict(set)
        for pm in db.query(PoolMembership).all():
            self.pool_members[pm.pool_id].add(pm.person_id)

        # Per-slot assignment rules. Each slot has 1+ non-overlapping rules
        # over weekdays; each rule has its own strategy (solver, fixed_weekly,
        # rotation, manual).
        self.rules_by_slot: dict[int, list[SlotRule]] = defaultdict(list)
        for r in db.query(SlotRule).order_by(SlotRule.position, SlotRule.id).all():
            self.rules_by_slot[r.slot_id].append(r)
        self.weekly_pins_by_rule: dict[int, dict[int, list[int]]] = defaultdict(
            lambda: defaultdict(list)
        )
        for p in db.query(SlotRuleWeeklyPin).all():
            self.weekly_pins_by_rule[p.rule_id][p.weekday].append(p.person_id)
        self.rotation_blocks_by_rule: dict[int, list[SlotRuleRotationBlock]] = (
            defaultdict(list)
        )
        for b in (
            db.query(SlotRuleRotationBlock)
            .order_by(SlotRuleRotationBlock.position, SlotRuleRotationBlock.id)
            .all()
        ):
            self.rotation_blocks_by_rule[b.rule_id].append(b)
        self.rotation_members_by_rule: dict[int, list[SlotRuleRotationMember]] = (
            defaultdict(list)
        )
        for m in (
            db.query(SlotRuleRotationMember)
            .order_by(SlotRuleRotationMember.position, SlotRuleRotationMember.id)
            .all()
        ):
            self.rotation_members_by_rule[m.rule_id].append(m)

        # Cross-slot dependency rules (sprint 14).
        self.succession_rules: list[SlotSuccessionRule] = (
            db.query(SlotSuccessionRule)
            .filter(SlotSuccessionRule.applies_to == "same_person")
            .all()
        )
        self.frequency_caps: list[SlotFrequencyCap] = (
            db.query(SlotFrequencyCap).all()
        )

        days = _dates_in_month(period)
        self.holiday_dates: set[date] = {
            h.date for h in db.query(Holiday).all() if h.date in set(days)
        }

        # Only APPROVED availability blocks gate the solver. Pending and
        # denied blocks are noise as far as scheduling is concerned — they
        # exist only for the approval UI (Sprint 5 part C).
        period_start = days[0]
        period_end = days[-1]
        self.blocks_by_person: dict[int, list[tuple[date, date]]] = defaultdict(list)
        for b in db.query(AvailabilityBlock).all():
            status = getattr(b, "status", "approved")
            if status != "approved":
                continue
            if b.end_date < period_start or b.start_date > period_end:
                continue
            self.blocks_by_person[b.person_id].append((b.start_date, b.end_date))

        self.dates = days

        # Pre-existing published assignments BEFORE the period are needed
        # to evaluate rolling-window frequency caps at the start of the
        # period. Look back rolling_28 days max — that's the longest
        # supported window. Drafts don't count (they're tentative).
        lookback_start = period_start - timedelta(days=28)
        self.prior_published_counts: dict[
            tuple[int, int, date], int
        ] = defaultdict(int)
        # (person_id, slot_id, date) -> count (always 0 or 1 in practice).
        prior = (
            db.query(Assignment)
            .join(Schedule, Assignment.schedule_id == Schedule.id)
            .filter(Schedule.status == "published")
            .filter(Assignment.date >= lookback_start)
            .filter(Assignment.date < period_start)
            .filter(Assignment.person_id.isnot(None))
            .all()
        )
        for a in prior:
            key = (a.person_id, a.slot_id, a.date)
            self.prior_published_counts[key] += 1

    def is_blocked(self, person_id: int, d: date) -> bool:
        for s, e in self.blocks_by_person.get(person_id, ()):
            if s <= d <= e:
                return True
        return False

    def rule_for(self, slot_id: int, d: date) -> SlotRule | None:
        """Return the single rule that covers `d` for this slot, or None.

        Rules within a slot are guaranteed non-overlapping at the API
        layer, so there's at most one match. None means the slot has no
        rule that covers this weekday — admin chose to leave that day
        uncovered.
        """
        wd = d.weekday()
        bit = 1 << wd
        for r in self.rules_by_slot.get(slot_id, ()):
            if r.days_bitmap & bit:
                return r
        return None

    def rotation_persons_for(self, rule: SlotRule, d: date) -> list[int]:
        """Compute the rotation-assigned team for a rotation rule + date.

        Each block on the calendar advances the position by exactly 1.
        "After Sunday comes the next person for Monday; after Monday
        the next person for Tuesday." This includes spanning week
        boundaries — Fri-Sun of week N gets pos X, Mon of week N+1
        gets pos X+1.

        Position is computed by ranking blocks in CALENDAR order
        starting at anchor_date (not by the rule's authored b_idx,
        which is anchor-independent). With anchor on Fri, the Fri-Sun
        block is rank 0; Mon is rank 1; Tue rank 2; Wed rank 3; Thu
        rank 4. Subsequent weeks continue: Fri-Sun w1 = rank 5,
        Mon w1 = rank 6, etc.

            position_idx = positions_sorted[(rank + w*K) % P]

        Cycle length = lcm(P, K) / K weeks. With K=5 and P=6 that's
        6 weeks — every person eventually does every block-type once.
        Earlier formulas either advanced per-week (created a Mon-Tue
        skip) or per-(week*K+b_idx) ignoring calendar order (clustered
        same person on Thu w0 + Fri-Sun w1 because the b_idx ordering
        didn't match the actual calendar sequence).
        """
        if rule.anchor_date is None:
            return []
        blocks = self.rotation_blocks_by_rule.get(rule.id, [])
        members = self.rotation_members_by_rule.get(rule.id, [])
        if not blocks or not members:
            return []
        wd = d.weekday()
        bit = 1 << wd
        b_idx: int | None = None
        for i, b in enumerate(blocks):
            if b.days_bitmap & bit:
                b_idx = i
                break
        if b_idx is None:
            return []
        # Distinct positions in the rotation (sorted ascending).
        positions_sorted = sorted({m.position for m in members})
        p_count = len(positions_sorted)
        if p_count == 0:
            return []
        # CALENDAR rank: how many blocks start before this one inside a
        # single week, counting from the anchor's weekday. Anchor=Fri
        # with blocks Mon, Tue, Wed, Thu, Fri-Sun gives ranks
        # 1, 2, 3, 4, 0 respectively (Fri-Sun is the FIRST block to
        # start in a week measured from Friday).
        anchor_wd = rule.anchor_date.weekday()
        block_first_weekday: list[int] = []
        for b in blocks:
            for w in range(7):
                if b.days_bitmap & (1 << w):
                    block_first_weekday.append(w)
                    break
            else:
                block_first_weekday.append(0)
        block_offset = [
            (block_first_weekday[i] - anchor_wd) % 7 for i in range(len(blocks))
        ]
        sorted_block_indices = sorted(
            range(len(blocks)), key=lambda i: block_offset[i]
        )
        rank_of_block = {bi: r for r, bi in enumerate(sorted_block_indices)}

        weeks = (d - rule.anchor_date).days // 7
        k = len(blocks)
        rank = rank_of_block[b_idx]
        # Python % is non-negative for negative dividends.
        target_pos = positions_sorted[(rank + weeks * k) % p_count]
        # Sort the team within a position by member.id so emission order
        # is deterministic and the same team always lands in the same
        # demand slot. (Members are pre-loaded ordered by (position, id)
        # in __init__, so this filter preserves that order.)
        return [m.person_id for m in members if m.position == target_pos]

    # Back-compat shim: a few legacy code paths and tests want a single
    # person. Returns the first member of the rotation team for this date,
    # or None.
    def rotation_person_for(self, rule: SlotRule, d: date) -> int | None:
        team = self.rotation_persons_for(rule, d)
        return team[0] if team else None

    def fixed_weekly_persons(self, rule: SlotRule, d: date) -> list[int]:
        """Return the pinned person_ids for the (rule, weekday) pair."""
        return list(self.weekly_pins_by_rule.get(rule.id, {}).get(d.weekday(), []))

    def has_required_skills(self, person_id: int, slot_id: int) -> bool:
        needed = self.slot_hard_skills.get(slot_id)
        if not needed:
            return True
        return needed.issubset(self.person_skills.get(person_id, set()))

    # -- Eligibility, used by both solver and the manual-edit endpoint. ---

    def eligibility_reason(
        self,
        person_id: int,
        slot: Slot,
        d: date,
        team_role_id: int | None = None,
    ) -> str | None:
        """Return None if the person CAN take the slot on date d, else a
        Spanish human-readable reason. Mirrors the filters used by the
        solver — keep the two in lockstep."""
        m = self.member_by_person_id.get(person_id)
        if not m:
            return "La persona no es miembro activo del equipo"
        # Pool scope.
        if slot.pool_id is not None:
            if person_id not in self.pool_members.get(slot.pool_id, set()):
                return "La persona no pertenece al pool de este slot"
        # Hard skills.
        if not self.has_required_skills(person_id, slot.id):
            return "Le faltan skills obligatorias para este slot"
        # Team-role categories.
        if team_role_id is not None:
            cats = self.team_role_categories.get(team_role_id)
            if cats and m.category_id not in cats:
                return "Su categoría no cubre este rol"
        # Guardia type / does_guardias.
        if slot.guardia_type:
            if not m.does_guardias:
                return "La persona no hace guardias"
            if slot.guardia_type not in (m.guardia_types or []):
                return (
                    f"No tiene el tipo de guardia '{slot.guardia_type}' en su perfil"
                )
        # Availability blocks.
        if self.is_blocked(person_id, d):
            return "La persona tiene un bloqueo de disponibilidad aprobado en esa fecha"
        # Slot date applicability.
        if not _slot_applies(slot, d, self.holiday_dates):
            return "El slot no aplica en esa fecha"
        return None

    def candidates_for_slot(
        self,
        slot: Slot,
        d: date,
        team_role_id: int | None = None,
    ) -> list[int]:
        out: list[int] = []
        for m in self.memberships:
            if self.eligibility_reason(m.person_id, slot, d, team_role_id) is None:
                out.append(m.person_id)
        return out


def is_eligible(
    ctx: _Context,
    person_id: int,
    slot: Slot,
    d: date,
    team_role_id: int | None = None,
) -> tuple[bool, str | None]:
    """Public wrapper for use by the manual-edit endpoint."""
    reason = ctx.eligibility_reason(person_id, slot, d, team_role_id)
    return (reason is None, reason)


# ---------------------------------------------------------------------------
# Greedy fallback (round-robin)
# ---------------------------------------------------------------------------


def _greedy_fallback(
    db: Session,
    ctx: _Context,
    schedule: Schedule,
    locked: list[Assignment] | None = None,
) -> None:
    """Round-robin generator. Used when the CP-SAT solver can't run.

    Loses fairness/spread quality but always produces SOMETHING. Locked
    assignments are emitted first so the caller's constraint that they
    survive is honoured.
    """
    counts: Counter[int] = Counter()
    # Per-person assignments so far: list of (date, slot) used to detect
    # time-overlap conflicts when considering a new (slot, date). This
    # replaces the older "one slot per person per day" set, which was
    # wrong — a person can do consulta 08-14 AND on-call 22-08, those
    # don't overlap in wall-clock time.
    busy_by_person: dict[int, list[tuple[date, Slot]]] = defaultdict(list)
    # Person → dates they're blocked on because the previous day's slot
    # had post_slot_rest=True.
    rest_block: dict[int, set[date]] = defaultdict(set)
    # Sprint 16: per-(person, role) counter used by the team_composition
    # branch to approximate Latin-square role rotation across consecutive
    # team-pinned days. CP-SAT enforces this exactly via balance blocks;
    # the greedy fallback only nudges by preferring the lowest-count
    # role-person pairing.
    role_counts: Counter[tuple[int, int]] = Counter()
    locked = locked or []
    for la in locked:
        db.add(
            Assignment(
                tenant_id=ctx.tenant_id,
                schedule_id=schedule.id,
                slot_id=la.slot_id,
                date=la.date,
                person_id=la.person_id,
                team_role_id=la.team_role_id,
                notes=la.notes,
                locked_at=la.locked_at,
                locked_by_membership_id=la.locked_by_membership_id,
            )
        )
        if la.person_id is not None:
            counts[la.person_id] += 1
            slot_la = ctx.slot_by_id.get(la.slot_id)
            if slot_la is not None:
                busy_by_person[la.person_id].append((la.date, slot_la))
                if slot_la.post_slot_rest:
                    rest_block[la.person_id].add(la.date + timedelta(days=1))
    locked_keys = {(la.date, la.slot_id, la.team_role_id) for la in locked}

    def conflicts_in_time(pid: int, slot: Slot, d: date) -> bool:
        """True if pid is already in a slot whose times overlap with
        (slot, d) on d-1, d, or d+1; or pid is owed post-shift rest on d;
        or the new slot has post_slot_rest=True and pid is already in any
        slot on d+1."""
        if d in rest_block.get(pid, ()):
            return True
        for (d_other, slot_other) in busy_by_person.get(pid, ()):
            if abs((d - d_other).days) > 1:
                continue
            if slots_overlap_in_time(slot, d, slot_other, d_other):
                return True
        if slot.post_slot_rest:
            next_d = d + timedelta(days=1)
            for (d_other, _slot_other) in busy_by_person.get(pid, ()):
                if d_other == next_d:
                    return True
        return False

    def record_assignment(pid: int, slot: Slot, d: date) -> None:
        busy_by_person[pid].append((d, slot))
        if slot.post_slot_rest:
            rest_block[pid].add(d + timedelta(days=1))
        counts[pid] += 1

    def pick(candidates: list[int], slot: Slot, d: date) -> int | None:
        pool = [p for p in candidates if not conflicts_in_time(p, slot, d)]
        if not pool:
            return None
        pool.sort(key=lambda pid: (counts[pid], pid))
        return pool[0]

    def _pin_persons(rule: SlotRule, d: date) -> list[int] | None:
        """Return the configured person_ids for a non-solver rule on date d,
        or None if the rule is solver/manual (caller round-robins instead)."""
        if rule.strategy == "fixed_weekly":
            return list(ctx.fixed_weekly_persons(rule, d))
        if rule.strategy == "rotation":
            return list(ctx.rotation_persons_for(rule, d))
        return None  # solver / manual → fall through to round-robin

    # Two passes per day: first claim slots whose rule has explicit pins
    # (fixed_weekly / rotation), then fill solver / manual slots with
    # round-robin from whoever's left. Without this ordering, a greedy
    # round-robin pick from an earlier slot could grab the very person a
    # later rule has pinned — leaving the pinned slot empty with the
    # confusing "Persona fija ya asignada hoy" note.
    def _slot_priority(slot: Slot, d: date) -> int:
        """Lower runs first. Pinned/rotation slots before round-robin —
        applies to both single/multiple_same AND team_composition slots
        (sprint 16: the latter can now have a rule pinning a team)."""
        rule = ctx.rule_for(slot.id, d)
        if rule is None:
            return 1
        if rule.strategy in ("fixed_weekly", "rotation"):
            return 0
        return 1

    for d in ctx.dates:
        slots_in_priority_order = sorted(
            ctx.slots, key=lambda s: (_slot_priority(s, d), s.id)
        )
        for slot in slots_in_priority_order:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                continue
            rule = ctx.rule_for(slot.id, d)
            if rule is None:
                continue

            mode = slot.staffing_mode
            # Sprint 16: pre-compute the team pin per (slot, date). For
            # single/multiple_same slots the pin is applied directly as
            # the assignment (round-robin within head). For
            # team_composition we DON'T pre-pin — the team becomes the
            # restricted candidate pool when the team_composition branch
            # runs below, and a per-role least-used bias produces a
            # Latin-square-ish rotation across consecutive days.
            if mode == "team_composition":
                pinned = None
            else:
                pinned = _pin_persons(rule, d)

            if mode in ("single", "multiple_same"):
                if (d, slot.id, None) in locked_keys:
                    continue
                head = 1 if mode == "single" else max(1, slot.headcount)
                # Within a single (slot, date), the same person can't
                # take two roles — guard with a local set on top of the
                # cross-slot time-overlap logic.
                picked_this_slot: set[int] = set()

                # Honour fixed_weekly / rotation pins first. The admin
                # named these people explicitly — pins are authoritative
                # and override cross-slot time-overlap / post_slot_rest
                # constraints. Those constraints only apply to solver
                # picks (round-robin or CP-SAT). We still:
                # - reject duplicates within the SAME (slot, date)
                # - reject if the person can't physically take the slot
                #   (pool / hard skill / availability block)
                emitted = 0
                if pinned is not None:
                    pinned = pinned[:head]
                    for cand in pinned:
                        if cand in picked_this_slot:
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule.id,
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=None,
                                    team_role_id=None,
                                    notes="Persona duplicada en pines",
                                )
                            )
                            emitted += 1
                            continue
                        reason = ctx.eligibility_reason(cand, slot, d, None)
                        if reason:
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule.id,
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=None,
                                    team_role_id=None,
                                    notes=f"Persona configurada no disponible: {reason}",
                                )
                            )
                            emitted += 1
                            continue
                        picked_this_slot.add(cand)
                        # record_assignment still updates busy_by_person /
                        # rest_block so subsequent SOLVER picks (lower
                        # priority slots later in this day) can see the
                        # pinned person is occupied.
                        record_assignment(cand, slot, d)
                        db.add(
                            Assignment(
                                tenant_id=ctx.tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=cand,
                                team_role_id=None,
                            )
                        )
                        emitted += 1
                    for _ in range(head - emitted):
                        db.add(
                            Assignment(
                                tenant_id=ctx.tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=None,
                                team_role_id=None,
                                notes="Plaza adicional pendiente",
                            )
                        )
                    continue

                if rule.strategy == "manual":
                    for _ in range(head):
                        db.add(
                            Assignment(
                                tenant_id=ctx.tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=None,
                                team_role_id=None,
                                notes="Pendiente de asignar manualmente",
                            )
                        )
                    continue

                cands = ctx.candidates_for_slot(slot, d)
                for _ in range(head):
                    pool = [
                        p for p in cands
                        if p not in picked_this_slot
                        and not conflicts_in_time(p, slot, d)
                    ]
                    if not pool:
                        db.add(
                            Assignment(
                                tenant_id=ctx.tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=None,
                                team_role_id=None,
                                notes="No hay personal disponible",
                            )
                        )
                        continue
                    pool.sort(key=lambda pid: (counts[pid], pid))
                    pid = pool[0]
                    picked_this_slot.add(pid)
                    record_assignment(pid, slot, d)
                    db.add(
                        Assignment(
                            tenant_id=ctx.tenant_id,
                            schedule_id=schedule.id,
                            slot_id=slot.id,
                            date=d,
                            person_id=pid,
                            team_role_id=None,
                        )
                    )
            elif mode == "team_composition":
                roles = ctx.team_roles_by_slot.get(slot.id, [])
                if not roles:
                    db.add(
                        Assignment(
                            tenant_id=ctx.tenant_id,
                            schedule_id=schedule.id,
                            slot_id=slot.id,
                            date=d,
                            person_id=None,
                            notes="Slot sin roles definidos",
                        )
                    )
                    continue
                # Sprint 16: when a rule pins a team for this date,
                # restrict the candidate pool to those people. Otherwise
                # (rule.strategy == "solver" or "manual") fall back to
                # all eligible candidates as before.
                team_pin: list[int] | None = None
                if rule.strategy == "rotation":
                    team_pin = list(ctx.rotation_persons_for(rule, d))
                elif rule.strategy == "fixed_weekly":
                    team_pin = list(ctx.fixed_weekly_persons(rule, d))
                team_pin_set = set(team_pin) if team_pin else None

                # Same-slot exclusivity: a person can fill at most one
                # role of the same slot/date. Cross-slot conflicts go
                # through conflicts_in_time().
                picked_for_slot: set[int] = set()
                for role in roles:
                    if (d, slot.id, role.id) in locked_keys:
                        continue
                    cands = ctx.candidates_for_slot(slot, d, team_role_id=role.id)
                    if team_pin_set is not None:
                        cands = [p for p in cands if p in team_pin_set]
                    for _ in range(max(1, role.headcount)):
                        pool = [
                            p for p in cands
                            if p not in picked_for_slot
                            and not conflicts_in_time(p, slot, d)
                        ]
                        if not pool:
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule.id,
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=None,
                                    team_role_id=role.id,
                                    notes="No hay personal disponible",
                                )
                            )
                            continue
                        # When a team is pinned, bias towards the
                        # person who has done THIS role the fewest
                        # times so far — this approximates the Latin-
                        # square Friday-Saturday-Sunday role rotation
                        # CP-SAT enforces exactly. When no team is
                        # pinned, fall back to overall person counts
                        # (existing behaviour).
                        if team_pin_set is not None:
                            pool.sort(
                                key=lambda pid: (
                                    role_counts[(pid, role.id)],
                                    counts[pid],
                                    pid,
                                )
                            )
                        else:
                            pool.sort(key=lambda pid: (counts[pid], pid))
                        pid = pool[0]
                        picked_for_slot.add(pid)
                        record_assignment(pid, slot, d)
                        role_counts[(pid, role.id)] += 1
                        db.add(
                            Assignment(
                                tenant_id=ctx.tenant_id,
                                schedule_id=schedule.id,
                                slot_id=slot.id,
                                date=d,
                                person_id=pid,
                                team_role_id=role.id,
                            )
                        )


# ---------------------------------------------------------------------------
# CP-SAT solver
# ---------------------------------------------------------------------------


def _log_infeasibility_diagnostic(
    *,
    ctx: "_Context",
    demands: list[tuple[date, int, int | None, int]],
    candidates_by_demand: dict[tuple[date, int, int | None], list[int]],
    pre_pinned_assignments: list[tuple[int, date, int]],
    pre_busy: set[tuple[int, date]],
    pre_rest_block: set[tuple[int, date]],
) -> None:
    """When CP-SAT returns INFEASIBLE, print enough state to pinpoint
    which constraint group is killing the model. Hits the api log;
    inspect with `docker compose logs api`.

    Things we look for, in order of typical culprit-likelihood:
    1. Demands with zero or too few eligible candidates (config: pool /
       skill / availability blocks too tight).
    2. Same person pre-pinned to two slots whose times overlap on the
       same day — pre-pins themselves are emitted unconditionally, but
       cross-slot solver vars referring to them inherit the conflict.
    3. post_slot_rest cascade: a pre-pinned slot with post_slot_rest
       blocks the same person across MANY downstream solver demands;
       if that pushes another demand to <head candidates, infeasibility.
    4. Candidate scarcity per day: total person-days needed vs available
       (rough sanity check).
    """
    logger.warning("=== CP-SAT infeasibility diagnostic ===")

    # 1. Per-demand candidate count vs head.
    short_demands = []
    zero_demands = []
    for (d, slot_id, role_id, head) in demands:
        cands = candidates_by_demand.get((d, slot_id, role_id), [])
        if not cands:
            zero_demands.append((d, slot_id, role_id, head))
        elif len(cands) < head:
            short_demands.append((d, slot_id, role_id, head, len(cands)))
    if zero_demands:
        logger.warning(
            "  [scarcity] %d demand(s) with ZERO eligible candidates (model"
            " can't satisfy sum=head):",
            len(zero_demands),
        )
        for (d, slot_id, role_id, head) in zero_demands[:10]:
            slot = ctx.slot_by_id.get(slot_id)
            logger.warning(
                "    %s slot=%s role=%s head=%d",
                d.isoformat(),
                slot.name if slot else slot_id,
                role_id,
                head,
            )
    if short_demands:
        logger.warning(
            "  [scarcity] %d demand(s) with FEWER candidates than head"
            " (target capped to len(cands), model still tries sum=target):",
            len(short_demands),
        )
        for (d, slot_id, role_id, head, ncands) in short_demands[:10]:
            slot = ctx.slot_by_id.get(slot_id)
            logger.warning(
                "    %s slot=%s role=%s head=%d cands=%d",
                d.isoformat(),
                slot.name if slot else slot_id,
                role_id,
                head,
                ncands,
            )

    # 2. Pre-pin time-overlap between two pins on same person/day.
    pins_by_person_day: dict[tuple[int, date], list[int]] = defaultdict(list)
    for (pid, d, slot_id) in pre_pinned_assignments:
        pins_by_person_day[(pid, d)].append(slot_id)
    overlapping_pin_pairs = []
    for (pid, d), slot_ids in pins_by_person_day.items():
        if len(slot_ids) < 2:
            continue
        for i in range(len(slot_ids)):
            for j in range(i + 1, len(slot_ids)):
                sa = ctx.slot_by_id.get(slot_ids[i])
                sb = ctx.slot_by_id.get(slot_ids[j])
                if sa is None or sb is None:
                    continue
                if slots_overlap_in_time(sa, d, sb, d):
                    overlapping_pin_pairs.append((pid, d, sa.name, sb.name))
    if overlapping_pin_pairs:
        logger.warning(
            "  [pre-pin overlap] %d pair(s) of pinned slots whose times"
            " overlap on the same person/day. Solver vars on overlapping"
            " slots inherit conflicts via the time-overlap constraint:",
            len(overlapping_pin_pairs),
        )
        for (pid, d, na, nb) in overlapping_pin_pairs[:10]:
            m = ctx.member_by_person_id.get(pid)
            person_name = m.person_id if m else pid
            logger.warning(
                "    %s person=%s pinned to %s + %s (overlap)",
                d.isoformat(),
                person_name,
                na,
                nb,
            )

    # 3. post_slot_rest cascade footprint.
    if pre_rest_block:
        logger.warning(
            "  [post_slot_rest] %d (person, day) pair(s) blocked by the"
            " previous day's rest-required slot.",
            len(pre_rest_block),
        )

    # 4. Per-person pre-pinned day count + total demand person-days.
    pre_pin_count: dict[int, int] = defaultdict(int)
    for (pid, d) in pre_busy:
        pre_pin_count[pid] += 1
    total_person_days = sum(head for (_d, _s, _r, head) in demands)
    n_persons = len(ctx.memberships)
    days_in_period = len(ctx.dates)
    logger.warning(
        "  [load] %d person-days demanded; %d person-days physically"
        " available (people=%d * days=%d). Pre-pinned days/person:",
        total_person_days,
        n_persons * days_in_period,
        n_persons,
        days_in_period,
    )
    for pid, n in sorted(pre_pin_count.items(), key=lambda x: -x[1])[:10]:
        m = ctx.member_by_person_id.get(pid)
        logger.warning("    person=%s pre_pinned_days=%d", pid, n)

    logger.warning("=== end diagnostic ===")


def _solve_cpsat(
    db: Session,
    ctx: _Context,
    schedule: Schedule,
    locked: list[Assignment] | None = None,
) -> bool:
    """Build + solve the CP-SAT model. Persist assignments to `schedule`.

    Returns True on success, False if the solver couldn't run at all
    (caller should then invoke the greedy fallback).
    """
    try:
        from ortools.sat.python import cp_model
    except ImportError:  # pragma: no cover - sanity guard
        logger.warning("ortools not available — falling back to greedy")
        return False

    locked = locked or []

    # ---- Build the list of (date, slot, role, headcount) "demand" rows. ---
    # Each demand row will become a sum-equals-headcount constraint over its
    # candidate variables.
    Demand = tuple[date, int, int | None, int]  # (date, slot_id, role_id, head)
    demands: list[Demand] = []
    is_weekend_or_holiday: dict[date, bool] = {}
    is_guardia_demand: dict[tuple[date, int, int | None], bool] = {}

    for d in ctx.dates:
        wd = d.weekday()
        is_weekend_or_holiday[d] = (wd >= 5) or (d in ctx.holiday_dates)

    # Per-rule pre-pinned assignments (rotation / fixed_weekly / manual)
    # are emitted directly to the DB before the solver runs, and the
    # involved (person_id, date) pairs are recorded so solver demands on
    # those days exclude those people. The pre-pinned cells never become
    # CP-SAT variables.
    pre_busy: set[tuple[int, date]] = set()
    # Same info but with slot_id, used by the time-overlap constraint
    # below to forbid solver vars whose times conflict with a pre-pin.
    pre_pinned_assignments: list[tuple[int, date, int]] = []  # (pid, date, slot_id)
    # If a pre-pinned person worked a post_slot_rest slot on D, exclude
    # them from solver demands on D+1 too.
    pre_rest_block: set[tuple[int, date]] = set()
    # Sprint 16: for team_composition slots, a rotation / fixed_weekly
    # rule pins a TEAM (set of person_ids) to the slot for date D —
    # the solver still decides which role each team member covers, but
    # the candidate pool for every role demand on that (slot, date) is
    # restricted to those team members. Consecutive dates with the same
    # team form a "balance block" → see the Latin-square constraint
    # added after the hard same-slot exclusivity below.
    team_pinned_by_slot_day: dict[tuple[int, date], list[int]] = {}

    def _emit_team_prepin(
        slot: Slot,
        d: date,
        rule: SlotRule,
        team_role_id: int | None,
        head: int,
    ) -> None:
        """Materialize up to `head` pre-pinned assignments for a
        non-solver rule (rotation / fixed_weekly / manual).

        Multi-person handling (sprint 15): rotation and fixed_weekly both
        return a list of configured persons for (rule, date). For each:
        - If the configured person is eligible: emit one assignment and
          register them for cross-slot conflict detection (overlap,
          succession, frequency caps).
        - If ineligible: emit a NULL placeholder with a Spanish reason.
        - Duplicate persons within the configured list (shouldn't happen
          with current API validation, but defensive): collapse to one,
          subsequent slots become NULL "Persona duplicada en pines".
        - If configured < head: pad with NULL "Plaza adicional pendiente"
          rows so the admin sees the gap.
        - If configured > head: take first `head`; log a warning. (This
          can happen when an admin shrinks slot.headcount below the team
          size without revisiting the rule.)
        manual rules always emit head NULL rows with "Pendiente de asignar
        manualmente".
        """
        if rule.strategy == "manual":
            for _ in range(head):
                db.add(
                    Assignment(
                        tenant_id=ctx.tenant_id,
                        schedule_id=schedule.id,
                        slot_id=slot.id,
                        date=d,
                        person_id=None,
                        team_role_id=team_role_id,
                        notes="Pendiente de asignar manualmente",
                    )
                )
            return

        if rule.strategy == "rotation":
            configured = ctx.rotation_persons_for(rule, d)
            empty_notes = "Rotación sin miembros configurados"
            ineligible_prefix = "Persona de la rotación no disponible"
        elif rule.strategy == "fixed_weekly":
            configured = ctx.fixed_weekly_persons(rule, d)
            empty_notes = "Sin persona fijada para este día de la semana"
            ineligible_prefix = "Persona fija no disponible"
        else:
            # Unknown strategy — should never reach here. Emit NULLs.
            for _ in range(head):
                db.add(
                    Assignment(
                        tenant_id=ctx.tenant_id,
                        schedule_id=schedule.id,
                        slot_id=slot.id,
                        date=d,
                        person_id=None,
                        team_role_id=team_role_id,
                        notes="Estrategia desconocida",
                    )
                )
            return

        if len(configured) > head:
            logger.warning(
                "Configured team larger than headcount: slot=%s date=%s "
                "configured=%d head=%d — taking first %d (deterministic)",
                slot.name,
                d.isoformat(),
                len(configured),
                head,
                head,
            )
            configured = configured[:head]

        emitted_persons: set[int] = set()
        emitted = 0
        for cand in configured:
            person_id: int | None = None
            notes: str | None = None
            if cand in emitted_persons:
                notes = "Persona duplicada en pines"
            else:
                reason = ctx.eligibility_reason(cand, slot, d, team_role_id)
                if reason:
                    notes = f"{ineligible_prefix}: {reason}"
                else:
                    person_id = cand
                    emitted_persons.add(cand)
            db.add(
                Assignment(
                    tenant_id=ctx.tenant_id,
                    schedule_id=schedule.id,
                    slot_id=slot.id,
                    date=d,
                    person_id=person_id,
                    team_role_id=team_role_id,
                    notes=notes,
                )
            )
            if person_id is not None:
                pre_busy.add((person_id, d))
                pre_pinned_assignments.append((person_id, d, slot.id))
                if slot.post_slot_rest:
                    pre_rest_block.add((person_id, d + timedelta(days=1)))
            emitted += 1

        # Pad NULLs for any remaining headcount.
        if emitted == 0 and head > 0:
            # No configured persons at all — emit head rows with the
            # category-specific "empty" reason on each.
            for _ in range(head):
                db.add(
                    Assignment(
                        tenant_id=ctx.tenant_id,
                        schedule_id=schedule.id,
                        slot_id=slot.id,
                        date=d,
                        person_id=None,
                        team_role_id=team_role_id,
                        notes=empty_notes,
                    )
                )
            return
        for _ in range(head - emitted):
            db.add(
                Assignment(
                    tenant_id=ctx.tenant_id,
                    schedule_id=schedule.id,
                    slot_id=slot.id,
                    date=d,
                    person_id=None,
                    team_role_id=team_role_id,
                    notes="Plaza adicional pendiente",
                )
            )

    locked_keys_set = {(la.date, la.slot_id, la.team_role_id) for la in locked}

    for d in ctx.dates:
        for slot in ctx.slots:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                continue
            rule = ctx.rule_for(slot.id, d)
            if rule is None:
                # Admin chose not to cover this weekday on this slot.
                continue
            mode = slot.staffing_mode
            if mode == "team_composition":
                # Sprint 16: team_composition slots are always
                # solver-driven for role assignment, but a rotation /
                # fixed_weekly rule can now restrict the candidate pool
                # to a specific TEAM (set of people). The solver still
                # decides which person covers which role; a Latin-square
                # balance constraint added below makes the role
                # distribution rotate within the block.
                roles = ctx.team_roles_by_slot.get(slot.id, [])
                if not roles:
                    db.add(
                        Assignment(
                            tenant_id=ctx.tenant_id,
                            schedule_id=schedule.id,
                            slot_id=slot.id,
                            date=d,
                            person_id=None,
                            notes="Slot sin roles definidos",
                        )
                    )
                    continue
                if rule.strategy == "rotation":
                    team = list(ctx.rotation_persons_for(rule, d))
                elif rule.strategy == "fixed_weekly":
                    team = list(ctx.fixed_weekly_persons(rule, d))
                else:
                    team = []
                if team:
                    team_pinned_by_slot_day[(slot.id, d)] = team
                for role in roles:
                    demands.append((d, slot.id, role.id, max(1, role.headcount)))
                    is_guardia_demand[(d, slot.id, role.id)] = bool(slot.guardia_type)
                continue

            # Non-team_composition: rule.strategy dictates behaviour.
            if rule.strategy == "solver":
                head = 1 if mode == "single" else max(1, slot.headcount)
                demands.append((d, slot.id, None, head))
                is_guardia_demand[(d, slot.id, None)] = bool(slot.guardia_type)
            else:
                # rotation / fixed_weekly / manual for single /
                # multiple_same. A locked assignment for this
                # (date, slot) pre-empts the rule pick — the lock wins.
                # We rely on the locked-key set: if a lock exists, we
                # let _solve_cpsat's lock branch handle emission (by
                # adding a degenerate solver demand below).
                if (d, slot.id, None) in locked_keys_set:
                    head = 1 if mode == "single" else max(1, slot.headcount)
                    demands.append((d, slot.id, None, head))
                    is_guardia_demand[(d, slot.id, None)] = bool(slot.guardia_type)
                    continue
                head = 1 if mode == "single" else max(1, slot.headcount)
                # Multi-person aware emission. Both rotation and
                # fixed_weekly can configure 1..head people for
                # (rule, date); manual always emits head NULLs.
                _emit_team_prepin(slot, d, rule, None, head)

    # Locked map for quick lookup.
    locked_by_key: dict[tuple[date, int, int | None], list[Assignment]] = defaultdict(list)
    for la in locked:
        locked_by_key[(la.date, la.slot_id, la.team_role_id)].append(la)

    # ---- Build x-variables only for ELIGIBLE candidates. ----
    model = cp_model.CpModel()
    x: dict[tuple[date, int, int | None, int], "cp_model.IntVar"] = {}
    candidates_by_demand: dict[tuple[date, int, int | None], list[int]] = {}

    for (d, slot_id, role_id, head) in demands:
        slot = ctx.slot_by_id[slot_id]
        cands = ctx.candidates_for_slot(slot, d, team_role_id=role_id)
        # Filter out candidates owed a post_slot_rest from yesterday's
        # pre-pinned shift (a real physical-rest constraint). DON'T
        # filter out anyone who happens to be pre-pinned to some OTHER
        # slot today: if their times don't overlap with this slot's
        # times, they should still be eligible. The cross-slot
        # time-overlap constraint added below catches actual time
        # conflicts; using `pre_busy` as a blanket per-day filter here
        # would re-introduce the old "one slot per person per day"
        # overconstraint we explicitly removed in sprint 14.
        if pre_rest_block:
            cands = [
                pid for pid in cands if (pid, d) not in pre_rest_block
            ]
        # Sprint 16: team-pin restriction on team_composition slots.
        # If a rotation/fixed_weekly rule pinned a specific team for
        # this (slot, date), only those people can fill any role of
        # the slot that day. Ineligible team members are silently
        # dropped here — the head==N constraint will then downsize
        # the demand and emit NULL rows after the solve, so the admin
        # sees the gap with the usual "No hay personal disponible"
        # note.
        team_pin = team_pinned_by_slot_day.get((slot_id, d))
        if team_pin is not None:
            team_set = set(team_pin)
            cands = [pid for pid in cands if pid in team_set]
        candidates_by_demand[(d, slot_id, role_id)] = cands
        for pid in cands:
            x[(d, slot_id, role_id, pid)] = model.NewBoolVar(
                f"x_d{d.isoformat()}_s{slot_id}_r{role_id}_p{pid}"
            )

    if not x:
        # Nothing to solve. Either no demands or no eligible candidates
        # anywhere. Emit unfilled placeholders so the admin sees the gap
        # and bail out.
        for (d, slot_id, role_id, head) in demands:
            for _ in range(head):
                db.add(
                    Assignment(
                        tenant_id=ctx.tenant_id,
                        schedule_id=schedule.id,
                        slot_id=slot_id,
                        date=d,
                        person_id=None,
                        team_role_id=role_id,
                        notes="No hay personal disponible",
                    )
                )
        return True

    # ---- Hard: per-demand head equals sum (or fewer when capacity-limited). ---
    # When there are fewer eligible candidates than headcount the model
    # can't satisfy "sum == head". So: cap target = min(head, n_cands).
    # Remaining (head - n_cands) emit as person_id=NULL after the solve.
    head_target: dict[tuple[date, int, int | None], int] = {}
    for (d, slot_id, role_id, head) in demands:
        cands = candidates_by_demand[(d, slot_id, role_id)]
        target = min(head, len(cands))
        head_target[(d, slot_id, role_id)] = target
        if cands:
            model.Add(
                sum(x[(d, slot_id, role_id, pid)] for pid in cands) == target
            )

    # ---- Hard: time-overlap mutual exclusion per person. ---
    # (Sprint 14 fix.) Replaces the old "at most one slot per (person,
    # date)" constraint, which was wrong: a doctor commonly does
    # consulta 08–14 AND guardia 14–08(next) on the same calendar day.
    # Those don't overlap in wall-clock time and should both be
    # allowed.
    #
    # For each person we look at every variable they appear in PLUS
    # every pre-pinned (rotation/fixed_weekly) assignment on a
    # nearby date, and forbid pairs whose time windows overlap.
    # Because a slot crossing midnight extends into the next day, the
    # overlap check has to cross dates too — for each var on date D
    # we compare against vars/pre-pins on D-1, D, and D+1.
    vars_by_person: dict[int, list[tuple[date, int, "cp_model.IntVar"]]] = defaultdict(
        list
    )
    for (d, slot_id, role_id, pid), var in x.items():
        vars_by_person[pid].append((d, slot_id, var))
    # Pre-pinned (forced) "variables" — represent as a date+slot tuple
    # with no IntVar; we bake them in by forbidding any conflicting
    # solver var.
    pre_pinned_by_person: dict[int, list[tuple[date, int]]] = defaultdict(list)
    for (pid, d_pin, s_pin) in pre_pinned_assignments:
        pre_pinned_by_person[pid].append((d_pin, s_pin))

    for pid, items in vars_by_person.items():
        # Solver-var vs solver-var pairs.
        for (d1, s1, v1), (d2, s2, v2) in itertools.combinations(items, 2):
            if abs((d1 - d2).days) > 1:
                continue
            slot_a = ctx.slot_by_id[s1]
            slot_b = ctx.slot_by_id[s2]
            if slots_overlap_in_time(slot_a, d1, slot_b, d2):
                model.Add(v1 + v2 <= 1)
        # Solver-var vs pre-pin pairs: pre-pin is forced =1 logically,
        # so any overlapping solver var must be =0.
        for d_pin, s_pin in pre_pinned_by_person.get(pid, ()):
            slot_pin = ctx.slot_by_id.get(s_pin)
            if slot_pin is None:
                continue
            for (d_v, s_v, v) in items:
                if abs((d_v - d_pin).days) > 1:
                    continue
                slot_v = ctx.slot_by_id[s_v]
                if slots_overlap_in_time(slot_pin, d_pin, slot_v, d_v):
                    model.Add(v == 0)

    # ---- Hard: same-slot exclusivity. ---
    # A person can fill at most one role of the same slot on the same
    # date. The time-overlap constraint above is a NO-OP for slots with
    # no start_time/end_time (on-call slots are explicitly allowed to
    # coexist with other slots in time terms), which leaves nothing
    # stopping the solver from picking the same person for two demands
    # of the same (date, slot_id) when those demands are different
    # team_role rows. This explicit constraint closes that hole.
    by_person_slot_day: dict[tuple[int, int, date], list] = defaultdict(list)
    for (d, slot_id, role_id, pid), var in x.items():
        by_person_slot_day[(pid, slot_id, d)].append(var)
    for (pid, slot_id, d), vars_ in by_person_slot_day.items():
        if len(vars_) > 1:
            model.Add(sum(vars_) <= 1)

    # ---- Hard: Latin-square role balance for team-pinned blocks. ----
    # Sprint 16: a "balance block" is a maximal run of consecutive dates
    # in ctx.dates where a team_composition slot has the SAME team
    # pinned by a rotation/fixed_weekly rule. Within that block we
    # require each (team member, role) pair to be covered ~uniformly:
    # if block length k and team size n are equal, that's exactly one
    # role per person per day → a Latin square (each person rotates
    # through every role exactly once across the block). When k != n,
    # each (person, role) pair is bounded by floor(k/n)..ceil(k/n).
    #
    # Ineligibility relaxes the constraint naturally — if person P
    # can't take role R on any day of the block (no x-variable
    # exists), the (P,R) constraint is skipped and other team members
    # pick up the slack via the per-demand head==N constraint above.
    by_slot_team_composition = [
        s for s in ctx.slots if s.staffing_mode == "team_composition"
    ]
    for slot in by_slot_team_composition:
        roles = ctx.team_roles_by_slot.get(slot.id, [])
        if not roles:
            continue
        # Walk ctx.dates in order, grouping consecutive same-team dates.
        current_team: tuple[int, ...] | None = None
        current_dates: list[date] = []

        def _emit_block(
            team: tuple[int, ...] | None,
            dates_: list[date],
        ) -> None:
            if not team or not dates_:
                return
            n = len(team)
            k = len(dates_)
            target_lo = k // n
            target_hi = (k + n - 1) // n  # ceil(k/n)
            for p in team:
                for r in roles:
                    vars_for_pair = [
                        x[(d_, slot.id, r.id, p)]
                        for d_ in dates_
                        if (d_, slot.id, r.id, p) in x
                    ]
                    if not vars_for_pair:
                        continue
                    if target_lo == target_hi:
                        model.Add(sum(vars_for_pair) == target_lo)
                    else:
                        model.Add(sum(vars_for_pair) >= target_lo)
                        model.Add(sum(vars_for_pair) <= target_hi)

        for d in ctx.dates:
            team_for_day = team_pinned_by_slot_day.get((slot.id, d))
            if team_for_day is None:
                _emit_block(current_team, current_dates)
                current_team = None
                current_dates = []
                continue
            tt = tuple(team_for_day)
            if current_team == tt:
                current_dates.append(d)
            else:
                _emit_block(current_team, current_dates)
                current_team = tt
                current_dates = [d]
        _emit_block(current_team, current_dates)

    # ---- Hard: post_slot_rest. ---
    # If slot S has post_slot_rest=True, anyone assigned on date D cannot
    # work any slot on D+1.
    by_person_day_any: dict[tuple[int, date], list] = defaultdict(list)
    for (d, slot_id, role_id, pid), var in x.items():
        by_person_day_any[(pid, d)].append(var)
    for (d, slot_id, role_id, pid), var in x.items():
        slot = ctx.slot_by_id[slot_id]
        if not slot.post_slot_rest:
            continue
        next_d = d + timedelta(days=1)
        nexts = by_person_day_any.get((pid, next_d), [])
        for nv in nexts:
            # var=1 implies nv=0 → var + nv <= 1.
            model.Add(var + nv <= 1)

    # ---- Hard: locked assignments. ---
    for (d, slot_id, role_id), locks in locked_by_key.items():
        for la in locks:
            if la.person_id is None:
                # Pinning an empty cell: forbid every person variable for
                # that (date, slot, role).
                cands = candidates_by_demand.get((d, slot_id, role_id), [])
                for pid in cands:
                    v = x.get((d, slot_id, role_id, pid))
                    if v is not None:
                        model.Add(v == 0)
                # And tighten head_target so we don't try to fill it.
                head_target[(d, slot_id, role_id)] = max(
                    0, head_target.get((d, slot_id, role_id), 0) - 1
                )
                # Re-issue the head==N constraint to reflect that.
                if cands:
                    model.Add(
                        sum(x[(d, slot_id, role_id, pid)] for pid in cands)
                        == head_target[(d, slot_id, role_id)]
                    )
                continue
            v = x.get((d, slot_id, role_id, la.person_id))
            if v is None:
                # Locked person no longer eligible (e.g. became blocked).
                # We honour the lock anyway by re-creating the variable
                # outside eligibility — simpler approach: add a forced row
                # post-solve. Mark target down, re-state constraint.
                continue
            model.Add(v == 1)

    # ---- Cross-slot dependencies (sprint 14). ----
    # We accumulate soft-objective contributions in soft_obj_terms here
    # and append them to obj_terms further down.
    soft_obj_terms: list = []

    # Index solver vars by (slot_id, date, person_id) -> var, for fast
    # succession/frequency-cap lookups. There's at most one var per
    # such triple (because role_id is collapsed: succession & frequency
    # caps are slot-level, not role-level).
    vars_by_sdp: dict[tuple[int, date, int], list] = defaultdict(list)
    for (d_, slot_id_, role_id_, pid_), var_ in x.items():
        vars_by_sdp[(slot_id_, d_, pid_)].append(var_)

    # Pre-pin index for the same key.
    prepin_by_sdp: set[tuple[int, date, int]] = set()
    for (pid_, d_, s_) in pre_pinned_assignments:
        prepin_by_sdp.add((s_, d_, pid_))

    # ---- Succession rules (same_person). ----
    # For each rule R: if person P works after_slot on day D, they
    # cannot (hard) / are penalized (soft) for working forbid_slot
    # on D' for D' in (D, D+R.days_after].
    period_dates_set = set(ctx.dates)
    person_ids_all = sorted(ctx.member_by_person_id.keys())
    for rule in ctx.succession_rules:
        a_slot = rule.after_slot_id
        b_slot = rule.forbid_slot_id
        # days_after=0 = same-day incompatibility (UI labels this as a
        # distinct rule type). days_after>=1 = next-N-days succession.
        offsets = [0] if rule.days_after == 0 else range(1, rule.days_after + 1)
        for D in ctx.dates:
            for offset in offsets:
                Dp = D + timedelta(days=offset)
                if Dp not in period_dates_set:
                    continue
                for P in person_ids_all:
                    a_vars = list(vars_by_sdp.get((a_slot, D, P), []))
                    b_vars = list(vars_by_sdp.get((b_slot, Dp, P), []))
                    a_pinned = (a_slot, D, P) in prepin_by_sdp
                    b_pinned = (b_slot, Dp, P) in prepin_by_sdp

                    # If both sides are pre-pinned: schema-level conflict.
                    # Skip — there's nothing the solver can do; admin
                    # config conflict surfaces as a normal assignment
                    # collision. (We don't try to silently break the
                    # rotation here.)
                    if a_pinned and b_pinned:
                        continue
                    # If pinned on the "after" side, the "before -> after"
                    # implication collapses to "forbid b". And vice versa.
                    if rule.severity == "hard":
                        if a_pinned:
                            for bv in b_vars:
                                model.Add(bv == 0)
                            continue
                        if b_pinned:
                            for av in a_vars:
                                model.Add(av == 0)
                            continue
                        if not a_vars or not b_vars:
                            continue
                        # Pairwise: a + b <= 1 for each (a, b).
                        for av in a_vars:
                            for bv in b_vars:
                                model.Add(av + bv <= 1)
                    else:
                        # Soft: penalize each (a, b) co-occurrence by weight.
                        if a_pinned:
                            for bv in b_vars:
                                soft_obj_terms.append(rule.weight * bv)
                            continue
                        if b_pinned:
                            for av in a_vars:
                                soft_obj_terms.append(rule.weight * av)
                            continue
                        if not a_vars or not b_vars:
                            continue
                        for av in a_vars:
                            for bv in b_vars:
                                # Penalty indicator z s.t. z >= a + b - 1.
                                z = model.NewBoolVar(
                                    f"succ_r{rule.id}_{D}_{Dp}_p{P}_{id(av)}_{id(bv)}"
                                )
                                model.Add(z >= av + bv - 1)
                                soft_obj_terms.append(rule.weight * z)

    # ---- Frequency caps. ----
    # For each cap on slot S with period type T:
    #   For each person P, for each window W in T:
    #     count = sum(vars where (slot=S, date in W, person=P))
    #          + sum(prior_published_counts for (P, S, d in W))
    #     hard:  count <= max_count
    #     soft:  excess >= count - max_count;  obj += weight * excess
    def _cap_windows(period: str) -> list[tuple[date, list[date]]]:
        """Return list of (anchor_date, [days in window]) for the given
        period. For rolling_*, anchor is the trailing day D and window is
        [D-N+1, D]. For iso_week / calendar_month, anchor is the first
        date in the period that falls in that bucket and the window is
        the full bucket clipped to the period."""
        out: list[tuple[date, list[date]]] = []
        if period.startswith("rolling_"):
            n = int(period.split("_")[1])
            for D in ctx.dates:
                window = [D - timedelta(days=k) for k in range(n - 1, -1, -1)]
                out.append((D, window))
            return out
        if period == "iso_week":
            seen: dict[tuple[int, int], list[date]] = defaultdict(list)
            for D in ctx.dates:
                key = D.isocalendar()[:2]
                seen[key].append(D)
            for key, days in seen.items():
                out.append((days[0], days))
            return out
        if period == "calendar_month":
            seen2: dict[tuple[int, int], list[date]] = defaultdict(list)
            for D in ctx.dates:
                key = (D.year, D.month)
                seen2[key].append(D)
            for key, days in seen2.items():
                out.append((days[0], days))
            return out
        return out

    for cap in ctx.frequency_caps:
        windows = _cap_windows(cap.period)
        for anchor, days in windows:
            for P in person_ids_all:
                window_vars: list = []
                for d_ in days:
                    if d_ in period_dates_set:
                        window_vars.extend(vars_by_sdp.get((cap.slot_id, d_, P), []))
                # Pre-pinned in-period assignments to that slot count.
                prior_in_period = sum(
                    1
                    for d_ in days
                    if d_ in period_dates_set
                    and (cap.slot_id, d_, P) in prepin_by_sdp
                )
                # Pre-existing published assignments OUTSIDE the period
                # (only meaningful for rolling windows that look back).
                prior_outside = 0
                if cap.period.startswith("rolling_"):
                    for d_ in days:
                        if d_ in period_dates_set:
                            continue
                        prior_outside += ctx.prior_published_counts.get(
                            (P, cap.slot_id, d_), 0
                        )
                base = prior_in_period + prior_outside
                if not window_vars and base == 0:
                    continue  # nothing to constrain
                if cap.severity == "hard":
                    if window_vars:
                        model.Add(sum(window_vars) + base <= cap.max_count)
                    elif base > cap.max_count:
                        # Pre-pinned config already exceeds the cap; nothing
                        # the solver can do. Log & skip.
                        logger.warning(
                            "Frequency cap exceeded by pre-pinned/prior data: "
                            "person=%s slot=%s anchor=%s base=%d cap=%d",
                            P,
                            cap.slot_id,
                            anchor,
                            base,
                            cap.max_count,
                        )
                else:
                    # Soft: excess = max(0, sum + base - max_count).
                    if not window_vars:
                        continue
                    bound = len(window_vars) + base
                    excess = model.NewIntVar(
                        0, max(1, bound), f"freq_excess_c{cap.id}_a{anchor}_p{P}"
                    )
                    model.Add(excess >= sum(window_vars) + base - cap.max_count)
                    soft_obj_terms.append(cap.weight * excess)

    # ---- Objective: fairness (counts_for_equity, FTE-weighted). ----
    # We minimize max - min of weighted counts. Weights are int100/fte_pct
    # to make the LP integer.
    #
    # Slots are bucketed by `equity_group_key`. Slots that share a key
    # balance together (e.g. "guardia" → all guardia variants split
    # evenly among the eligible people). Slots with key=NULL each form
    # their OWN single-slot group — every slot balances independently
    # by default, and an admin opts INTO grouped-balance by setting the
    # same key on multiple slots. (Earlier behavior was the opposite —
    # all NULL-group slots in one bucket — but that produced "person X
    # does 100% of localizadas while totals look balanced" because the
    # localizada slot was lumped with quirófanos and consultas.)
    # Weekend balance stays a single global term (weighed less; it's a
    # cross-group sanity check rather than a primary fairness dimension).
    person_ids_present = sorted({pid for (_, _, _, pid) in x.keys()})
    equity_groups: dict[str, dict[int, list]] = defaultdict(
        lambda: {pid: [] for pid in person_ids_present}
    )
    weekend_total: dict[int, list] = {pid: [] for pid in person_ids_present}

    for (d, slot_id, role_id, pid), var in x.items():
        slot = ctx.slot_by_id[slot_id]
        if slot.counts_for_equity:
            # NULL key → unique per-slot bucket. Explicit key → shared.
            group_key = (
                slot.equity_group_key
                if slot.equity_group_key
                else f"_slot_{slot.id}"
            )
            equity_groups[group_key][pid].append(var)
            if is_weekend_or_holiday[d]:
                weekend_total[pid].append(var)

    obj_terms: list = []

    def _balance_term(buckets: dict[int, list], weight: int, label: str) -> None:
        """Build (max - min) of weighted-by-FTE sums across buckets and add
        weight*(max-min) to obj_terms. `label` is used to disambiguate
        IntVar names when the helper is called more than once (e.g. one
        call per equity_group_key)."""
        if not buckets:
            return
        # Multiply each person's sum by 100 // fte to FTE-normalize. We
        # use integer scaling to keep the model integer-only.
        scaled: list = []
        for pid, vars_ in buckets.items():
            if not vars_:
                # A person with zero variables in this bucket still
                # participates as a constant 0 — that pushes "min" down to
                # 0 if they exist at all in this category. We still want
                # them counted because a fully-idle eligible member is
                # exactly the unfair case fairness should punish.
                m = ctx.member_by_person_id.get(pid)
                if not m:
                    continue
                scaled.append(model.NewConstant(0))
                continue
            m = ctx.member_by_person_id.get(pid)
            fte = max(1, m.fte_pct if m else 100)
            # scale = 100 / fte (integer) * sum. To keep integer math:
            # scaled_pid = sum(vars) * 100 // fte == sum * scale_num // scale_den
            # CP-SAT only accepts linear int expressions; emulate by
            # introducing IntVar = sum(vars)*100, then use AddDivisionEquality.
            raw = model.NewIntVar(0, 10000, f"raw_{label}_p{pid}")
            model.Add(raw == sum(vars_) * 100)
            div = model.NewIntVar(0, 10000, f"sc_{label}_p{pid}")
            model.AddDivisionEquality(div, raw, fte)
            scaled.append(div)
        if len(scaled) < 2:
            return
        max_var = model.NewIntVar(0, 10000, f"max_{label}")
        min_var = model.NewIntVar(0, 10000, f"min_{label}")
        model.AddMaxEquality(max_var, scaled)
        model.AddMinEquality(min_var, scaled)
        spread = model.NewIntVar(0, 10000, f"spread_{label}")
        model.Add(spread == max_var - min_var)
        obj_terms.append(weight * spread)

    # One balance term per group. Explicit keys (e.g. "guardia") share a
    # term across all slots that opted in; synthetic _slot_{id} keys
    # produce a per-slot term so each slot self-balances by default.
    for group_key, buckets in equity_groups.items():
        # Sanitize the group key for use in CP-SAT variable names (which
        # don't tolerate weird chars). "default" for the NULL bucket.
        safe = "default" if group_key is None else "".join(
            c if c.isalnum() else "_" for c in group_key
        )[:24]
        _balance_term(buckets, W_FAIRNESS, f"eq_{safe}")

    _balance_term(weekend_total, W_WEEKEND, "weekend")

    # ---- Soft skill term: weight per missing soft skill per assignment. ----
    for (d, slot_id, role_id, pid), var in x.items():
        soft = ctx.slot_soft_skills.get(slot_id, set())
        if not soft:
            continue
        missing = soft - ctx.person_skills.get(pid, set())
        if missing:
            obj_terms.append(W_SOFT_SKILL * len(missing) * var)

    # ---- Guardia spread: penalize same-person guardia assignments < 4d apart. ----
    # We approximate by: for each pair of guardia variables for the same
    # person on dates d1 < d2 with (d2-d1) < GUARDIA_MIN_GAP_DAYS, add a
    # penalty (gap_shortfall) * weight whenever both = 1.
    # Implementation: introduce a Bool z = AND(var1, var2); add
    # weight * (GAP - delta) * z.
    g_by_person: dict[int, list[tuple[date, "cp_model.IntVar"]]] = defaultdict(list)
    for (d, slot_id, role_id, pid), var in x.items():
        if is_guardia_demand.get((d, slot_id, role_id), False):
            g_by_person[pid].append((d, var))
    for pid, items in g_by_person.items():
        items_sorted = sorted(items, key=lambda t: t[0])
        for i in range(len(items_sorted)):
            d1, v1 = items_sorted[i]
            for j in range(i + 1, len(items_sorted)):
                d2, v2 = items_sorted[j]
                delta = (d2 - d1).days
                if delta == 0:
                    # Same day handled by per-day-uniqueness; skip.
                    continue
                if delta >= GUARDIA_MIN_GAP_DAYS:
                    break  # sorted ascending — further j are even further
                shortfall = GUARDIA_MIN_GAP_DAYS - delta
                z = model.NewBoolVar(f"g_p{pid}_{d1}_{d2}")
                model.AddBoolAnd([v1, v2]).OnlyEnforceIf(z)
                model.AddBoolOr([v1.Not(), v2.Not()]).OnlyEnforceIf(z.Not())
                obj_terms.append(W_GUARDIA_SPREAD * shortfall * z)

    if soft_obj_terms:
        obj_terms.extend(soft_obj_terms)
    if obj_terms:
        model.Minimize(sum(obj_terms))

    # ---- Solve ----
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(settings.solver_max_seconds)
    solver.parameters.num_search_workers = settings.solver_workers
    status = solver.Solve(model)

    status_name = solver.StatusName(status)
    obj_val = solver.ObjectiveValue() if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None
    logger.info(
        "CP-SAT solver: status=%s objective=%s wall=%.2fs vars=%d demands=%d",
        status_name,
        obj_val,
        solver.WallTime(),
        len(x),
        len(demands),
    )

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        logger.warning(
            "CP-SAT could not find a feasible solution (status=%s) — falling back to greedy",
            status_name,
        )
        # Diagnostic: count the most likely culprits so we don't have to
        # poke at logs blind.
        _log_infeasibility_diagnostic(
            ctx=ctx,
            demands=demands,
            candidates_by_demand=candidates_by_demand,
            pre_pinned_assignments=pre_pinned_assignments,
            pre_busy=pre_busy,
            pre_rest_block=pre_rest_block,
        )
        return False

    # ---- Materialize the solution. ---
    chosen_per_demand: dict[tuple[date, int, int | None], list[int]] = defaultdict(list)
    for (d, slot_id, role_id, pid), var in x.items():
        if solver.Value(var) == 1:
            chosen_per_demand[(d, slot_id, role_id)].append(pid)

    for (d, slot_id, role_id, head) in demands:
        chosen = chosen_per_demand.get((d, slot_id, role_id), [])
        # Locked rows for this key.
        locks_here = locked_by_key.get((d, slot_id, role_id), [])
        # Emit locks first verbatim.
        for la in locks_here:
            db.add(
                Assignment(
                    tenant_id=ctx.tenant_id,
                    schedule_id=schedule.id,
                    slot_id=slot_id,
                    date=d,
                    person_id=la.person_id,
                    team_role_id=role_id,
                    notes=la.notes,
                    **{
                        k: v
                        for k, v in (
                            ("locked_at", getattr(la, "locked_at", None)),
                            (
                                "locked_by_membership_id",
                                getattr(la, "locked_by_membership_id", None),
                            ),
                        )
                        if v is not None
                    },
                )
            )
        # Unlocked picks. Avoid double-emitting the locked person.
        locked_pids = {la.person_id for la in locks_here if la.person_id is not None}
        for pid in chosen:
            if pid in locked_pids:
                continue
            db.add(
                Assignment(
                    tenant_id=ctx.tenant_id,
                    schedule_id=schedule.id,
                    slot_id=slot_id,
                    date=d,
                    person_id=pid,
                    team_role_id=role_id,
                )
            )
        # Unfilled gap (eligible candidates < headcount, or empty locks).
        emitted = len(locks_here) + len([p for p in chosen if p not in locked_pids])
        for _ in range(head - emitted):
            slot = ctx.slot_by_id[slot_id]
            logger.warning(
                "Unfilled assignment: slot=%s date=%s role=%s — no eligible person",
                slot.name,
                d.isoformat(),
                role_id,
            )
            db.add(
                Assignment(
                    tenant_id=ctx.tenant_id,
                    schedule_id=schedule.id,
                    slot_id=slot_id,
                    date=d,
                    person_id=None,
                    team_role_id=role_id,
                    notes="No hay personal disponible",
                )
            )

    return True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_draft(
    db: Session,
    *,
    tenant_id: int,
    period: date,
    membership_id: int | None,
    locked: list[Assignment] | None = None,
) -> Schedule:
    """Generate a draft schedule for `period`. Caller is responsible for
    deleting any existing draft first. `locked` is an optional list of
    pre-existing Assignment rows (from a prior schedule for the same
    period) to preserve verbatim — the solver pins them.
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

    ok = _solve_cpsat(db, ctx, schedule, locked=locked)
    if ok:
        schedule.solver_used = "cpsat"
    else:
        # CP-SAT failed (typically INFEASIBLE). It writes pre-pins for
        # rotation/fixed_weekly rules BEFORE solving — those rows are
        # pending in the session. We need to wipe them before greedy runs
        # or non-solver slots end up with both pre-pins + greedy picks.
        #
        # Session has autoflush=False (see app/db/session.py), so a plain
        # db.query won't see pending adds and the wipe silently no-ops.
        # Force a flush first so the pre-pins hit the DB, then bulk
        # DELETE them by schedule_id.
        db.flush()
        db.query(Assignment).filter(
            Assignment.schedule_id == schedule.id
        ).delete(synchronize_session=False)
        db.flush()
        _greedy_fallback(db, ctx, schedule, locked=locked)
        schedule.solver_used = "greedy"

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


def unarchive(db: Session, schedule: Schedule) -> None:
    """Flip archived → published. The schedule re-enters the live
    /me/turnos dropdown and can again be swapped on.

    Period-uniqueness still holds, so if the period already has a
    *different* published schedule (shouldn't happen given the UNIQUE
    constraint, but defensive) the caller gets the IntegrityError on
    flush — surfacing it as a 409 from the route is fine."""
    if schedule.status != "archived":
        return
    schedule.status = "published"
    db.flush()

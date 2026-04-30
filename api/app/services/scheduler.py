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
    SlotSkillRequired,
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
    pre_picked_per_day: dict[date, set[int]] = defaultdict(set)
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
            pre_picked_per_day[la.date].add(la.person_id)
    locked_keys = {(la.date, la.slot_id, la.team_role_id) for la in locked}

    def pick(candidates: list[int], picked_today: set[int]) -> int | None:
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
                if (d, slot.id, None) in locked_keys:
                    continue
                head = 1 if mode == "single" else max(1, slot.headcount)
                cands = ctx.candidates_for_slot(slot, d)
                picked: set[int] = set(pre_picked_per_day[d])
                fresh: set[int] = set()
                for _ in range(head):
                    pid = pick(cands, picked)
                    if pid is None:
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
                    picked.add(pid)
                    fresh.add(pid)
                    counts[pid] += 1
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
                pre_picked_per_day[d] |= fresh
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
                picked_for_slot: set[int] = set(pre_picked_per_day[d])
                for role in roles:
                    if (d, slot.id, role.id) in locked_keys:
                        continue
                    cands = ctx.candidates_for_slot(slot, d, team_role_id=role.id)
                    for _ in range(max(1, role.headcount)):
                        pid = pick(cands, picked_for_slot)
                        if pid is None:
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
                        picked_for_slot.add(pid)
                        counts[pid] += 1
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
                pre_picked_per_day[d] |= picked_for_slot


# ---------------------------------------------------------------------------
# CP-SAT solver
# ---------------------------------------------------------------------------


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

    for d in ctx.dates:
        for slot in ctx.slots:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                continue
            mode = slot.staffing_mode
            if mode in ("single", "multiple_same"):
                head = 1 if mode == "single" else max(1, slot.headcount)
                demands.append((d, slot.id, None, head))
                is_guardia_demand[(d, slot.id, None)] = bool(slot.guardia_type)
            elif mode == "team_composition":
                roles = ctx.team_roles_by_slot.get(slot.id, [])
                if not roles:
                    # Emit a placeholder unfilled and skip — solver can't
                    # do anything with no roles.
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
                for role in roles:
                    demands.append((d, slot.id, role.id, max(1, role.headcount)))
                    is_guardia_demand[(d, slot.id, role.id)] = bool(slot.guardia_type)

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

    # ---- Hard: at most one slot per person per day. ---
    by_person_day: dict[tuple[int, date], list] = defaultdict(list)
    for (d, slot_id, role_id, pid), var in x.items():
        by_person_day[(pid, d)].append(var)
    for vars_ in by_person_day.values():
        if len(vars_) > 1:
            model.Add(sum(vars_) <= 1)

    # ---- Hard: post_slot_rest. ---
    # If slot S has post_slot_rest=True, anyone assigned on date D cannot
    # work any slot on D+1.
    by_person_day_any: dict[tuple[int, date], list] = by_person_day
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

    # ---- Objective: fairness (counts_for_equity, FTE-weighted). ----
    # We minimize max - min of weighted counts. Weights are int100/fte_pct
    # to make the LP integer.
    person_ids_present = sorted({pid for (_, _, _, pid) in x.keys()})
    equity_total: dict[int, list] = {pid: [] for pid in person_ids_present}
    weekend_total: dict[int, list] = {pid: [] for pid in person_ids_present}

    for (d, slot_id, role_id, pid), var in x.items():
        slot = ctx.slot_by_id[slot_id]
        if slot.counts_for_equity:
            equity_total[pid].append(var)
            if is_weekend_or_holiday[d]:
                weekend_total[pid].append(var)

    obj_terms: list = []

    def _balance_term(buckets: dict[int, list], weight: int) -> None:
        """Build (max - min) of weighted-by-FTE sums across buckets and add
        weight*(max-min) to obj_terms."""
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
            raw = model.NewIntVar(0, 10000, f"raw_p{pid}")
            model.Add(raw == sum(vars_) * 100)
            div = model.NewIntVar(0, 10000, f"sc_p{pid}")
            model.AddDivisionEquality(div, raw, fte)
            scaled.append(div)
        if len(scaled) < 2:
            return
        max_var = model.NewIntVar(0, 10000, "max_v")
        min_var = model.NewIntVar(0, 10000, "min_v")
        model.AddMaxEquality(max_var, scaled)
        model.AddMinEquality(min_var, scaled)
        spread = model.NewIntVar(0, 10000, "spread")
        model.Add(spread == max_var - min_var)
        obj_terms.append(weight * spread)

    _balance_term(equity_total, W_FAIRNESS)
    _balance_term(weekend_total, W_WEEKEND)

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
    if not ok:
        # Wipe whatever the solver emitted (none, but be defensive) and
        # try the greedy fallback.
        for a in (
            db.query(Assignment)
            .filter(Assignment.schedule_id == schedule.id)
            .all()
        ):
            db.delete(a)
        db.flush()
        _greedy_fallback(db, ctx, schedule, locked=locked)

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

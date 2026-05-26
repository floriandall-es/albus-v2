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
  membership is active (disabled_at IS NULL), slot allow-list (if any
  rows in slot_allowed_persons), team-role categories, approved
  availability blocks.
- post_slot_rest=True: assignment on day D forbids any assignment on D+1.
- Locked assignments (Sprint 5 part B) are pinned: the variable is forced
  to 1 and competing variables on the same (date, slot, role) are forced
  off.

Soft objective (minimize):
- Fairness: spread `counts_for_equity=True` assignments evenly,
  FTE-weighted (max - min of count*100/fte_pct, weight 10).
- Weekend balance: same idea but only counting weekend/holiday work
  (weight 5).
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
    PeriodoEspecial,
    Schedule,
    Slot,
    SlotAllowedPerson,
    SlotCategory,
    SlotFrequencyCap,
    SlotFrequencyCapPeriodOverride,
    SlotPeriodOverride,
    SlotRule,
    SlotRulePeriodOverride,
    SlotRuleRotationBlock,
    SlotRuleRotationMember,
    SlotRuleWeeklyPin,
    SlotSuccessionRule,
    SlotSuccessionRulePeriodOverride,
    SlotTeamRole,
    SlotTeamRoleCategory,
)

logger = logging.getLogger("app.scheduler")


# ---------------------------------------------------------------------------
# Objective weights
# ---------------------------------------------------------------------------

W_FAIRNESS = 10
W_WEEKEND = 5
# Sprint 16: per-role equity inside team_composition slots. Lower
# than W_FAIRNESS so the slot-level total balance stays the
# primary signal; this is a secondary "and the role split should
# also be roughly even" objective.
W_ROLE_BALANCE = 5
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

    def __init__(
        self,
        db: Session,
        tenant_id: int,
        period: date,
        *,
        dates: list[date] | None = None,
    ):
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

        # Per-slot allow-list (the post-0030 unified eligibility filter).
        # A slot with NO rows here = "Todo el equipo" / no restriction.
        # A slot with one or more rows = ONLY those persons are eligible.
        self.slot_allowed_persons: dict[int, set[int]] = defaultdict(set)
        for sap in db.query(SlotAllowedPerson).all():
            self.slot_allowed_persons[sap.slot_id].add(sap.person_id)
        # Per-slot categoría restriction (sprint 28 / migration 0048).
        # Same semantics as the allow-list above but on categoría
        # rather than person. Empty = unrestricted; non-empty = only
        # members whose categoría is in the set are eligible. Applies
        # to single + multiple_same modes; team_composition still
        # primarily relies on team_role_categories, with this filter
        # as an additional constraint when both are set.
        self.slot_categories: dict[int, set[int]] = defaultdict(set)
        for sc in db.query(SlotCategory).all():
            self.slot_categories[sc.slot_id].add(sc.category_id)

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

        # V.1 vacation feature: callers solving a multi-month period pass
        # the explicit `dates` list (full calendar months concatenated, e.g.
        # Jul 1 – Aug 31 for a Jul 15 – Aug 31 period). Legacy single-month
        # callers omit it and we default to the anchor month. `period_start`
        # and `period_end` below work the same way either way — they're
        # just the bounds of the `days` list.
        days = list(dates) if dates is not None else _dates_in_month(period)
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

        # ----------------------------------------------------------------
        # Periodos especiales + slot overrides (V.1 vacation feature).
        # We load every periodo whose [start_date, end_date] intersects
        # the solve range, plus their slot overrides. The helper methods
        # below (effective_*) then resolve slot config per (slot, date)
        # consulting any active override; callers that don't care about
        # periods get the default config unchanged.
        # ----------------------------------------------------------------
        self.periodos: list[PeriodoEspecial] = (
            db.query(PeriodoEspecial)
            .filter(
                PeriodoEspecial.end_date >= period_start,
                PeriodoEspecial.start_date <= period_end,
            )
            .all()
        )
        # date → period_id (or absent when no period covers d). Built
        # once for O(1) lookup. Periods are non-overlapping per tenant
        # (DB exclusion constraint), so at most one period per date.
        self.period_id_by_date: dict[date, int] = {}
        for p in self.periodos:
            for d in days:
                if p.start_date <= d <= p.end_date:
                    self.period_id_by_date[d] = p.id
        # (slot_id, period_id) → SlotPeriodOverride row. Only the
        # overrides whose period intersects the solve range are
        # loaded; a missing key means "no override, use slot default."
        self.overrides_by_slot_period: dict[
            tuple[int, int], SlotPeriodOverride
        ] = {}
        # V.2: per-(rule/succession/cap, period) overrides. Same
        # delta-style — only rows that actually differ from the
        # default exist. Lookup is by (target_id, period_id).
        self.rule_overrides_by_rule_period: dict[
            tuple[int, int], SlotRulePeriodOverride
        ] = {}
        self.succession_overrides_by_rule_period: dict[
            tuple[int, int], SlotSuccessionRulePeriodOverride
        ] = {}
        self.cap_overrides_by_cap_period: dict[
            tuple[int, int], SlotFrequencyCapPeriodOverride
        ] = {}
        if self.periodos:
            period_ids = [p.id for p in self.periodos]
            for o in (
                db.query(SlotPeriodOverride)
                .filter(SlotPeriodOverride.period_id.in_(period_ids))
                .all()
            ):
                self.overrides_by_slot_period[(o.slot_id, o.period_id)] = o
            for o in (
                db.query(SlotRulePeriodOverride)
                .filter(SlotRulePeriodOverride.period_id.in_(period_ids))
                .all()
            ):
                self.rule_overrides_by_rule_period[
                    (o.rule_id, o.period_id)
                ] = o
            for o in (
                db.query(SlotSuccessionRulePeriodOverride)
                .filter(
                    SlotSuccessionRulePeriodOverride.period_id.in_(period_ids)
                )
                .all()
            ):
                self.succession_overrides_by_rule_period[
                    (o.succession_rule_id, o.period_id)
                ] = o
            for o in (
                db.query(SlotFrequencyCapPeriodOverride)
                .filter(
                    SlotFrequencyCapPeriodOverride.period_id.in_(period_ids)
                )
                .all()
            ):
                self.cap_overrides_by_cap_period[(o.cap_id, o.period_id)] = o

        # Pre-existing published assignments BEFORE the period are needed
        # to evaluate rolling-window frequency caps at the start of the
        # period. Look back rolling_28 days max — that's the longest
        # supported window. Drafts don't count (they're tentative).
        lookback_start = period_start - timedelta(days=28)
        # Sprint 17: key includes team_role_id (nullable) so frequency
        # caps can look up role-filtered prior counts without losing
        # the slot-wide view. Slot-wide callers sum over the role
        # dimension via prior_published_count() below.
        self.prior_published_counts: dict[
            tuple[int, int, int | None, date], int
        ] = defaultdict(int)
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
            key = (a.person_id, a.slot_id, a.team_role_id, a.date)
            self.prior_published_counts[key] += 1

    # ---------------------------------------------------------------
    # Period-aware effective config getters (V.1 vacation feature).
    # Every callsite that needs slot.headcount / slot.staffing_mode /
    # the allow-list / the categoría restriction should go through
    # these helpers instead of reading the Slot column directly. For
    # dates not inside any periodo, the helpers return the slot's
    # default — same semantics as before the feature shipped.
    # ---------------------------------------------------------------
    def _slot_override(
        self, slot_id: int, d: date
    ) -> SlotPeriodOverride | None:
        pid = self.period_id_by_date.get(d)
        if pid is None:
            return None
        return self.overrides_by_slot_period.get((slot_id, pid))

    def is_period_dismissed(self, slot_id: int, d: date) -> bool:
        """True when an active periodo override marks this slot as
        not running on date d. Callers should skip demand generation
        for the (slot, date) pair entirely."""
        ovr = self._slot_override(slot_id, d)
        return bool(ovr and ovr.dismissed)

    def effective_headcount(self, slot: Slot, d: date) -> int:
        ovr = self._slot_override(slot.id, d)
        if ovr and ovr.headcount_override is not None:
            return ovr.headcount_override
        return slot.headcount

    def effective_staffing_mode(self, slot: Slot, d: date) -> str:
        """Returns the staffing_mode that should apply for this
        (slot, date). V.1 stores the override but the demand
        generator doesn't switch shape mid-period yet — flipping
        between single and team_composition requires more solver
        plumbing (V.2). For now the helper is here so callers that
        DO care (the future per-rule strategy override) can use it."""
        ovr = self._slot_override(slot.id, d)
        if ovr and ovr.staffing_mode_override is not None:
            return ovr.staffing_mode_override
        return slot.staffing_mode

    def effective_allowed_persons(self, slot_id: int, d: date) -> set[int]:
        """Returns the eligible-person set for (slot, date). An empty
        set means "no restriction" — matches the existing semantics
        for slots with no SlotAllowedPerson rows. Override semantics:
          - NULL → use the slot's default list
          - [] → drop the restriction entirely during the period
          - [a, b, ...] → restrict to exactly that set during the period
        """
        ovr = self._slot_override(slot_id, d)
        if ovr and ovr.allowed_person_ids_override is not None:
            return set(ovr.allowed_person_ids_override)
        return set(self.slot_allowed_persons.get(slot_id, set()))

    def effective_allowed_categories(self, slot_id: int, d: date) -> set[int]:
        """Same semantics as effective_allowed_persons but for the
        slot-level categoría restriction (SlotCategory rows)."""
        ovr = self._slot_override(slot_id, d)
        if ovr and ovr.allowed_category_ids_override is not None:
            return set(ovr.allowed_category_ids_override)
        return set(self.slot_categories.get(slot_id, set()))

    # ---------------------------------------------------------------
    # V.2 effective-rule helpers. Each takes the target row + a date
    # and returns either:
    #   - (effective_value, False)   — the override is "active" but
    #                                  the rule still fires; the
    #                                  caller uses effective_value
    #                                  in place of the default.
    #   - (_, True)                  — the rule/cap is fully disabled
    #                                  on this date. Caller skips
    #                                  emitting any constraint/penalty.
    # The wrapping is verbose but explicit; callers don't have to
    # juggle None semantics or check `disabled` separately.
    # ---------------------------------------------------------------
    def effective_rule_strategy(self, rule: SlotRule, d: date) -> tuple[str, bool]:
        """Return (strategy, disabled). When disabled, the rule's
        weekday-bitmap match falls through to "no rule applies" —
        same as if the admin had no rule for that weekday."""
        pid = self.period_id_by_date.get(d)
        if pid is None:
            return rule.strategy, False
        ovr = self.rule_overrides_by_rule_period.get((rule.id, pid))
        if ovr is None:
            return rule.strategy, False
        if ovr.disabled:
            return rule.strategy, True
        if ovr.strategy_override is not None:
            return ovr.strategy_override, False
        return rule.strategy, False

    def effective_succession_rule(
        self, rule: SlotSuccessionRule, d: date
    ) -> tuple[int, str, bool]:
        """Return (days_after, severity, disabled). When disabled,
        the rule emits nothing for date d."""
        pid = self.period_id_by_date.get(d)
        if pid is None:
            return rule.days_after, rule.severity, False
        ovr = self.succession_overrides_by_rule_period.get((rule.id, pid))
        if ovr is None:
            return rule.days_after, rule.severity, False
        if ovr.disabled:
            return rule.days_after, rule.severity, True
        return (
            ovr.days_after_override
            if ovr.days_after_override is not None
            else rule.days_after,
            ovr.severity_override or rule.severity,
            False,
        )

    def effective_frequency_cap(
        self, cap: SlotFrequencyCap, d: date
    ) -> tuple[int, str, bool]:
        """Return (max_count, severity, disabled). When disabled, the
        cap doesn't constrain date d."""
        pid = self.period_id_by_date.get(d)
        if pid is None:
            return cap.max_count, cap.severity, False
        ovr = self.cap_overrides_by_cap_period.get((cap.id, pid))
        if ovr is None:
            return cap.max_count, cap.severity, False
        if ovr.disabled:
            return cap.max_count, cap.severity, True
        return (
            ovr.max_count_override
            if ovr.max_count_override is not None
            else cap.max_count,
            ovr.severity_override or cap.severity,
            False,
        )

    def prior_published_count(
        self,
        person_id: int,
        slot_id: int,
        role_filter: int | None,
        d: date,
    ) -> int:
        """Sprint 17: look up prior published count for a person on
        a slot/date. When `role_filter` is set, only that role
        counts; otherwise sum across all roles (the legacy
        slot-wide behavior)."""
        if role_filter is not None:
            return self.prior_published_counts.get(
                (person_id, slot_id, role_filter, d), 0
            )
        total = 0
        # Sum the (person, slot, *, date) slice. Small dict; the
        # full scan is fine.
        for (pid, sid, _rid, dd), n in self.prior_published_counts.items():
            if pid == person_id and sid == slot_id and dd == d:
                total += n
        return total

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

        V.2 vacation feature: if the matching rule has an active
        period override marking it `disabled`, return None — same
        semantics as "no rule applies." The slot falls through to
        the no-rule branch (no demand emitted, cell stays empty).
        """
        wd = d.weekday()
        bit = 1 << wd
        for r in self.rules_by_slot.get(slot_id, ()):
            if r.days_bitmap & bit:
                _, disabled = self.effective_rule_strategy(r, d)
                if disabled:
                    return None
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
        # `weeks_per_position` slows the week-to-week advance: each
        # position holds the slot for N weeks before the rotation
        # steps. Default 1 = historical behaviour (one position per
        # week step). Within-week block-rotation is unaffected —
        # daily-block rotations still rotate daily inside a week.
        weeks_step = (
            getattr(rule, "weeks_per_position", None) or 1
        )
        # Python % is non-negative for negative dividends.
        target_pos = positions_sorted[
            (rank + (weeks // weeks_step) * k) % p_count
        ]
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

    def team_block_rank_for(self, rule: SlotRule, d: date) -> int:
        """Return how many blocks of the SAME rotation team have
        elapsed since anchor_date, up to (and including) the block
        containing date d.

        Used by the team_composition Latin-rectangle role rotation:
        the per-block role-permutation is shifted by this value so the
        same team doesn't always cover the same role on the same
        weekday across consecutive on-call weekends.

        Derivation: rotation_persons_for() picks
            target_pos = positions_sorted[(rank + (weeks // weeks_step) * k) % p_count]
        which is equivalent to indexing by an `advance_counter` that
        increments by 1 per calendar block (within-week, then crossing
        weeks). The block rank for a given team is then
            advance_counter // p_count.

        Returns 0 when the rule is missing anchor_date, blocks, members
        or positions — same defensive defaults as rotation_persons_for.
        """
        if rule.anchor_date is None:
            return 0
        blocks = self.rotation_blocks_by_rule.get(rule.id, [])
        members = self.rotation_members_by_rule.get(rule.id, [])
        if not blocks or not members:
            return 0
        wd = d.weekday()
        bit = 1 << wd
        b_idx: int | None = None
        for i, b in enumerate(blocks):
            if b.days_bitmap & bit:
                b_idx = i
                break
        if b_idx is None:
            return 0
        positions_sorted = sorted({m.position for m in members})
        p_count = len(positions_sorted)
        if p_count == 0:
            return 0
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
        weeks_step = getattr(rule, "weeks_per_position", None) or 1
        advance_counter = (weeks // weeks_step) * k + rank
        return advance_counter // p_count

    def fixed_weekly_persons(self, rule: SlotRule, d: date) -> list[int]:
        """Return the pinned person_ids for the (rule, weekday) pair."""
        return list(self.weekly_pins_by_rule.get(rule.id, {}).get(d.weekday(), []))

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
        # Disabled membership (Sprint 22 / migration 0032). Pause flag
        # for maternity leave, sabbaticals, etc. Past assignments stay;
        # new ones don't get generated.
        if m.disabled_at is not None:
            return "La persona está desactivada en el equipo"
        # Slot allow-list (post-0030 replacement for pool + skill filters).
        # Period overrides can swap the set or drop the restriction entirely
        # for dates inside an active periodo; effective_allowed_persons
        # returns the empty set when there's no restriction, matching the
        # default's "missing rows" semantics.
        allowed = self.effective_allowed_persons(slot.id, d)
        if allowed and person_id not in allowed:
            return "La persona no está en el equipo autorizado para este turno"
        # Slot-level categoría restriction (migration 0048). Applies to
        # every assignment of the slot regardless of staffing mode. For
        # team_composition slots it intersects with the per-role list.
        # Period overrides may broaden or drop this restriction inside a
        # periodo (e.g. summer regime lets residents cover adjunto slots).
        slot_cats = self.effective_allowed_categories(slot.id, d)
        if slot_cats and m.category_id not in slot_cats:
            return "Su categoría no cubre este turno"
        # Team-role categories.
        if team_role_id is not None:
            cats = self.team_role_categories.get(team_role_id)
            if cats and m.category_id not in cats:
                return "Su categoría no cubre este rol"
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
    *,
    schedule_id_by_date: dict[date, int] | None = None,
) -> None:
    """Round-robin generator. Used when the CP-SAT solver can't run.

    Loses fairness/spread quality but always produces SOMETHING. Locked
    assignments are emitted first so the caller's constraint that they
    survive is honoured.

    V.1 vacation feature: when a multi-month solve is in flight the caller
    passes `schedule_id_by_date` mapping every date in `ctx.dates` to the
    Schedule id for that date's month. Legacy single-month callers omit
    it and we default to `{d: schedule.id for d in ctx.dates}` so each
    emitted Assignment still lands on the single passed-in schedule.
    """
    if schedule_id_by_date is None:
        schedule_id_by_date = {d: schedule.id for d in ctx.dates}
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
    # Sprint 28: dismissed (slot, date) pairs. Greedy must skip them
    # just like CP-SAT does — no demands, no fills. The dismissed
    # rows themselves are emitted as part of the locked-carry below.
    dismissed_slot_day_g: set[tuple[int, date]] = {
        (la.slot_id, la.date) for la in locked if la.dismissed_at is not None
    }
    for la in locked:
        db.add(
            Assignment(
                tenant_id=ctx.tenant_id,
                schedule_id=schedule_id_by_date[la.date],
                slot_id=la.slot_id,
                date=la.date,
                person_id=la.person_id,
                team_role_id=la.team_role_id,
                notes=la.notes,
                locked_at=la.locked_at,
                locked_by_membership_id=la.locked_by_membership_id,
                dismissed_at=la.dismissed_at,
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
        or None if the rule is solver/manual (caller round-robins instead).

        V.2: route through effective_rule_strategy so a period override
        that switches rotation → solver (or disables the rule) doesn't
        emit stale pins."""
        strategy, _ = ctx.effective_rule_strategy(rule, d)
        if strategy == "fixed_weekly":
            return list(ctx.fixed_weekly_persons(rule, d))
        if strategy == "rotation":
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
        (sprint 16: the latter can now have a rule pinning a team).
        V.2: same effective-strategy routing as _pin_persons."""
        rule = ctx.rule_for(slot.id, d)
        if rule is None:
            return 1
        strategy, _ = ctx.effective_rule_strategy(rule, d)
        if strategy in ("fixed_weekly", "rotation"):
            return 0
        return 1

    for d in ctx.dates:
        slots_in_priority_order = sorted(
            ctx.slots, key=lambda s: (_slot_priority(s, d), s.id)
        )
        for slot in slots_in_priority_order:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                continue
            # Sprint 28: skip dismissed (slot, date) — the dismissed
            # rows were already emitted from the locked-carry pass
            # at the top of _greedy_fallback.
            if (slot.id, d) in dismissed_slot_day_g:
                continue
            # V.1 vacation feature: same skip for slots dismissed by
            # an active periodo override on this date. No demand, no
            # assignment row — the slot simply doesn't run.
            if ctx.is_period_dismissed(slot.id, d):
                continue
            rule = ctx.rule_for(slot.id, d)
            if rule is None:
                continue
            # V.2 vacation feature: resolve the effective strategy once
            # per (rule, d) so every branch below sees a period
            # override (e.g. rotation → manual during a vacation period)
            # rather than the rule's authored value.
            strategy, _ = ctx.effective_rule_strategy(rule, d)

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
                head = (
                    1
                    if mode == "single"
                    else max(1, ctx.effective_headcount(slot, d))
                )
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
                                    schedule_id=schedule_id_by_date[d],
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
                                    schedule_id=schedule_id_by_date[d],
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
                                schedule_id=schedule_id_by_date[d],
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
                                schedule_id=schedule_id_by_date[d],
                                slot_id=slot.id,
                                date=d,
                                person_id=None,
                                team_role_id=None,
                                notes="Plaza adicional pendiente",
                            )
                        )
                    continue

                if strategy == "manual":
                    for _ in range(head):
                        db.add(
                            Assignment(
                                tenant_id=ctx.tenant_id,
                                schedule_id=schedule_id_by_date[d],
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
                                schedule_id=schedule_id_by_date[d],
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
                            schedule_id=schedule_id_by_date[d],
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
                            schedule_id=schedule_id_by_date[d],
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
                #
                # If the team is smaller than the slot's total role
                # headcount, strictly restricting would leave some
                # roles uncoverable (same person can't fill two
                # roles), so we drop the restriction and let solver
                # picks cover the excess. Matches the CP-SAT
                # graceful-degrade path.
                team_pin: list[int] | None = None
                if strategy == "rotation":
                    team_pin = list(ctx.rotation_persons_for(rule, d))
                elif strategy == "fixed_weekly":
                    team_pin = list(ctx.fixed_weekly_persons(rule, d))
                total_slot_head = sum(max(1, r.headcount) for r in roles)
                if team_pin and len(team_pin) < total_slot_head:
                    team_pin = None
                team_pin_set = set(team_pin) if team_pin else None

                # Same-slot exclusivity: a person can fill at most one
                # role of the same slot/date. Cross-slot conflicts go
                # through conflicts_in_time() — UNLESS this slot is
                # admin-pinned via a team_pin (sprint 16 policy: the
                # admin's placement wins over time-overlap with
                # other admin-pinned slots). Greedy processes
                # admin-pinned slots before solver slots, so at this
                # point any cross-slot busy entry the team member
                # has IS another admin pin; bypassing the check is
                # safe and matches what the user explicitly asked
                # for ("fixed days and rotation should just be put
                # as defined by the user").
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
                            and (
                                team_pin_set is not None
                                or not conflicts_in_time(p, slot, d)
                            )
                        ]
                        if not pool:
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule_id_by_date[d],
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
                                schedule_id=schedule_id_by_date[d],
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


def _compute_team_composition_rotation_prepins(
    ctx: "_Context",
    locked_keys_set: set[tuple[date, int, int | None]],
) -> dict[tuple[date, int, int], list[tuple[int | None, str | None]]]:
    """Sprint 28: for each team_composition slot driven by a rotation
    rule, walk ctx.dates to find maximal runs of consecutive dates
    with the SAME rotation team on that slot. Each such run is a
    "balance block". For each block we generate a deterministic
    cyclic Latin rectangle assigning (person, role-demand-slot, day)
    triples, indexed by a block-rank derived from the rule's anchor
    so the role-permutation persists across schedule regenerations.

    Returns:
        {(date, slot_id, role_id): [(person_id_or_none, note_or_none),
                                    …]}
    The list per (date, slot, role) has exactly role.headcount entries,
    one per demand-slot for that role on that day.

    Skipped (left for the existing per-date demand path to handle):
      - Blocks with any locked cell — the lock would conflict with the
        rigid Latin assignment, so we defer the whole block.
      - Teams smaller than the slot's total per-day headcount
        (n < m) — Latin rectangle requires n >= m to keep
        same-slot exclusivity feasible without duplicating a person
        across two roles on the same day. The existing greedy
        fallback at the demand level already handles this case.

    Formula:
        person_index = (day_offset + role_demand_idx + b) mod n
    where:
        n = len(team)
        b = ctx.team_block_rank_for(rule, block_dates[0])
        day_offset ∈ [0, k)  with k = len(block_dates)
        role_demand_idx ∈ [0, m) with m = sum(role.headcount for role)

    Why this works:
      - Within a block (b fixed), varying (day, role_demand_idx)
        produces a Latin rectangle: each (person, role) pair is
        covered floor(k/n)..ceil(k/n) times — same balance the
        previous CP-SAT hard constraint enforced.
      - Across blocks of the same team, b increments by 1 each
        block-of-this-team. After n blocks of the same team, every
        (person, role, day_offset) triple has been covered uniformly.
      - shift=1 works for any n ≥ 1 because gcd(1, n) = 1.
    """
    out: dict[
        tuple[date, int, int], list[tuple[int | None, str | None]]
    ] = {}
    role_ids_by_slot: dict[int, set[int]] = {
        s.id: {r.id for r in ctx.team_roles_by_slot.get(s.id, [])}
        for s in ctx.slots
        if s.staffing_mode == "team_composition"
    }
    for slot in ctx.slots:
        if slot.staffing_mode != "team_composition":
            continue
        roles = ctx.team_roles_by_slot.get(slot.id, [])
        if not roles:
            continue
        # Flat per-day demand vector: each role contributes headcount
        # entries. Same role can appear multiple times in the list
        # (e.g. Implante with headcount=2 → ["Implante", "Implante"]).
        role_demand: list[int] = []
        for role in roles:
            for _ in range(max(1, role.headcount)):
                role_demand.append(role.id)
        m = len(role_demand)
        if m == 0:
            continue
        role_id_set = role_ids_by_slot.get(slot.id, set())

        # Block accumulator state.
        cur_team: list[int] = []
        cur_dates: list[date] = []
        cur_rule_id: int | None = None

        def flush() -> None:
            nonlocal cur_team, cur_dates, cur_rule_id
            if not cur_team or not cur_dates or cur_rule_id is None:
                cur_team, cur_dates, cur_rule_id = [], [], None
                return
            n = len(cur_team)
            if n < m:
                # Team too small to cover one role each per day under
                # same-slot exclusivity — fall back to the existing
                # greedy / team-restricted solver path.
                cur_team, cur_dates, cur_rule_id = [], [], None
                return
            # Any locked cell anywhere in the block aborts pre-pinning
            # for the entire block (the lock and the Latin formula
            # would fight each other and the resulting assignments
            # could double-fill a person).
            has_lock = any(
                (dd, slot.id, rid) in locked_keys_set
                for dd in cur_dates
                for rid in role_id_set
            )
            if has_lock:
                cur_team, cur_dates, cur_rule_id = [], [], None
                return
            # Recover the rule object for anchor + week-step access.
            rule_obj: SlotRule | None = None
            for r in ctx.rules_by_slot.get(slot.id, []):
                if r.id == cur_rule_id:
                    rule_obj = r
                    break
            if rule_obj is None:
                cur_team, cur_dates, cur_rule_id = [], [], None
                return
            b = ctx.team_block_rank_for(rule_obj, cur_dates[0])
            for day_offset, d_ in enumerate(cur_dates):
                by_role: dict[
                    int, list[tuple[int | None, str | None]]
                ] = defaultdict(list)
                for role_idx in range(m):
                    role_id = role_demand[role_idx]
                    pid = cur_team[(day_offset + role_idx + b) % n]
                    reason = ctx.eligibility_reason(
                        pid, slot, d_, role_id
                    )
                    if reason:
                        by_role[role_id].append(
                            (
                                None,
                                f"Persona de la rotación no disponible: {reason}",
                            )
                        )
                    else:
                        by_role[role_id].append((pid, None))
                for role_id, entries in by_role.items():
                    out[(d_, slot.id, role_id)] = entries
            cur_team, cur_dates, cur_rule_id = [], [], None

        for d in ctx.dates:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                flush()
                continue
            rule = ctx.rule_for(slot.id, d)
            # V.2 vacation feature: a rotation rule might be flipped to
            # solver/manual (or disabled) for date d by a periodo
            # override — only same-team blocks under the rotation
            # strategy qualify for the Latin-rectangle pre-pin.
            strategy = (
                ctx.effective_rule_strategy(rule, d)[0]
                if rule is not None
                else None
            )
            if rule is None or strategy != "rotation":
                flush()
                continue
            team = list(ctx.rotation_persons_for(rule, d))
            if not team:
                flush()
                continue
            if cur_team == team and cur_rule_id == rule.id and cur_dates:
                cur_dates.append(d)
            else:
                flush()
                cur_team = team
                cur_dates = [d]
                cur_rule_id = rule.id
        flush()
    return out


def _solve_cpsat(
    db: Session,
    ctx: _Context,
    schedule: Schedule,
    locked: list[Assignment] | None = None,
    *,
    schedule_id_by_date: dict[date, int] | None = None,
) -> bool:
    """Build + solve the CP-SAT model. Persist assignments to `schedule`.

    Returns True on success, False if the solver couldn't run at all
    (caller should then invoke the greedy fallback).

    V.1 vacation feature: when a multi-month solve is in flight the caller
    passes `schedule_id_by_date` mapping every date in `ctx.dates` to the
    Schedule id for that date's month, so emitted Assignment rows route
    to the right monthly Schedule. Legacy single-month callers omit it
    and we default to `{d: schedule.id for d in ctx.dates}`; queries that
    reference `schedule.id` outside Assignment constructors continue to
    point at the single passed-in Schedule.
    """
    try:
        from ortools.sat.python import cp_model
    except ImportError:  # pragma: no cover - sanity guard
        logger.warning("ortools not available — falling back to greedy")
        return False

    locked = locked or []
    if schedule_id_by_date is None:
        schedule_id_by_date = {d: schedule.id for d in ctx.dates}

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
        # V.2 vacation feature: a periodo override may flip the rule's
        # strategy (e.g. rotation → manual) for date `d`. Resolve once
        # and use throughout this helper.
        strategy, _ = ctx.effective_rule_strategy(rule, d)
        if strategy == "manual":
            for _ in range(head):
                db.add(
                    Assignment(
                        tenant_id=ctx.tenant_id,
                        schedule_id=schedule_id_by_date[d],
                        slot_id=slot.id,
                        date=d,
                        person_id=None,
                        team_role_id=team_role_id,
                        notes="Pendiente de asignar manualmente",
                    )
                )
            return

        if strategy == "rotation":
            configured = ctx.rotation_persons_for(rule, d)
            empty_notes = "Rotación sin miembros configurados"
            ineligible_prefix = "Persona de la rotación no disponible"
        elif strategy == "fixed_weekly":
            configured = ctx.fixed_weekly_persons(rule, d)
            empty_notes = "Sin persona fijada para este día de la semana"
            ineligible_prefix = "Persona fija no disponible"
        else:
            # Unknown strategy — should never reach here. Emit NULLs.
            for _ in range(head):
                db.add(
                    Assignment(
                        tenant_id=ctx.tenant_id,
                        schedule_id=schedule_id_by_date[d],
                        slot_id=slot.id,
                        date=d,
                        person_id=None,
                        team_role_id=team_role_id,
                        notes="Estrategia desconocida",
                    )
                )
            return

        # Cap configured > head for rotation only. fixed_weekly is
        # the "admin knows who's on duty that day" strategy — they're
        # explicitly allowed to pin more people than the slot's
        # default headcount for individual weekdays (the API + UI
        # accept this since the previous día-fijo relaxation). The
        # scheduler emits one assignment per pin so all of them show
        # up in the planning grid; the headcount value just becomes
        # the lower-bound expectation, not an upper cap.
        if len(configured) > head and strategy != "fixed_weekly":
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
                    schedule_id=schedule_id_by_date[d],
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
                        schedule_id=schedule_id_by_date[d],
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
                    schedule_id=schedule_id_by_date[d],
                    slot_id=slot.id,
                    date=d,
                    person_id=None,
                    team_role_id=team_role_id,
                    notes="Plaza adicional pendiente",
                )
            )

    locked_keys_set = {(la.date, la.slot_id, la.team_role_id) for la in locked}

    # Sprint 28 / migration 0049: dismissed cells. The lock-carry
    # mechanism preserves dismissed assignments verbatim across
    # regenerations. Here we materialize them and build the
    # `dismissed_slot_day` set so the demand-generation pass below
    # knows to skip every (slot_id, date) the admin marked as
    # "No aplica" — no demands, no team-pinning, no rotation
    # pre-pins. The dismissal cascades to every role and headcount
    # slot of the activity for that day (the dismiss endpoint
    # already wrote sibling rows for each).
    dismissed_locks = [la for la in locked if la.dismissed_at is not None]
    dismissed_slot_day: set[tuple[int, date]] = {
        (la.slot_id, la.date) for la in dismissed_locks
    }
    for la in dismissed_locks:
        db.add(
            Assignment(
                tenant_id=ctx.tenant_id,
                schedule_id=schedule_id_by_date[la.date],
                slot_id=la.slot_id,
                date=la.date,
                person_id=None,
                team_role_id=la.team_role_id,
                notes=la.notes or "No aplica hoy",
                locked_at=la.locked_at,
                locked_by_membership_id=la.locked_by_membership_id,
                dismissed_at=la.dismissed_at,
            )
        )

    # Sprint 28: cross-block Latin-rectangle pre-pinning for
    # team_composition rotation slots. For each maximal run of
    # consecutive dates with the same rotation team on a
    # team_composition slot, compute a deterministic (person, role,
    # day) assignment using the cyclic Latin rectangle
    #     person_index = (day_offset + role_idx + block_rank) mod n
    # where block_rank is derived from anchor_date via
    # Context.team_block_rank_for(). This guarantees that:
    #   - Within a block, each person does each role floor(k/n) to
    #     ceil(k/n) times (the same balance the existing CP-SAT hard
    #     constraint enforced).
    #   - Across consecutive blocks for the same team, the
    #     role-permutation shifts so the same person doesn't always
    #     cover the same role on the same weekday — full
    #     (person, role, weekday) cycle every n blocks of that team.
    # The map is consumed by the demand loop below: for any
    # (date, slot_id, role_id) it covers, we emit pre-pinned
    # Assignment rows directly and skip adding a solver demand. Cells
    # where the formula picks an ineligible person become NULL with a
    # Spanish reason; cells inside a block that contains ANY locked
    # cell are excluded (the existing locked-key path handles them).
    role_prepins = _compute_team_composition_rotation_prepins(
        ctx, locked_keys_set
    )

    for d in ctx.dates:
        for slot in ctx.slots:
            if not _slot_applies(slot, d, ctx.holiday_dates):
                continue
            # Sprint 28: skip entire (slot, date) when admin marked
            # "No aplica". The dismissed rows were already emitted
            # above; no demands, no rules, no pre-pins for this cell.
            if (slot.id, d) in dismissed_slot_day:
                continue
            # V.1 vacation feature: same skip for slots dismissed by
            # an active periodo override on this date. No demand, no
            # assignment row — the slot simply doesn't run during the
            # period. (Unlike "No aplica hoy" we don't emit a NULL
            # placeholder row: the cell just isn't there. That matches
            # how the grid renders periods — non-running days show
            # "—" with no Sin-cubrir styling.)
            if ctx.is_period_dismissed(slot.id, d):
                continue
            rule = ctx.rule_for(slot.id, d)
            if rule is None:
                # Admin chose not to cover this weekday on this slot.
                continue
            # V.2 vacation feature: resolve effective strategy once per
            # (rule, d) so every branch below — both team_composition
            # and non-team_composition — respects period overrides.
            strategy, _ = ctx.effective_rule_strategy(rule, d)
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
                            schedule_id=schedule_id_by_date[d],
                            slot_id=slot.id,
                            date=d,
                            person_id=None,
                            notes="Slot sin roles definidos",
                        )
                    )
                    continue
                # Sprint 28: if the role_prepins pre-pass covered this
                # (date, slot) — i.e. the cell belongs to a same-team
                # rotation block, no lock conflicts, team big enough —
                # emit the deterministic Latin-rectangle assignments
                # directly and skip adding solver demands. This is the
                # cross-block role-rotation mechanism: see
                # _compute_team_composition_rotation_prepins().
                if any(
                    (d, slot.id, r.id) in role_prepins for r in roles
                ):
                    for role in roles:
                        entries = role_prepins.get(
                            (d, slot.id, role.id), []
                        )
                        for pid, note in entries:
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule_id_by_date[d],
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=pid,
                                    team_role_id=role.id,
                                    notes=note,
                                )
                            )
                            if pid is not None:
                                pre_busy.add((pid, d))
                                pre_pinned_assignments.append(
                                    (pid, d, slot.id)
                                )
                                if slot.post_slot_rest:
                                    pre_rest_block.add(
                                        (pid, d + timedelta(days=1))
                                    )
                        # Pad to role.headcount if the pre-pass emitted
                        # fewer entries (shouldn't happen because the
                        # formula iterates all m demand-slots, but
                        # defensive — keeps the cell count consistent
                        # with what the planning grid expects).
                        pad = max(1, role.headcount) - len(entries)
                        for _ in range(pad):
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule_id_by_date[d],
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=None,
                                    team_role_id=role.id,
                                    notes="Plaza adicional pendiente",
                                )
                            )
                    continue
                # Manual rules: admin fills cells by hand. Mirror the
                # non-team_composition path (_emit_team_prepin's manual
                # branch) — emit NULL placeholders per role, register
                # nothing with the solver. Without this branch a
                # team_composition + manual slot fell through to
                # `team = []` below, added solver demands and the
                # solver auto-filled the cells, defeating the whole
                # point of choosing manual.
                if strategy == "manual":
                    for role in roles:
                        for _ in range(max(1, role.headcount)):
                            db.add(
                                Assignment(
                                    tenant_id=ctx.tenant_id,
                                    schedule_id=schedule_id_by_date[d],
                                    slot_id=slot.id,
                                    date=d,
                                    person_id=None,
                                    team_role_id=role.id,
                                    notes="Pendiente de asignar manualmente",
                                )
                            )
                    continue
                if strategy == "rotation":
                    team = list(ctx.rotation_persons_for(rule, d))
                elif strategy == "fixed_weekly":
                    team = list(ctx.fixed_weekly_persons(rule, d))
                else:
                    team = []
                # Sprint 16 patch: when the rotation/fixed_weekly team
                # has fewer members than the slot's TOTAL role
                # headcount, strictly restricting candidates to the
                # team makes the model infeasible (same-slot
                # exclusivity says one person can fill ≤ 1 role of a
                # given slot/day; team of 1 can't cover 2 roles). The
                # whole schedule then falls back to greedy. Detect
                # the mismatch and skip the team restriction for this
                # (slot, day) so CP-SAT can still solve — the slot
                # gets filled by solver picks instead of the
                # configured team. Admin sees this as "rotation
                # respected when possible, free pick when not".
                total_slot_head = sum(max(1, r.headcount) for r in roles)
                if team and len(team) >= total_slot_head:
                    team_pinned_by_slot_day[(slot.id, d)] = team
                elif team:
                    logger.warning(
                        "team_composition rotation team smaller than "
                        "slot headcount (slot=%s date=%s team=%d, "
                        "need=%d) — disabling team restriction for "
                        "this date so CP-SAT stays feasible",
                        slot.name,
                        d.isoformat(),
                        len(team),
                        total_slot_head,
                    )
                for role in roles:
                    demands.append((d, slot.id, role.id, max(1, role.headcount)))
                    is_guardia_demand[(d, slot.id, role.id)] = bool(slot.guardia_type)
                continue

            # Non-team_composition: rule.strategy dictates behaviour.
            if strategy == "solver":
                head = (
                    1
                    if mode == "single"
                    else max(1, ctx.effective_headcount(slot, d))
                )
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
                    head = (
                    1
                    if mode == "single"
                    else max(1, ctx.effective_headcount(slot, d))
                )
                    demands.append((d, slot.id, None, head))
                    is_guardia_demand[(d, slot.id, None)] = bool(slot.guardia_type)
                    continue
                head = (
                    1
                    if mode == "single"
                    else max(1, ctx.effective_headcount(slot, d))
                )
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
                        schedule_id=schedule_id_by_date[d],
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

    # Sprint 16: per-person admin-control check used for both
    # time-overlap and succession-rule bypasses. "Admin-controlled
    # for P on (slot, day)" means either a direct pre-pin
    # (rotation/fixed_weekly on single/multiple_same) OR membership
    # in a team_pin (rotation/fixed_weekly on team_composition).
    # Per user policy: when both sides of a conflict are
    # admin-controlled, the admin's pin wins and the conflict is
    # silenced — the placement happens exactly as defined.
    prepin_by_sdp: set[tuple[int, date, int]] = set()
    for (pid_, d_, s_) in pre_pinned_assignments:
        prepin_by_sdp.add((s_, d_, pid_))

    def _person_admin_controlled(slot_id: int, d: date, p: int) -> bool:
        if (slot_id, d, p) in prepin_by_sdp:
            return True
        tp = team_pinned_by_slot_day.get((slot_id, d))
        if tp is not None and p in tp:
            return True
        return False

    for pid, items in vars_by_person.items():
        # Solver-var vs solver-var pairs.
        for (d1, s1, v1), (d2, s2, v2) in itertools.combinations(items, 2):
            if abs((d1 - d2).days) > 1:
                continue
            slot_a = ctx.slot_by_id[s1]
            slot_b = ctx.slot_by_id[s2]
            if not slots_overlap_in_time(slot_a, d1, slot_b, d2):
                continue
            # Skip when admin pinned both placements for this
            # person — admin owns the conflict, two coexisting
            # admin-pinned slots are allowed even if their wall-clock
            # windows overlap.
            if (
                _person_admin_controlled(s1, d1, pid)
                and _person_admin_controlled(s2, d2, pid)
            ):
                continue
            model.Add(v1 + v2 <= 1)
        # Solver-var vs pre-pin pairs: pre-pin is forced =1 logically,
        # so any overlapping solver var must be =0 — unless the
        # solver var ALSO represents an admin-controlled placement
        # (the person is in a team_pin for that solver-side slot),
        # in which case admin pinned both sides and we let them
        # coexist.
        for d_pin, s_pin in pre_pinned_by_person.get(pid, ()):
            slot_pin = ctx.slot_by_id.get(s_pin)
            if slot_pin is None:
                continue
            for (d_v, s_v, v) in items:
                if abs((d_v - d_pin).days) > 1:
                    continue
                slot_v = ctx.slot_by_id[s_v]
                if not slots_overlap_in_time(slot_pin, d_pin, slot_v, d_v):
                    continue
                if _person_admin_controlled(s_v, d_v, pid):
                    continue
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

    # ---- Succession rules (same_person). ----
    # For each rule R: if person P works after_slot on day D, they
    # cannot (hard) / are penalized (soft) for working forbid_slot
    # on D' for D' in (D, D+R.days_after].
    #
    # Sprint 16 policy: rules fire when AT LEAST ONE side is
    # solver-driven. When BOTH sides are admin-controlled for the
    # same person, the rule is silenced — the admin's choice wins.
    # (`prepin_by_sdp` and `_person_admin_controlled` are defined
    # earlier, alongside the time-overlap section, which uses the
    # same admin-vs-solver gating.)
    period_dates_set = set(ctx.dates)
    person_ids_all = sorted(ctx.member_by_person_id.keys())

    def _side_vars_and_pin(
        slot_id: int,
        role_filter: int | None,
        d: date,
        person_id: int,
    ) -> tuple[list, bool]:
        """Sprint 17: when a succession rule is filtered to a specific
        team_role, the side's vars/pin must be narrowed to that role.

        - No role filter: full pre-existing semantics — vars summed
          across all roles, prepin_by_sdp lookup is at the slot level.
        - Role filter set: only the matching (date, slot, role,
          person) solver var counts. Pre-pin tracking is irrelevant
          for the team_composition + sub-role case because team_pin
          is a candidate restriction, not a placement — we let the
          solver var act as the "did this person take this role"
          indicator and the pairwise constraint kicks in only when
          the solver actually picks that role.
        """
        if role_filter is None:
            return (
                list(vars_by_sdp.get((slot_id, d, person_id), [])),
                (slot_id, d, person_id) in prepin_by_sdp,
            )
        v = x.get((d, slot_id, role_filter, person_id))
        return ([v] if v is not None else [], False)

    for rule in ctx.succession_rules:
        a_slot = rule.after_slot_id
        b_slot = rule.forbid_slot_id
        a_role = rule.after_team_role_id
        b_role = rule.forbid_team_role_id
        # days_after=0 = same-day incompatibility (UI labels this as a
        # distinct rule type). days_after>=1 = next-N-days succession.
        for D in ctx.dates:
            # V.2 vacation feature: resolve the effective succession
            # config based on the TRIGGERING date D (the "after" date —
            # where the original assignment that activates this rule
            # lives). When a periodo overrides this rule for D's
            # period, days_after / severity may differ from the rule's
            # authored defaults; when disabled, skip emission entirely.
            days_after, severity, disabled = ctx.effective_succession_rule(
                rule, D
            )
            if disabled:
                continue
            offsets = [0] if days_after == 0 else range(1, days_after + 1)
            for offset in offsets:
                Dp = D + timedelta(days=offset)
                if Dp not in period_dates_set:
                    continue
                for P in person_ids_all:
                    a_vars, a_pinned = _side_vars_and_pin(a_slot, a_role, D, P)
                    b_vars, b_pinned = _side_vars_and_pin(b_slot, b_role, Dp, P)

                    # If BOTH sides are admin-controlled for P (direct
                    # pre-pin or team_pin membership), skip — admin
                    # owns both placements, rule is silenced.
                    if (
                        _person_admin_controlled(a_slot, D, P)
                        and _person_admin_controlled(b_slot, Dp, P)
                    ):
                        continue
                    # If pinned on the "after" side, the "before -> after"
                    # implication collapses to "forbid b". And vice versa.
                    if severity == "hard":
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
        # Sprint 17: per-role frequency caps. When cap.team_role_id is
        # set, only vars / prior counts for that specific role of the
        # slot count toward the cap — "max 4 Cirujano-1 per week per
        # person", not "max 4 Quirófano per week per person".
        role_filter = cap.team_role_id
        for anchor, days in windows:
            # V.2 vacation feature: resolve the effective cap config
            # using the FIRST date in the window. Simplification: if a
            # window straddles a period boundary we still pick the
            # period (or lack thereof) of `days[0]` and apply that
            # config to the whole window. Windows are at most 28 days
            # so the edge case is narrow — a cleaner per-day evaluation
            # would require rebuilding the constraint shape, which we
            # avoid until V.2 ships and customers ask for it.
            window_first = days[0] if days else anchor
            max_count, severity, disabled = ctx.effective_frequency_cap(
                cap, window_first
            )
            if disabled:
                continue
            for P in person_ids_all:
                window_vars: list = []
                for d_ in days:
                    if d_ not in period_dates_set:
                        continue
                    if role_filter is None:
                        window_vars.extend(
                            vars_by_sdp.get((cap.slot_id, d_, P), [])
                        )
                    else:
                        v = x.get((d_, cap.slot_id, role_filter, P))
                        if v is not None:
                            window_vars.append(v)
                # Pre-pinned in-period assignments to that slot count
                # — but only when the cap is slot-wide. Role-filtered
                # caps on team_composition slots never get a pre-pin
                # from team_pin (team_pin is a candidate restriction,
                # not a placement), so role-level base is always 0
                # for the in-period contribution; the solver vars
                # carry the full signal.
                prior_in_period = 0
                if role_filter is None:
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
                        prior_outside += ctx.prior_published_count(
                            P, cap.slot_id, role_filter, d_
                        )
                base = prior_in_period + prior_outside
                if not window_vars and base == 0:
                    continue  # nothing to constrain
                if severity == "hard":
                    if window_vars:
                        model.Add(sum(window_vars) + base <= max_count)
                    elif base > max_count:
                        # Pre-pinned config already exceeds the cap; nothing
                        # the solver can do. Log & skip.
                        logger.warning(
                            "Frequency cap exceeded by pre-pinned/prior data: "
                            "person=%s slot=%s anchor=%s base=%d cap=%d",
                            P,
                            cap.slot_id,
                            anchor,
                            base,
                            max_count,
                        )
                else:
                    # Soft: excess = max(0, sum + base - max_count).
                    if not window_vars:
                        continue
                    bound = len(window_vars) + base
                    excess = model.NewIntVar(
                        0, max(1, bound), f"freq_excess_c{cap.id}_a{anchor}_p{P}"
                    )
                    model.Add(excess >= sum(window_vars) + base - max_count)
                    soft_obj_terms.append(cap.weight * excess)

    # ---- Objective: fairness (counts_for_equity, FTE-weighted). ----
    # We minimize max - min of weighted counts. Weights are int100/fte_pct
    # to make the LP integer.
    #
    # Each slot is its own fairness bucket. Migration 0033 dropped the
    # `equity_group_key` pooling — admins almost always wanted per-slot
    # fairness, and the pooled mode produced surprises ("person X does
    # 100% of localizadas, person Y does 100% of presenciales, totals
    # look balanced"). Within a team-composition slot the per-role
    # balance term below (W_ROLE_BALANCE) covers role-level fairness.
    # Weekend balance stays a single global term (weighed less; it's a
    # cross-slot sanity check rather than a primary fairness dimension).
    person_ids_present = sorted({pid for (_, _, _, pid) in x.keys()})
    per_slot_buckets: dict[int, dict[int, list]] = defaultdict(
        lambda: {pid: [] for pid in person_ids_present}
    )
    weekend_total: dict[int, list] = {pid: [] for pid in person_ids_present}

    for (d, slot_id, role_id, pid), var in x.items():
        slot = ctx.slot_by_id[slot_id]
        if slot.counts_for_equity:
            per_slot_buckets[slot_id][pid].append(var)
            if is_weekend_or_holiday[d]:
                weekend_total[pid].append(var)

    obj_terms: list = []

    def _balance_term(buckets: dict[int, list], weight: int, label: str) -> None:
        """Build (max - min) of weighted-by-FTE sums across buckets and add
        weight*(max-min) to obj_terms. `label` disambiguates IntVar
        names when the helper is called more than once (one call per
        slot for the per-slot fairness term, plus the global weekend
        balance and per-role inside team-composition slots)."""
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

    # One balance term per slot — every activity self-balances.
    for slot_id, buckets in per_slot_buckets.items():
        _balance_term(buckets, W_FAIRNESS, f"eq_s{slot_id}")

    _balance_term(weekend_total, W_WEEKEND, "weekend")

    # Sprint 16: per-(slot, role) equity for team_composition slots.
    # The slot-level equity above balances each person's TOTAL count
    # for a slot, but the distribution across the slot's roles was
    # free — so a person could disproportionately become "the
    # Explante one" while their Trasplante total still matched
    # everyone else's. This adds a soft term per (slot, role)
    # bucket so role assignments also tend to spread evenly across
    # the team. Lower weight than W_FAIRNESS so it never wins over
    # slot-total balance, but enough to break ties.
    role_equity: dict[tuple[int, int], dict[int, list]] = defaultdict(
        lambda: {pid: [] for pid in person_ids_present}
    )
    for (d, slot_id, role_id, pid), var in x.items():
        if role_id is None:
            continue
        slot = ctx.slot_by_id[slot_id]
        if slot.staffing_mode != "team_composition":
            continue
        if not slot.counts_for_equity:
            continue
        role_equity[(slot_id, role_id)][pid].append(var)
    for (slot_id, role_id), buckets in role_equity.items():
        _balance_term(
            buckets, W_ROLE_BALANCE, f"role_s{slot_id}_r{role_id}"
        )

    # (Migration 0030 removed the soft-skill objective term. With Skills
    # gone there's no soft-skill concept; eligibility is the slot's
    # allow-list, which is hard-only by design.)

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
                    schedule_id=schedule_id_by_date[la.date],
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
                    schedule_id=schedule_id_by_date[d],
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
                    schedule_id=schedule_id_by_date[d],
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


def generate_period(
    db: Session,
    *,
    tenant_id: int,
    period_id: int,
    membership_id: int | None,
) -> list[Schedule]:
    """Generate draft Schedules for every full month touching a
    PeriodoEspecial's date range, in a single CP-SAT solve.

    Example: a periodo spanning Jul 15 – Aug 31 creates / regenerates
    Schedule rows for Jul 2026 AND Aug 2026 from one solve over Jul 1
    – Aug 31. Period-aware slot overrides are consulted per date by
    `_Context.is_period_dismissed` / `effective_*` helpers; this
    function's job is the orchestration:

      1. Resolve the touched months from the periodo's date range.
      2. For each touched month: capture any existing draft's locks,
         delete the draft, create a fresh draft Schedule. Published
         or archived schedules abort with ValueError — caller must
         archive/delete them first.
      3. Build the concatenated date list (every day of every touched
         month) and a `schedule_id_by_date` map routing each date to
         its month's Schedule id.
      4. One _solve_cpsat call with all the dates + concatenated
         locks; assignments are sliced back to the right Schedule via
         the schedule_id_by_date map.
      5. On INFEASIBLE: wipe assignments from ALL the new Schedules
         (same flush pattern as generate_draft) and re-run greedy.

    Returns the list of Schedule rows in chronological order.

    V.1 scope note: equity buckets stay single (per-slot, across the
    whole solve). The dual-bucket "period vs non-period" split is V.3
    and intentionally out of scope here — this function just produces
    a coherent multi-month result.
    """
    periodo = (
        db.query(PeriodoEspecial)
        .filter(
            PeriodoEspecial.tenant_id == tenant_id,
            PeriodoEspecial.id == period_id,
        )
        .one_or_none()
    )
    if periodo is None:
        raise ValueError(f"PeriodoEspecial id={period_id} not found")

    # Touched months: every (year, month) covered by [start_date, end_date]
    # inclusive. e.g. Jul 15 – Aug 31 → [(2026, 7), (2026, 8)].
    months: list[tuple[int, int]] = []
    y, m = periodo.start_date.year, periodo.start_date.month
    end_y, end_m = periodo.end_date.year, periodo.end_date.month
    while (y, m) <= (end_y, end_m):
        months.append((y, m))
        if m == 12:
            y, m = y + 1, 1
        else:
            m += 1

    # Per-month: handle the existing Schedule (if any), then create a
    # fresh draft. Published/archived → caller must archive/delete first;
    # we don't silently clobber a publication.
    schedules_by_month: dict[tuple[int, int], Schedule] = {}
    locks_by_month: dict[tuple[int, int], list[Assignment]] = {}
    for (yy, mm) in months:
        month_first = date(yy, mm, 1)
        existing = (
            db.query(Schedule)
            .filter(
                Schedule.tenant_id == tenant_id,
                Schedule.period == month_first,
            )
            .one_or_none()
        )
        carried_locks: list[Assignment] = []
        if existing is not None:
            if existing.status != "draft":
                raise ValueError(
                    f"Schedule for {month_first.isoformat()} is "
                    f"{existing.status}; archive or delete it before "
                    f"regenerating the period"
                )
            # Capture locked (or dismissed) rows verbatim before we
            # delete the draft — they survive regeneration just like in
            # generate_draft's lock-carry path. Copy each row's fields
            # into a fresh transient Assignment (no db.add) so the
            # cascade-delete on the old Schedule doesn't take the
            # carried_locks list down with it.
            existing_locks = (
                db.query(Assignment)
                .filter(
                    Assignment.schedule_id == existing.id,
                    (
                        (Assignment.locked_at.isnot(None))
                        | (Assignment.dismissed_at.isnot(None))
                    ),
                )
                .all()
            )
            for la in existing_locks:
                carried_locks.append(
                    Assignment(
                        tenant_id=la.tenant_id,
                        slot_id=la.slot_id,
                        date=la.date,
                        person_id=la.person_id,
                        team_role_id=la.team_role_id,
                        notes=la.notes,
                        locked_at=la.locked_at,
                        locked_by_membership_id=la.locked_by_membership_id,
                        dismissed_at=la.dismissed_at,
                    )
                )
            # Expunge the original loaded rows so the cascade-delete
            # doesn't trigger SQLAlchemy "deleted instance still in
            # session" warnings. The transient copies above are
            # independent objects and stay intact.
            for la in existing_locks:
                db.expunge(la)
            db.delete(existing)
            db.flush()
        locks_by_month[(yy, mm)] = carried_locks

        new_sched = Schedule(
            tenant_id=tenant_id,
            period=month_first,
            status="draft",
            generated_at=datetime.now(timezone.utc),
            generated_by_membership_id=membership_id,
        )
        db.add(new_sched)
        db.flush()
        schedules_by_month[(yy, mm)] = new_sched

    # Concatenated date list (full calendar months in chronological
    # order) and the schedule_id_by_date map that routes each date to
    # its month's Schedule. The first month doubles as the _Context
    # "anchor" period for legacy fields (e.g. prior-published lookback
    # anchors on period_start = days[0]).
    all_dates: list[date] = []
    schedule_id_by_date: dict[date, int] = {}
    for (yy, mm) in months:
        month_days = _dates_in_month(date(yy, mm, 1))
        sched_id = schedules_by_month[(yy, mm)].id
        for d in month_days:
            all_dates.append(d)
            schedule_id_by_date[d] = sched_id

    # Anchor month + primary schedule: used for the _Context "period"
    # parameter and the `schedule` argument passed to _solve_cpsat /
    # _greedy_fallback. Anything that still reads `schedule.id`
    # outside an Assignment constructor (queries, schedule.solver_used
    # assignments below) operates against this primary Schedule.
    first_month = months[0]
    primary_schedule = schedules_by_month[first_month]
    ctx = _Context(
        db,
        tenant_id,
        date(first_month[0], first_month[1], 1),
        dates=all_dates,
    )

    # Concatenate every month's carried locks into one list. The
    # locked-carry logic inside _solve_cpsat / _greedy_fallback already
    # uses la.date to route each row through schedule_id_by_date, so
    # locks from August naturally land on August's new Schedule.
    all_locks: list[Assignment] = []
    for m_key in months:
        all_locks.extend(locks_by_month[m_key])

    ok = _solve_cpsat(
        db,
        ctx,
        primary_schedule,
        locked=all_locks,
        schedule_id_by_date=schedule_id_by_date,
    )
    if ok:
        for sched in schedules_by_month.values():
            sched.solver_used = "cpsat"
    else:
        # Same wipe + greedy pattern as generate_draft, but the wipe
        # must clear assignments from EVERY Schedule we just created
        # — CP-SAT writes pre-pins across all months before solving.
        db.flush()
        new_schedule_ids = [s.id for s in schedules_by_month.values()]
        db.query(Assignment).filter(
            Assignment.schedule_id.in_(new_schedule_ids)
        ).delete(synchronize_session=False)
        db.flush()
        _greedy_fallback(
            db,
            ctx,
            primary_schedule,
            locked=all_locks,
            schedule_id_by_date=schedule_id_by_date,
        )
        for sched in schedules_by_month.values():
            sched.solver_used = "greedy"

    db.flush()
    return [schedules_by_month[m_key] for m_key in months]


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
    # Clear the reopen audit fields on (re)publish so the
    # "Reabierta" badge in the UI doesn't linger. The route grabs
    # the reopened_at value into `is_republish` BEFORE calling this
    # helper so the audit signal is preserved for the
    # re-publish-notification copy.
    schedule.reopened_at = None
    schedule.reopened_by_membership_id = None
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


def reopen(
    db: Session, schedule: Schedule, *, membership_id: int | None
) -> None:
    """Flip published → draft so an admin can edit cells. Records
    `reopened_at` + `reopened_by_membership_id` so the audit trail
    (and the UI badge) can show when and by whom the publication was
    brought back. Idempotent: a non-published schedule is a no-op.

    Side-effects intentionally NOT done here:
    - Cancelling open swap offers + emailing affected members. The
      caller (the route) handles that because it needs the SMTP
      stack and the assignment list, which the scheduler service
      shouldn't depend on. Keeping this function as a pure status
      flip makes it trivially testable."""
    if schedule.status != "published":
        return
    schedule.status = "draft"
    schedule.reopened_at = datetime.now(timezone.utc)
    schedule.reopened_by_membership_id = membership_id
    db.flush()

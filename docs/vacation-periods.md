# Vacation periods — design

Status: design, not yet implemented.
Target: ~2 weeks of focused work (less if we drop dual equity buckets).

## Problem

The current scheduler is calibrated for "normal weeks" — a full team, all
categorías represented, every slot at its standard headcount and
strategy. Rules (succession, frequency caps, categoría restrictions, slot
allow-lists) are loaded once per solve and apply unconditionally to
every date in the month.

That model breaks during periods when the workforce is thinner —
typically summer (people on vacation) and to a lesser extent Christmas
and Semana Santa. Two simultaneous shifts happen:

- **Supply shrinks**: clinicians take 1–3 week vacations, staggered.
  Approved bloqueos already keep them out of individual cells, but the
  solver doesn't compensate equity-wise across the period.
- **Demand shrinks**: hospital activity drops. Quirófano may run with
  half the usual cirujanos or skip days entirely; Consulta may not run
  at all in August; Guardia coverage continues but with fewer eligible
  bodies.

The alpha customer (Cirugía Torácica — Hospital La Fe) currently has
no formal way to encode this. The legacy tool offered nothing, and
the team falls back to ad-hoc spreadsheet edits. The result is rotas
that look fine within a single month but are deeply unfair when you
zoom out over July + August:

- Person A: home all summer → 2 guardias in July + 2 in August = **4 total**
- Person B: on vacation most of July, back in August → 0 + 2 = **2 total**

The solver in July tries to balance July's guardias across whoever's
available in July; the August solver does the same for August. Neither
sees the period as a whole. A ends up doing twice B's load even though
both worked some of the time.

The user's mental summary of what they want:

> we select the vacation period, then we refine all actividades and
> reglas for that period. then the scheduler populates all full months
> that intersect with the period, doing fixed and rotation first, then
> balancing the rest over the entire period.

## Goals

- A single tenant-scoped `periodo_especial` concept (one row = one
  defined date range with a name, e.g. "Verano 2026").
- Top-down editing UX: pick the period first, then edit how
  actividades and reglas look during it. Overrides are deltas from
  default — Mara only writes what changes.
- Multi-month solving: generate the period as one CP-SAT problem
  spanning every full month it touches. Fixed and rotation pins go in
  first across the whole span; solver fills the rest.
- Period-scoped equity: variance of person-counts is minimized over the
  *period dates* (not per month). Non-period dates in the same solve
  form a separate equity bucket so they don't blur the math.
- Graceful rotation degradation inside the period: when a rotation
  member is on vacation, walk forward through the rotation order to
  the next available person. If every rotation member is blocked, the
  cell becomes Sin cubrir (admin fixes manually).
- Plays cleanly with everything that already exists: bloqueos, "No
  aplica hoy", locks, manual overrides, the violations engine.

## Non-goals (out of scope for v1)

- Multiple overlapping periods. Tenant has many periodos over time,
  but no two cover the same date (enforced by exclusion constraint).
  We may revisit if Mara wants e.g. a "personal vacation window" layer
  on top of "summer regime."
- Auto-generated periodos based on bloqueo density. Mara defines the
  range manually.
- Year-over-year copy. A "Verano 2026" doesn't auto-clone into
  "Verano 2027" — though that's a tiny follow-up if requested.
- Per-person rules during a period. People-side variation is already
  expressed through bloqueos.
- Equity across multiple periods (e.g. "balance Christmas + Verano
  together"). Each periodo is its own equity scope.
- Touching the violations engine. Post-hoc checks continue to use the
  default rule set; surfacing "the rule was relaxed for this period"
  is a UX nicety we can add later.

## Mental model

The unit of configuration is a **periodo**. A periodo carries:

1. A date range (`start_date`, `end_date`, non-overlapping per tenant).
2. **Slot overrides**: for each slot Mara wants to change during the
   period — alternate headcount, alternate staffing_mode, dismissed
   (slot doesn't run), broader allowed_category_ids, broader
   allowed_person_ids.
3. **Rule overrides**: for each SlotRule Mara wants to change — switch
   `strategy` (e.g. rotation → solver), or disable the rule entirely.
4. **Succession overrides**: for each SlotSuccessionRule — alter
   `days_after`, change `severity` (hard → soft), or disable.
5. **Frequency cap overrides**: for each SlotFrequencyCap — alter
   `max_count`, change `severity`, or disable.

If a slot or rule isn't overridden, it inherits the default behavior
during the period. This keeps the UI focused: Mara sees a clean
"what's different" view, not a full duplicate config.

When the admin clicks **Generar período**, the backend identifies
every full month touching the date range, builds one CP-SAT model
covering all those dates, slots in deterministic pins (fixed_weekly +
rotation) across the entire span first, then solves the remaining
variables. Equity terms get bucketed: period dates form one bucket,
non-period dates in the same solve form another.

Result: one Schedule row per month (same as today). Admin reviews and
publishes each month independently.

## Schema

One new migration. All tables tenant-scoped via existing RLS pattern.

```sql
-- The periodo itself.
CREATE TABLE periodos_especiales (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  -- Non-overlapping per tenant. Postgres exclusion constraint with btree_gist.
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
);

-- Per-slot overrides during the period. Each field nullable;
-- non-null replaces the slot's default for dates inside the period.
CREATE TABLE slot_period_overrides (
  id                              SERIAL PRIMARY KEY,
  tenant_id                       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id                       INT NOT NULL REFERENCES periodos_especiales(id) ON DELETE CASCADE,
  slot_id                         INT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  headcount_override              INT NULL,
  staffing_mode_override          VARCHAR(32) NULL,    -- 'single' | 'multiple_same' | 'team_composition'
  dismissed                       BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_category_ids_override   INT[] NULL,
  allowed_person_ids_override     INT[] NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_id, slot_id)
);

-- Per-rule (SlotRule) overrides. Lets Mara say "this rotation rule
-- becomes a solver rule during summer" without touching the default.
CREATE TABLE slot_rule_period_overrides (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id           INT NOT NULL REFERENCES periodos_especiales(id) ON DELETE CASCADE,
  rule_id             INT NOT NULL REFERENCES slot_rules(id) ON DELETE CASCADE,
  strategy_override   VARCHAR(16) NULL,   -- 'solver' | 'fixed_weekly' | 'rotation' | 'manual'
  disabled            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_id, rule_id)
);

CREATE TABLE slot_succession_rule_period_overrides (
  id                    SERIAL PRIMARY KEY,
  tenant_id             INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id             INT NOT NULL REFERENCES periodos_especiales(id) ON DELETE CASCADE,
  succession_rule_id    INT NOT NULL REFERENCES slot_succession_rules(id) ON DELETE CASCADE,
  days_after_override   INT NULL,
  severity_override     VARCHAR(8) NULL,  -- 'hard' | 'soft'
  disabled              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_id, succession_rule_id)
);

CREATE TABLE slot_frequency_cap_period_overrides (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id          INT NOT NULL REFERENCES periodos_especiales(id) ON DELETE CASCADE,
  cap_id             INT NOT NULL REFERENCES slot_frequency_caps(id) ON DELETE CASCADE,
  max_count_override INT NULL,
  severity_override  VARCHAR(8) NULL,
  disabled           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_id, cap_id)
);
```

All five tables follow the standard RLS pattern (`tenant_id` column +
FORCE ROW LEVEL SECURITY + policy using `app.tenant_id` GUC).

## Solver changes

Three meaningful changes in `api/app/services/scheduler.py`. All other
parts of the solver (eligibility, locks, time-overlap, post_slot_rest,
Latin-square role balance, guardia 4-day spread) carry through
unchanged.

### 1. Date-aware rule loading

Today, rules/successions/caps/categorías/allow-lists are loaded once
at the start of `_Context.__init__` (line 158). They apply
unconditionally to every date in the solve.

Refactor: each rule type gets resolved per date through a helper:

```python
def effective_rule_at(self, rule_id: int, d: date) -> SlotRule | None:
    """Return the rule as it applies on date d, accounting for any
    period override active that day. Returns None if the rule is
    disabled by an override."""
```

Same helper pattern for succession, frequency cap, categoría, and
allow-list. The override tables get indexed for fast (rule_id,
period_id) lookup; periods are loaded once per solve and the date →
period mapping built upfront.

Touches:
- `_Context.__init__` (rule loading, line 158)
- Succession constraint emit (line 2006)
- Frequency cap constraint emit (line 2069)
- Categoría check in `eligibility_reason` (line 511)
- Allow-list check in `eligibility_reason` (line 504)

### 2. Multi-month solve

New entry point in `services/scheduler.py`:

```python
def generate_period(db: Session, tenant: Tenant, period_id: int) -> list[Schedule]:
    """Solve every full month touching the period's date range as one
    CP-SAT problem. Returns the Schedule rows (one per touched month).
    Carries locks from any existing drafts in those months.
    """
```

The existing `generate_draft(db, tenant, period: date)` stays for
non-period months.

Logic:
1. Load the periodo and compute touched months: e.g. period Jul 15 –
   Aug 31 → `{Jul 2026, Aug 2026}`.
2. For each touched month, find/create a Schedule row (draft). Carry
   locked Assignment rows from any existing drafts.
3. Compute the union of dates across all touched months (full
   calendar months — Jul 1 through Aug 31 in the example).
4. Build a single CP-SAT model. Variable space is the cross product
   of (date, slot, role, eligible_person). Constraints are the
   existing set, with rule loading consulting period overrides per
   date.
5. Pre-compute deterministic pins (fixed_weekly + rotation) across the
   whole span. Inside the period, rotation uses the skip-to-next
   behavior described below.
6. Solve. CP-SAT with the same time budget as today (scaled by the
   variable count growth — 2× dates ≈ 4×–10× harder problem in the
   worst case; in practice the team size limits it).
7. Greedy fallback if CP-SAT is INFEASIBLE.
8. Slice the solved assignments back into the per-month Schedule rows.

### 3. Dual equity buckets

Today `_balance_term` (line 2209) takes one `buckets: dict[int,
list]` mapping person_id → variables and minimizes max-min.

Change: when the solve spans a period, call `_balance_term` *twice
per slot*:
- **Period bucket**: vars filtered to dates ∈ period
- **Non-period bucket**: vars filtered to dates ∈ solve range but ∉ period

Same treatment for the weekend balance objective (line 2295) — split
into period-weekends and non-period-weekends, each minimized
independently.

Frequency cap prior-published-counts lookback (line 254) needs to
grow from a fixed 28 days to "the period length" when solving a
period. Cheap change.

### Rotation in vacation mode

When the solve is for a periodo and the current date is inside the
period, `rotation_persons_for(rule, d)` (line 323) gains a "skip
forward" behavior:

1. Compute the target position N via the existing rotation math.
2. For each member of position N (sorted by id): check eligibility
   (membership active, not bloqueo'd, slot allow-list, categoría).
   If eligible, that's the answer.
3. If position N has no eligible members, advance to position N+1 (mod
   total position count), repeat the eligibility check.
4. If we walk through every position and find no one, return `[]` →
   the cell becomes Sin cubrir. Admin handles manually.

Per Mara's input (the rotation pool IS typically the eligible pool),
we don't fall through to "any eligible person." If the rotation
members are all out, there's nobody to fall through to anyway.

Outside the period, rotation behaves exactly as today (blocked
member → NULL cell with reason).

## UX

### `/admin/periodos` — periodo list

- Table: name, date range, created_at.
- Each row links to the period editor.
- "Nuevo periodo" button → form with name + date range. Server
  enforces non-overlap via exclusion constraint.
- Delete button with confirm.

### `/admin/periodos/[id]` — periodo editor

Tabs across the top:

- **Actividades** — list of slots. Each row shows the default config
  (headcount, staffing_mode) with inline "Modificar para este
  periodo" toggle. Modified rows get a green "modificado" pill.
  Inputs for headcount override, staffing_mode override, dismissed
  checkbox, categoría override (multi-select), allow-list override
  (multi-select).
- **Reglas** — list of SlotRules (one per slot × per-position). Same
  pattern: show default strategy, allow strategy override or full
  disable.
- **Sucesión** — list of succession rules. Allow days_after override,
  severity override, full disable.
- **Caps** — list of frequency caps. Allow max_count override,
  severity override, full disable.

Top of every tab: a sticky "Generar período" button. Clicking opens a
preview: "Esto generará 2 planificaciones: Julio 2026, Agosto 2026.
Si ya existen borradores, se sobrescribirán (las celdas bloqueadas se
conservan)." Confirm → POST to generate, redirect to a status page
that shows each month's generation result with links.

### Planning grid (`/admin/schedule/[id]`)

When the month overlaps an active periodo, add a slim banner above
the grid: "Verano 2026 activa del 15 de julio al 31 de agosto.
[Editar reglas del periodo →]" linking to the periodo editor. The
banner makes the regime visible so Mara isn't surprised by different
behavior on different days.

Column headers for dates inside the periodo get a subtle visual
treatment (background tint, similar to weekend columns) so the
period boundary is obvious in the grid.

### Routes

```
GET    /api/periodos                          list periodos
POST   /api/periodos                          create
GET    /api/periodos/{id}                     fetch + all overrides
PATCH  /api/periodos/{id}                     edit name/dates
DELETE /api/periodos/{id}                     delete (cascades to overrides)

GET    /api/periodos/{id}/slot-overrides      list
PUT    /api/periodos/{id}/slot-overrides/{slot_id}     upsert override
DELETE /api/periodos/{id}/slot-overrides/{slot_id}     remove override (revert to default)

# Same shape for slot-rule-overrides, succession-overrides, cap-overrides.

POST   /api/periodos/{id}/generate            multi-month solve, returns Schedule list
```

Existing `/api/schedules/generate` is unchanged. It's the entry point
for ordinary single-month generation; it just doesn't know about
periodos. Future cleanup could route through `generate_period` when
the month overlaps a periodo, but that's a v2 niceness.

## Phasing

If we want to ship something usable before doing all of it:

**Phase V.1 — Foundation (~1 week)**
- Migration + models + Pydantic schemas for periodos and slot_period_overrides
- `effective_rule_at` plumbing for slot config (headcount, staffing_mode, dismissed)
- Multi-month solve (`generate_period`) without dual equity buckets
- `/admin/periodos` + `/admin/periodos/[id]/actividades` tab
- Generate button + per-month review

What you get: Mara can define a periodo, mark slots as dismissed or
halve headcount, generate Jul + Aug as one solve. Solver respects the
period config but equity is still per-month (the "one person gets
crushed" case isn't fully fixed yet).

**Phase V.2 — Rule overrides (~3 days)**
- Override tables for slot_rule, succession_rule, frequency_cap
- `effective_rule_at` extended to consult them
- `/admin/periodos/[id]/reglas`, `/sucesion`, `/caps` tabs

What you get: Mara can switch rotation to solver mode for some slots
during summer, relax succession (guardia → quirófano next day allowed),
loosen caps. Compatibility-rule failure mode goes away.

**Phase V.3 — Dual equity buckets + rotation skip (~3 days)**
- Period vs non-period bucket split in `_balance_term`
- Weekend balance objective same treatment
- Prior-counts lookback grown to period length
- Rotation skip-to-next in `rotation_persons_for`

What you get: the "one person gets crushed" case is fully fixed.
Rotations gracefully degrade when members are out.

## Open questions / future work

- **Period preview before generate.** Before committing the solve,
  show a dry-run summary: "expected per-person load over the
  period, X cells will be Sin cubrir." Useful but not essential v1.
- **Stats per period.** /admin/stats currently filters by month;
  could add a "by period" view. Skip for v1.
- **Year-over-year copy.** "Crear nuevo periodo basado en Verano
  2026" — clone with new dates, all overrides preserved. Tiny
  follow-up if requested.
- **Violations engine awareness.** When a date is inside a periodo
  and a rule has an override, the violations engine should consult
  the override (today it uses the default rule). Otherwise the
  /admin/schedule planning grid will show false "violation" pills on
  intentionally-relaxed cells. We can either accept this in v1 (with
  a UX note: "violaciones se calculan con las reglas por defecto")
  or extend violations.py to be date-aware too. Probably v2.
- **Auto-detect period boundaries.** If many bloqueos cluster in a
  date range, suggest creating a periodo. Nice-to-have.
- **Multiple regimes / per-person regimes.** Out of scope for v1
  (see Non-goals).

## Risks

- **CP-SAT solve time.** Doubling the date count grows the problem
  superlinearly. For typical surgical service team sizes (10–15
  people, 6–8 slots) it should still complete in seconds, but worth
  measuring early. Mitigation: per-phase time budget, fall back to
  greedy if CP-SAT times out instead of just failing.
- **Schema migration on prod.** The new tables are additive; no
  existing data touched. Low risk. Standard backup before deploy.
- **Override UI complexity creep.** Easy to over-engineer the period
  editor. Stick to the minimal forms in Phase V.1; resist adding
  bulk-edit helpers until Mara hits a real wall.

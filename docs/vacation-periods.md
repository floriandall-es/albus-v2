# Vacation periods — design

Status: V.1 + V.2 shipped (delta-based), being replaced by a snapshot
model after live feedback. This doc reflects the snapshot model.

## Problem

The current scheduler is calibrated for "normal weeks" — a full team, all
categorías represented, every slot at its standard headcount, strategy,
and rules. Rules (succession, frequency caps, categoría restrictions,
slot allow-lists) are loaded once per solve and apply unconditionally to
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

## History — what we built and why we're changing it

**V.1 + V.2 shipped** with a **delta override model**: per-period
override rows that diff against the slot/rule defaults. Five tables:

- `slot_period_overrides` (headcount, dismissed, staffing_mode,
  allowed_categories, allowed_persons)
- `slot_rule_period_overrides` (strategy, disabled)
- `slot_succession_rule_period_overrides`
- `slot_frequency_cap_period_overrides`
- `periodos_especiales` itself

Mara reviewed the V.2 editor UI and called out two problems:

1. **The UI doesn't match the rest of the app.** Editing an actividad
   normally happens via the `/admin/slots` SlotDialog with the full
   form (nombre, horario, días aplicados, plazas, color, RuleCards
   with strategy + day picker + rotation/fixed_weekly editors). The
   delta-based period UI invented a different visual language —
   checkboxes for "Modificar para el periodo," compressed forms,
   tiny "Modificar" buttons. Inconsistent.
2. **The delta model is too narrow.** Mara needs to be able to add
   new rules during a period (a new summer-only weekday coverage,
   for example) and remove existing ones — not just disable them.
   She also needs to change rotation members per period. The delta
   model only exposes a small subset.

**Decision:** swap the delta model for a **snapshot model**. The
period stores a full duplicate of the slot+rules config that's
freely editable. Mara opens the same SlotDialog she already knows.

Succession rules and frequency caps stay on the delta model — they're
tenant-scoped (cross-slot), not per-slot, so the snapshot framing
doesn't apply. The "Reglas" tab (sucesión + límites) keeps the V.2
shape.

## Goals

- A single tenant-scoped `periodo_especial` concept (one row = one
  defined date range with a name, e.g. "Verano 2026"). Unchanged from
  V.1.
- **Snapshot-based slot editing**: when the admin opens the per-period
  modal for a slot, they see the exact same SlotDialog as `/admin/slots`
  — pre-filled with either the existing snapshot (if any) or the
  slot's current default. They can edit anything: name, plazas,
  staffing_mode, allowed categorías/persons, add/remove rules, change
  rotation members per period. On save, the full config is stored as
  a snapshot.
- **Delta-based reglas editing**: succession + frequency cap overrides
  keep the per-rule "disable / change value" pattern from V.2.
- Multi-month solving: generate the period as one CP-SAT problem
  spanning every full month it touches. Unchanged from V.1.
- Period-scoped equity (dual buckets): variance balanced per period
  not per month. (Phase V.3.)
- Graceful rotation degradation inside the period: skip-to-next-in-
  position when a member is bloqueo'd. (Phase V.3.)
- Plays cleanly with everything else: bloqueos, "No aplica hoy," locks,
  violations engine.

## Non-goals (out of scope)

- Multiple overlapping periods. Tenant has many periodos over time,
  but no two cover the same date (enforced by exclusion constraint).
- Auto-generated periodos based on bloqueo density.
- Year-over-year copy. A "Verano 2026" doesn't auto-clone into
  "Verano 2027" — tiny follow-up if requested.
- Per-person rules during a period. People-side variation lives in
  bloqueos.
- Equity across multiple periods.
- Violations engine awareness of overrides. (Falls under same caveat
  as V.1.)

## Mental model

The unit of configuration is a **periodo**. A periodo carries:

1. A date range (`start_date`, `end_date`, non-overlapping per tenant).
2. **Slot snapshots**: for each slot Mara wants to look different
   during the period, a full duplicate of the slot config + its rules
   + the rules' weekly_pins/rotation_blocks/rotation_members. Slots
   without a snapshot inherit the default.
3. **Succession rule overrides** (per-period delta): for each
   SlotSuccessionRule — alter `days_after`, change `severity`, or
   disable.
4. **Frequency cap overrides** (per-period delta): for each
   SlotFrequencyCap — alter `max_count`, change `severity`, or
   disable.

**Two different override models** because the things being overridden
have different shapes. Slots are heavy structured objects with
several child tables; snapshots are the natural fit. Succession
rules and frequency caps are flat per-row records; per-row deltas are
the natural fit.

When the admin clicks **Generar período**, the backend identifies
every full month touching the date range, builds one CP-SAT model
covering all those dates, slots in deterministic pins (fixed_weekly +
rotation) from the snapshot config across the entire span first, then
solves the remaining variables.

Result: one Schedule row per month (same as today). Admin reviews and
publishes each month independently.

## Schema

```sql
-- Periodo itself (unchanged from V.1).
CREATE TABLE periodos_especiales (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
);

-- Snapshot of a slot's full config during a period. UNIQUE on
-- (period, slot) so there's at most one per (period, slot) pair —
-- the absence of a row means "use the slot's default config."
-- Mirrors the columns on slots but with a few extras:
--   * dismissed: true means the slot doesn't run during the period
--     at all (no demand, no assignments). Other fields ignored.
--   * a denormalised copy of every slot config field so the snapshot
--     is self-contained — no joins back to the original slot.
CREATE TABLE slot_period_snapshots (
  id                   SERIAL PRIMARY KEY,
  tenant_id            INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_id            INT NOT NULL REFERENCES periodos_especiales(id) ON DELETE CASCADE,
  slot_id              INT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  dismissed            BOOLEAN NOT NULL DEFAULT FALSE,
  -- Slot config snapshot (mirrors columns on slots; nullable where slot is).
  start_time           TIME NULL,
  end_time             TIME NULL,
  days_applied         VARCHAR(32) NOT NULL,
  custom_days_bitmap   INT NULL,
  staffing_mode        VARCHAR(32) NOT NULL,
  headcount            INT NOT NULL,
  post_slot_rest       BOOLEAN NOT NULL DEFAULT FALSE,
  counts_for_equity    BOOLEAN NOT NULL DEFAULT TRUE,
  guardia_type         TEXT NULL,
  color                VARCHAR(7) NULL,
  -- N.B. NO name column: the slot keeps its name; the snapshot
  -- describes "Guardia during Verano 2026" not "rename Guardia".
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_id, slot_id),
  CHECK (
    staffing_mode IN ('single','multiple_same','team_composition')
  ),
  CHECK (headcount >= 1)
);

-- Rules attached to a snapshot, mirroring slot_rules.
CREATE TABLE slot_period_snapshot_rules (
  id                   SERIAL PRIMARY KEY,
  tenant_id            INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id          INT NOT NULL REFERENCES slot_period_snapshots(id) ON DELETE CASCADE,
  position             INT NOT NULL,
  days_bitmap          INT NOT NULL,
  strategy             VARCHAR(16) NOT NULL,
  anchor_date          DATE NULL,
  weeks_per_position   INT NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, position)
);

-- Mirror tables for the rule's child rows.
CREATE TABLE slot_period_snapshot_rule_weekly_pins (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_rule_id   INT NOT NULL REFERENCES slot_period_snapshot_rules(id) ON DELETE CASCADE,
  weekday            SMALLINT NOT NULL,
  person_id          INT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE slot_period_snapshot_rule_rotation_blocks (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_rule_id   INT NOT NULL REFERENCES slot_period_snapshot_rules(id) ON DELETE CASCADE,
  position           INT NOT NULL,
  days_bitmap        INT NOT NULL,
  UNIQUE (snapshot_rule_id, position)
);

CREATE TABLE slot_period_snapshot_rule_rotation_members (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_rule_id   INT NOT NULL REFERENCES slot_period_snapshot_rules(id) ON DELETE CASCADE,
  position           INT NOT NULL,
  person_id          INT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  UNIQUE (snapshot_rule_id, person_id)
);

-- Team-role mirror.
CREATE TABLE slot_period_snapshot_team_roles (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id        INT NOT NULL REFERENCES slot_period_snapshots(id) ON DELETE CASCADE,
  role_label         VARCHAR(255) NOT NULL,
  headcount          INT NOT NULL DEFAULT 1,
  UNIQUE (snapshot_id, role_label),
  CHECK (headcount >= 1)
);

CREATE TABLE slot_period_snapshot_team_role_categories (
  id                          SERIAL PRIMARY KEY,
  tenant_id                   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_team_role_id       INT NOT NULL REFERENCES slot_period_snapshot_team_roles(id) ON DELETE CASCADE,
  category_id                 INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE (snapshot_team_role_id, category_id)
);

-- Allow-list snapshots (mirror slot_categories + slot_allowed_persons).
CREATE TABLE slot_period_snapshot_categories (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id        INT NOT NULL REFERENCES slot_period_snapshots(id) ON DELETE CASCADE,
  category_id        INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  UNIQUE (snapshot_id, category_id)
);

CREATE TABLE slot_period_snapshot_allowed_persons (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id        INT NOT NULL REFERENCES slot_period_snapshots(id) ON DELETE CASCADE,
  person_id          INT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  UNIQUE (snapshot_id, person_id)
);

-- KEPT FROM V.2 (unchanged) — these don't fit the snapshot model
-- because they're tenant-scoped, not per-slot.
-- slot_succession_rule_period_overrides
-- slot_frequency_cap_period_overrides

-- DROPPED (in the same migration as the snapshot tables are added):
-- slot_period_overrides       (replaced by slot_period_snapshots)
-- slot_rule_period_overrides  (replaced by slot_period_snapshot_rules)
```

All snapshot tables follow the standard RLS pattern (`tenant_id` +
FORCE ROW LEVEL SECURITY + tenant policy + albus_app grants).

## Solver changes

The V.1 + V.2 solver work had `_Context` load V.1 + V.2 override
tables and consult them through helper methods (`is_period_dismissed`,
`effective_headcount`, `effective_allowed_persons`, etc.). That
plumbing is mostly preserved — only the underlying data source
changes for the slot+rules dimension.

### Effective accessors per (slot, date)

Today, `_Context` loads slot + rule data once into in-memory dicts
keyed by `slot.id`. With snapshots, the lookup becomes per-date:

```python
def effective_slot_for(self, slot_id: int, d: date) -> EffectiveSlot:
    """Returns a frozen view of the slot's config for date d.
    Walks: if d is in a periodo AND a snapshot exists for that
    (period, slot), return the snapshot. Otherwise return the
    default slot config."""

def effective_rules_for(self, slot_id: int, d: date) -> list[EffectiveRule]:
    """Same pattern for rules."""
```

`EffectiveSlot` and `EffectiveRule` are dataclasses that match the
shape the solver already expects from `Slot` / `SlotRule`. The solver
keeps using its existing code paths — only the source of truth shifts.

This needs care because the solver currently iterates `for slot in
self.slots` (which has one entry per slot id). With snapshots, the
*config* varies per date. Either:
- **Hot path stays slot-id-keyed** but every callsite that reads
  `slot.X` is updated to `effective_X(slot_id, d)`. More accessors,
  but the loop structure is unchanged.
- **Restructure to iterate per (slot, date)**. Cleaner but a bigger
  refactor.

V.1 went with the first approach. We continue that. Each accessor
(`effective_headcount`, `effective_staffing_mode`, `effective_allowed_persons`,
`effective_allowed_categories`, `effective_team_roles`, etc.) consults
the snapshot for in-period dates and falls back to the default
otherwise.

For rules, `rule_for(slot_id, d)` needs to know whether to look in
`self.snapshot_rules_by_period_slot` or `self.rules_by_slot`:

```python
def rule_for(self, slot_id: int, d: date) -> EffectiveRule | None:
    pid = self.period_id_by_date.get(d)
    if pid is not None:
        snap_rules = self.snapshot_rules_by_period_slot.get((pid, slot_id))
        if snap_rules is not None:  # snapshot exists for this (period, slot)
            for r in snap_rules:
                if r.days_bitmap & (1 << d.weekday()):
                    return r
            return None  # snapshot exists but no rule covers this weekday
    # No snapshot → default rule lookup, unchanged.
    for r in self.rules_by_slot.get(slot_id, ()):
        if r.days_bitmap & (1 << d.weekday()):
            return r
    return None
```

Same routing pattern for `rotation_persons_for`, `fixed_weekly_persons`,
team_role lookups, etc.

### Succession + caps (unchanged from V.2)

The two override tables we keep behave identically to V.2:
`effective_succession_rule(rule, d)` and `effective_frequency_cap(cap, d)`
return `(value, disabled)` tuples. Solver consults them at constraint
emission time.

### Multi-month solve (unchanged from V.1)

`generate_period(db, *, tenant_id, period_id, membership_id)` already
works. It computes touched months, builds a single CP-SAT model
spanning all dates, threads `schedule_id_by_date` through
`_solve_cpsat` and `_greedy_fallback`. No change.

### Dual equity buckets (still V.3)

Period vs non-period bucket split in `_balance_term`. Weekend balance
same treatment. Frequency-cap prior-counts lookback grown to period
length. Not in V.2.5; lands in V.3.

### Rotation skip-to-next (still V.3)

When the snapshot rotation member is on vacation, walk forward
through positions. Already designed; lands in V.3.

## UX

### `/admin/periodos` — periodo list (unchanged from V.1)

### `/admin/periodos/[id]` — periodo editor

**Two tabs:** Actividades + Reglas.

**Actividades tab** — list of slots. Each row:
- Slot name + plazas summary + status pills ("No aplica en el periodo"
  or "Modificada" when a snapshot exists)
- **Editar** button → opens the existing `SlotDialog` component
  (from `/admin/slots`) in `mode="period-snapshot"`. The dialog
  pre-fills from the snapshot if one exists, otherwise from the
  slot's defaults. Mara edits anything she wants: name (read-only
  in this mode — the slot keeps its name across periods), horario,
  días aplicados, plazas, color, allowed categorías/personas, rules
  with full RuleCard editing (strategy radios, day picker, rotation
  editor, fixed_weekly editor). On save, the dialog POSTs to
  `/api/periodos/{id}/slot-snapshots/{slot_id}`.

A separate **"No aplica durante el periodo"** toggle lives above the
dialog body (or as the first field) — checking it stores
`dismissed=true` on the snapshot and grays out the rest.

A small **"Quitar modificación"** button reverts the snapshot
(`DELETE /api/periodos/{id}/slot-snapshots/{slot_id}`).

**Reglas tab** — three sections (Incompatibilidades, Sucesión,
Límites de frecuencia). Each row uses the V.2 delta UI: shows
defaults, Modificar opens an inline form. Unchanged from V.2.

### Planning grid banner

Unchanged from V.1. When a schedule month overlaps an active periodo,
show an amber banner above the grid pointing at the editor.

## Routes

```
GET    /api/periodos                                    list
POST   /api/periodos                                    create
GET    /api/periodos/{id}                               fetch
PATCH  /api/periodos/{id}                               edit
DELETE /api/periodos/{id}                               delete

GET    /api/periodos/{id}/slot-snapshots                list snapshots
PUT    /api/periodos/{id}/slot-snapshots/{slot_id}      upsert snapshot
DELETE /api/periodos/{id}/slot-snapshots/{slot_id}      revert to default

# Succession + cap overrides — kept from V.2 unchanged.
GET    /api/periodos/{id}/succession-overrides
PUT    /api/periodos/{id}/succession-overrides/{rule_id}
DELETE /api/periodos/{id}/succession-overrides/{rule_id}
GET    /api/periodos/{id}/cap-overrides
PUT    /api/periodos/{id}/cap-overrides/{cap_id}
DELETE /api/periodos/{id}/cap-overrides/{cap_id}

POST   /api/periodos/{id}/generate                      multi-month solve

# Dropped (V.1/V.2):
# GET/PUT/DELETE /api/periodos/{id}/slot-overrides
# GET/PUT/DELETE /api/periodos/{id}/rule-overrides
```

The snapshot PUT payload mirrors the existing `/api/slots/{id}` PUT
schema (full slot + nested rules + nested allow-lists), with an extra
`dismissed: bool` field at the top level. Same shape, same validator.

## Phasing (revised)

V.1 + V.2 are shipped but the slot/rule UI half of them gets
swapped for the snapshot model in **V.2.5**.

**V.2.5 — Snapshot pivot (~5–7 days)**
- Migration 0077: add snapshot tables + drop V.1 `slot_period_overrides`
  + V.2 `slot_rule_period_overrides`.
- Models + Pydantic schemas for the snapshot family.
- Solver refactor: `effective_*` accessors consult snapshots for
  in-period dates instead of the V.1/V.2 deltas.
- Routes: drop V.1/V.2 slot+rule override endpoints; add snapshot
  endpoints.
- Frontend: refactor `SlotDialog` to accept `mode` prop. Drop the
  Actividades-tab custom modal I built in V.2; replace with the
  existing SlotDialog opened in `period-snapshot` mode.

**V.3 — Solver smartness (~3 days)**
- Period vs non-period dual equity buckets.
- Weekend balance same treatment.
- Prior-counts lookback grown to period length.
- Rotation skip-to-next-in-position when a member is bloqueo'd.

## Open questions / future work

- **Slot name in the snapshot**: a snapshot can't rename a slot (the
  default's name is the source of truth). If Mara wants to call the
  same slot something different during a period, we'd add a `name`
  column to the snapshot. Skipping for now.
- **Categoría / allowed-person changes propagate down to team_roles?**
  When the admin edits a snapshot with team_composition staffing,
  the per-role category lists live on a separate snapshot table.
  Cleanly mirrors the defaults; just lots of mirror tables.
- **Period preview before generate.** Before committing the solve,
  show a dry-run summary. Nice-to-have, not v1.
- **Stats per period.** /admin/stats currently filters by month;
  could add a "by period" view.
- **Year-over-year copy.** Tiny follow-up if requested.
- **Violations engine awareness.** When a date is inside a periodo
  and a snapshot exists, violations should consult the snapshot's
  rules. Today they use the default. Same caveat as V.1.
- **Auto-detect period boundaries.** If many bloqueos cluster in a
  date range, suggest creating a periodo. Nice-to-have.

## Risks

- **Solver refactor blast radius**: every callsite that reads
  `slot.X` or iterates `self.rules_by_slot[slot.id]` becomes a
  potential bug if it forgets to use the effective accessor. Tests
  with snapshots and without snapshots help here. The V.1 + V.2
  helpers already gated most of this — the V.2.5 work mostly swaps
  the data source the helpers read from.
- **Snapshot drift**: if the admin edits the default slot AFTER
  creating a snapshot, the snapshot doesn't auto-update. That's
  arguably correct (Mara's summer Guardia might intentionally
  differ from the new default), but worth surfacing in the UI with
  a small "snapshot may be out of date" hint when the snapshot's
  `created_at` is older than the slot's `updated_at`. Defer to V.3.
- **CP-SAT solve time** (unchanged from V.1).
- **Schema migration on prod**: V.1 and V.2 tables are empty in
  prod (no Mara data has hit them yet), so dropping them is safe.
  Snapshot tables are additive. Standard backup before deploy.

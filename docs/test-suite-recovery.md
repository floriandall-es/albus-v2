# Test-suite recovery — handoff spec

Self-contained plan to finish restoring the backend test suite. Written
for a fresh session with no prior context.

## TL;DR

The backend pytest suite had been red since the CNH/equipos/hospital
redesign — its fixtures spoke the pre-redesign API. It's been recovered
from **168 failing → 18 failing / 0 errored** (stable on a fresh DB), all
on `main`. Along the way two real backend bugs were fixed (voice-notes
GRANT; bulk pending-invite warning). No other real product bugs were
found — the rest were stale tests for contracts/features that legitimately
changed or were removed.

Two things remain:

1. **Task A — fix the test-harness isolation** (prerequisite). The
   fixtures funnel every signup into one shared hospital and
   `_clean_db` only truncates `tenants`/`persons`; tests that
   *successfully* create servicios/members leak state across the full
   suite. This must be fixed first.
2. **Task B — finish the last ~18 failing tests** (all stale/contract,
   no product bugs). Some of this is already written and parked on a
   branch (see below).

## How to run the suite

Docker is the only reliable way (native deps: WeasyPrint, ortools).

```bash
cd <repo>
docker compose up -d db                       # Postgres on :55432
docker compose build api                      # has all native deps
# full suite (creates albus_test + runs migrations via conftest):
docker compose run --rm api pytest -q -p no:cacheprovider
# force a clean DB if you suspect accumulated state:
docker compose exec -T db psql -U albus -d postgres -c "DROP DATABASE IF EXISTS albus_test;"
```

Baseline to confirm before starting: **`main` on a fresh `albus_test` =
18 failed, 0 errored.** If you see ~123, you're running with the parked
WIP applied or accumulated DB cruft — reset.

## Current failing files on `main` (the 18)

| File | ~Count | What it needs |
|---|---|---|
| `test_availability_self_service.py` | 7 | member `POST /api/me/availability-requests` now requires `reviewer_membership_id` (migration 0083). **Fix written — parked.** |
| `test_signup_slug_generation.py` | 5 | slug now derived from equipo+servicio; collision suffix is a random hex token, not `-2`. **Fix written — parked** (rewritten to unit-test `_slugify_tenant_name` directly + one signup-based collision test). |
| `test_slots.py` | 3 | setup helper `_skills` POSTs `/api/skills` (removed). Rework to drop the skills dependency (slot "nested" structure is now team_roles/rules, not skills_required). |
| `test_assignment_edit.py` | 3 | `_onboard`/setup builds the removed skills model; failures: `KeyError 'person_id'`, and `3 not in {1,2,3}`. Rework setup to current model. |

Plus: **re-add coverage** for two core solver guarantees whose tests were
deleted because they were built on the removed `skills` mechanism —
`test_unfilled_when_no_eligible_person` (unfilled slot → NULL) and
`test_solver_falls_back_when_infeasible` (infeasible → fallback). Re-add
them using a **category restriction that no member satisfies**
(`allowed_category_ids` / slot category gating) instead of a hard skill.

## Parked work (already written)

Branch **`wip/test-suite-bucket3`** (commit `d34288e`) contains the
finished reworks for the two parked files:

- `test_signup_slug_generation.py` — rewritten to test the pure helper
  `app.routes.auth._slugify_tenant_name` directly (basic / accents /
  symbols-only-returns-empty / pattern) plus one end-to-end collision
  test (same equipo+servicio → distinct slug with a `-<hex>` suffix).
- `test_availability_self_service.py` — injects
  `reviewer_membership_id=info["membership_id"]` into every member
  request body, and adds `assert r.status_code == 201, r.text` to
  `_onboard`.

**Do NOT merge that branch until Task A is done** — applied on top of
`main` it spikes the full suite 18 → 123 (each file still passes *alone*).
That spike is the symptom that exposed Task A.

## Task A — fix the test-harness isolation (do this first)

### The problem

`api/tests/conftest.py`:
- `cnh_hospital` (session-scoped) seeds ONE CNH hospital; every
  signup-based fixture (`auth_client`, `second_tenant`, direct signups)
  creates its equipo/servicio **inside that one hospital**.
- `_clean_db` (autouse, per-test) only does
  `TRUNCATE tenants, persons RESTART IDENTITY CASCADE`.

`servicios` (and other hospital-scoped tables: conversations,
voice_notes, etc.) are NOT truncated, so they **accumulate across the
whole session** — a full run was observed leaving ~1781 `servicios`
rows. Combined with `RESTART IDENTITY` reusing low tenant ids each test,
tests that *successfully* create servicio/member/block rows leak state
into later tests (e.g. `test_categories` asserting an empty list saw
leftover rows; `slug → categories` reliably reproduces).

Why it was masked: on `main`, the still-broken tests (old slug payload
422s; availability request 422s for missing reviewer) **fail before
creating much data**, so they don't leak. Fixing them (parked branch)
makes them *succeed* and create rows → leak → full-suite flakiness.

### The gotcha (don't repeat)

A naive `_clean_db` change to also `TRUNCATE servicios ... CASCADE` did
**not** cleanly fix it and appeared to make things worse in a tangled
run. Don't just bolt that on — design isolation deliberately and measure
one change at a time with `-p no:cacheprovider` on a freshly-dropped
`albus_test`.

### Options (pick one, verify rigorously)

1. **Per-test hospital (preferred).** Make `cnh_hospital`
   *function-scoped*: each test gets its own hospital, and `_clean_db`
   truncates the full hospital subtree (`hospitals` CASCADE, or
   `hospitals, persons` CASCADE) so nothing leaks. Cleanest isolation;
   verify the ordering (the seed must run after the truncate — an
   autouse truncate fixture + the `cnh_hospital` fixture the tests
   depend on).
2. **Truncate the subtree, keep one hospital.** Keep `cnh_hospital`
   session-scoped but have `_clean_db` truncate everything hospital-
   scoped *except* the hospital row (`servicios`, `conversations`,
   `voice_notes`, `meetings`, …). More tables to enumerate; brittle as
   new hospital-scoped tables appear.

Option 1 is more robust. Whichever you pick:

### Verification for Task A

- `main` + harness fix, fresh DB, full suite: still **18 failed / 0
  errored**, and **deterministic across 2–3 consecutive runs** and
  across `-p no:randomly` ordering. (The fix must not change which tests
  fail — only make the suite order-independent.)
- Confirm no table accumulates: after a full run,
  `SELECT count(*) FROM servicios` (and conversations, voice_notes)
  should be small/zero, not thousands.

## Task B — finish the last ~18

1. Land the harness fix (Task A).
2. Merge / cherry-pick `wip/test-suite-bucket3` (slug + availability) and
   confirm the full suite stays deterministic.
3. Rework `test_slots.py` and `test_assignment_edit.py` off the removed
   `skills` model (use categories / team_roles).
4. Re-add the two deleted solver guarantees via category restriction.
5. Goal: **0 failed**, or a tiny residue each justified in-code.

## Domain facts a fresh session needs

- **Signup contract** (`POST /api/signup`, `app/schemas/auth.py`):
  `first_name`, `email`, `password`, `accept_terms: true`, `hospital_id`
  (must be a CNH-coded hospital — `public_code` non-null), and either
  `servicio_id` (join → pending) or `servicio_name` (create → auto-
  approved), plus `equipo_name`. Returns
  `{access_token, tenant{id,slug}, person{id,email}, memberships[]}`.
- **Invite-accept** (`POST /api/invitations/by-token/{t}/accept`)
  requires `accept_terms: true` (migration 0039) in addition to
  `password`.
- **Invite creates a pending member immediately** (migration 0059):
  after `POST /api/team/invite`, `/api/team` shows the invitee with
  `is_pending=true`. Re-inviting the same email **409s** (use the resend
  endpoint, migration 0048); the bulk flow treats a pending email as a
  **warning + skip**, not an error (fixed in `routes/team_bulk.py`).
- **Slug**: server-derived from equipo + servicio via
  `_slugify_tenant_name` + `_generate_unique_slug` (`app/routes/auth.py`).
  Collision → random hex suffix (`-4b5307`), not sequential.
- **Removed in the redesign** (don't write tests against these):
  `/api/skills`, `/api/pools`, `person_skills`, slot `skills_required`
  filtering, `guardia_types`/`does_guardias`, membership
  `exemption_type`/`exemption_until`.
- **RLS guard** (`test_rls_guard.py`): has a reviewed `_RLS_EXEMPT`
  allowlist for 3 system-accessed tables (`meeting_reminders_sent`,
  `billing_emails_sent`, `admin_promotion_requests`). Don't add to it
  without the same scrutiny.
- The shared CNH hospital fixture is `cnh_hospital`; signup helper is
  `_signup_payload` in `conftest.py`.

## Caveat on scope

This restores a thin **integration** suite to green/deterministic. It
does NOT add the unit coverage the big redesigns (scheduler/solver,
equipos, vacations) never had. Restoring the safety net ≠ making it
dense; deeper coverage is a separate effort.

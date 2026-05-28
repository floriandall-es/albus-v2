# Billing plan — Trivu

Pricing + monetisation reference. Source of truth for when we
start building the Stripe integration. Not yet implemented in
code.

## Status — handoff from prior session

This doc was revised in conversation. The numbers and model
below supersede earlier drafts. Specifically:

- **Pricing**: €29.90/mo admin, €4.90/mo member (not €25 / €5).
- **Two billing models** now, picked at admin signup, switchable
  later:
  - `members_pay` (default) — admin pays for themselves; each
    member chooses to subscribe for app access OR stays on paper.
  - `team_pays` — admin pays €29.90 + €4.90 × N for all members;
    a single invoice covers the equipo. Useful for departments
    with a tools budget.
- **Trial-only horizon limit**: while on the 30-day trial the
  admin can only generate planning for the current month + 2
  months ahead. Stops a trial admin from spinning up a year's
  worth of planning then walking. No limit on paid subscription.
- **No card required at signup** for the admin's trial, same for
  members.
- **Alpha pilots get grandfathered free for life** (admin + their
  members both at €0). Migration sets their subscription_status to
  `active` and a far-future trial_end_at.

Next session picks up at **"Implementation chunks"** below.

**Progress as of 2026-05-28 (this conversation):**
- ✅ Chunk 2: migration 0080_billing (tenants + persons billing
  columns, stripe_events idempotency table, partial unique
  indexes on Stripe IDs).
- ✅ Chunk 3: `app/services/stripe_client.py` — customer +
  subscription + portal + webhook helpers.
- ✅ Chunk 4: `app/routes/stripe_webhook.py` — sig verify,
  idempotency, dispatch on `customer.subscription.*`.
- ✅ Chunk 5: trial-horizon enforcement on the three generate
  endpoints via `can_generate_for()`.
- ✅ Chunk 6: hard-gate at request time via
  `require_active_subscription` dependency (402 on lapsed).
- ✅ Chunk 7: onboarding picker + `PATCH /api/billing/model`.
- ✅ Chunk 9: `/admin/billing` page + `GET /api/billing/summary` +
  `POST /api/billing/portal`.
- ✅ Chunk 10: `/me/billing` page + `GET /api/billing/me` +
  `POST /api/billing/me/portal`.
- ✅ Chunk 11: cross-shell `<BillingBanner />` (trial countdown,
  past_due, unpaid, canceled).
- ✅ Chunk 12: `/admin/team` subscription chips (🟢 Activo /
  🟡 Prueba / ⚪ En papel) + sortable column.
- ✅ Chunk 13: migration 0081_grandfather_alpha — flips every
  existing tenant + member to `active` + far-future trial_end,
  billing_model=team_pays. Runs once on prod when we deploy
  this branch; the cutoff is "NOW()" at migration time.
- ✅ Chunk 15: landing pricing card update — "Opcional" framing,
  team_pays callout below the cards.
- ✅ Chunk 8: member invite flow — under `members_pay` the
  accept page surfaces a "Probar 30 días gratis" / "No, gracias
  — seguiré en papel" picker (required pick); under `team_pays`
  shows a short courtesy note and the server flips the invitee
  to 'active' on accept. Trial picks land as `trialing` with
  trial_end = now + 30 days.
- ✅ Chunk 16: RUNBOOK §8 with Stripe keys location, test cards,
  webhook replay, manual grandfather SQL, common failure modes.

**Still TODO before going live:**
- Chunk 1: Stripe Dashboard setup (manual, no code) — create
  the two recurring prices, the webhook endpoint, paste IDs
  into `/srv/albus/.env`.
- Chunk 14: nine email templates (trial-ending × 3, trial-ended,
  payment-failed, sub-canceled, member trial-ending × 3, plus
  the "team switched models" system email).

## GTM shape

Two-track motion sold off the same product:

- **Self-serve** (default, ship first): jefe de servicio buys it on
  a corporate card. Lands one service at a time, zero procurement.
  Individual adjuntos optionally self-subscribe for app access.
- **Enterprise** (later, hospital-wide): RH / dirección médica buys
  a multi-service deal. Bundles all adjuntos' app access + the data
  layer (compliance dashboard, cross-service analytics, etc.) +
  SSO + dedicated support.

The self-serve track lands the product inside a hospital one
service at a time. The enterprise track converts that beachhead
into a hospital-wide contract once we have 2–3 services on
self-serve and the RH has noticed the data we sit on.

## Self-serve pricing

Two SKUs. The admin chooses at signup which billing model the
equipo runs on.

### Pricing

| Who pays | What | €/mo |
|---|---|---|
| **Admin** (always) | Admin tooling: planning generation, rules, periodos especiales, stats, sub-equipos. Plus their own app access. | **€29.90** |
| **Member** (`members_pay` mode) | Their own app access: mobile schedule, reminders, swap requests, bloqueo requests, directory. | **€4.90** |
| **Member** (`team_pays` mode) | Same as above, but the admin's invoice covers it — admin pays €29.90 + €4.90 × N | included in admin's bill |
| Pendientes (invited, not activated) | Don't count toward billing. | €0 |
| Disabled memberships | Not billed. | €0 |

### Billing model — picked at signup

At the end of onboarding (`/onboarding/done` or a step before it),
the admin answers one question:

> **¿Cómo se paga Trivu para este equipo?**
>
> ◯ **Cada miembro decide** (default)
> Tú pagas 29,90 €/mes. Cada compañero decide si quiere acceso al
> móvil por 4,90 € — o sigue con el papel. Más flexible, sin
> presupuesto compartido.
>
> ◯ **El equipo paga por todos**
> Una sola factura: 29,90 € + 4,90 € por miembro activo. Ideal si
> tienes presupuesto para herramientas digitales.
>
> Podrás cambiarlo cuando quieras desde Facturación.

Stored as `tenants.billing_model = 'members_pay' | 'team_pays'`.
Switchable from `/admin/billing` later (with confirmation for the
team_pays → members_pay direction since it pulls the rug from
under the team).

### Trial

- **Admin trial**: 30 days from tenant creation. Stripe Subscription
  with `trial_period_days=30`. No card required at signup.
- **Member trial** (`members_pay` only): 30 days from when the member
  clicks "Probar 30 días gratis" on the post-invite screen. No card
  required at start.
- **Member trial doesn't exist in `team_pays` mode** — members get
  access automatically when the admin invites them, and the admin's
  trial / subscription is what's billed.

### Trial-only horizon limit

While on `subscription_status = 'trialing'`, the admin can only
generate planning for the current month + 2 months ahead. Going
beyond that (e.g. a periodo whose `end_date` is in month + 3 or
later) returns 403 with a "Suscríbete para planificar todo el año"
explainer.

Doesn't apply to paying admins (`active` / `past_due` within grace).

### Pendientes

Invited members who haven't activated: counted as scheduled members
(the planner picks them up like any other Membership), but **don't
consume a billable seat**. Only counted once they accept the invite
and set a password.

## Who buys what

### The tenant subscription (always)

- Bought by the admin on signup, billed to a Stripe Customer
  attached to the tenant
- Self-serve via Stripe Checkout — corporate card, no procurement
  needed for amounts under ~€500/mo
- **One Subscription per tenant** with one or two SubscriptionItems:
  - `members_pay` mode: 1 item — `price_admin × 1`
  - `team_pays` mode:   2 items — `price_admin × 1` + `price_member × N`
- N updates whenever a member activates, gets disabled, or has their
  role flipped admin↔member. Quantity changes are PATCHed to Stripe;
  proration is automatic on the next invoice.
- Trial: `trial_period_days=30` at signup. No card required.

### The individual member subscription (members_pay only)

- Bought by each member from `/me/billing` (or right after
  invite-accept via the "Probar 30 días gratis" CTA)
- Stripe Checkout, personal or expense card
- One Customer + one Subscription per Person. Cancels anytime via
  Stripe Customer Portal.
- Never exists under `team_pays` — those members are covered by
  the tenant subscription.

### Cross-tenant members

A Person who's a member of multiple tenants:
- Under `members_pay`: pays **one** personal subscription that
  follows them across every tenant where their personal sub is
  honoured.
- Under `team_pays`: the tenant pays for them in that tenant;
  their personal sub is unaffected for other tenants.
- Access logic per tenant:
  ```
  def has_app_access(person, tenant):
      if tenant.billing_model == "team_pays":
          return tenant.subscription_status in ("active", "trialing")
      return person.subscription_status in ("active", "trialing")
  ```

### Auto-pause member subs when admin's lapses

If the admin's subscription goes `unpaid` / `canceled`, every member's
personal subscription in that tenant gets `pause_collection` set via
Stripe — they stop being charged until the admin reactivates. Without
the admin's sub the planning isn't published anyway, so there's
nothing for the member to pay for.

## Why this shape

1. **Admin's value is independent of member adoption.** Admin pays
   €29.90 for planning power. Zero member subscriptions → admin
   still gets full value (just keeps printing the planning, which
   the team reads from paper).
2. **Members vote with their wallet.** Under `members_pay` the
   chief gets honest market feedback on whether the app is worth
   €5 to the team. Under `team_pays` the chief decides for the
   team — appropriate when there's a budget for tooling.
3. **No forced onboarding.** Under `members_pay`, a member who
   prefers paper just clicks "No, gracias — seguiré en papel" on
   the invite screen. The admin still includes them in planning;
   they just don't log in.
4. **Self-serve everywhere.** No sales team needed. Admin uses
   corporate Visa on Stripe Checkout. Member uses personal card on
   the same flow. Hospital-wide enterprise deals (one big invoice,
   negotiated price) come later as an upmarket motion.

## Past-due policy

| Subscription state | Effect |
|---|---|
| `trialing` | Full access |
| `active` | Full access |
| `past_due` (1–7 days) | Banner: "Renueva tu suscripción para evitar interrupciones" |
| `past_due` (>7 days) or `unpaid` | Read-only — mutation endpoints return 402, banner with "Renovar" link to Stripe Customer Portal |
| `canceled` | Tenant becomes read-only immediately; data retained for 90 days |

Same per-adjunto: past-due individual sub → app access stops at the
next billing cycle; they fall back to PDF.

## Tax + currency

- **Currency**: EUR
- **VAT**: 21% IVA on Spanish customers; reverse charge for EU B2B
  customers with valid VAT ID. **Stripe Tax** handles both
  automatically — invoice numbering and IVA breakdown are compliant
  with Spanish AEAT requirements.
- Stripe Customer Portal lets the admin / adjunto update their VAT
  ID and download invoices.

## Stack

- **Payment processor**: Stripe Billing
- **Tax**: Stripe Tax
- **Card data**: never touches our servers. Stripe Checkout (signup)
  + Stripe Customer Portal (manage card / cancel / download
  invoices).
- **Webhook signing secret**: stored in `/srv/albus/.env`, rotated
  on compromise.

## Implementation chunks

≈3 weeks total. Order matters; later items depend on earlier.
Each chunk is independently shippable.

### 1. Stripe setup (external, not code)

- Create Stripe account, enable Stripe Tax, register for IVA in ES
- Create 2 Products + 2 Prices in EUR:
  - `price_admin`  — €29.90/mo, attached to product "Trivu Admin"
  - `price_member` — €4.90/mo,  attached to product "Trivu Member"
- Generate the webhook signing secret, add to `/srv/albus/.env`
  as `STRIPE_WEBHOOK_SECRET` along with `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_ADMIN`, `STRIPE_PRICE_MEMBER`
- (No annual variant in v1 — roadmap)

### 2. Migration 0080

```sql
ALTER TABLE tenants
  ADD COLUMN stripe_customer_id     TEXT,
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN subscription_status    TEXT
    CHECK (subscription_status IN
      ('trialing','active','past_due','unpaid','canceled')),
  ADD COLUMN trial_end_at            TIMESTAMPTZ,
  ADD COLUMN billing_email           TEXT,
  ADD COLUMN billing_tax_id          TEXT,  -- NIF / CIF
  ADD COLUMN billing_model           TEXT NOT NULL
    DEFAULT 'members_pay'
    CHECK (billing_model IN ('members_pay','team_pays'));

ALTER TABLE persons
  ADD COLUMN stripe_customer_id     TEXT,
  ADD COLUMN stripe_subscription_id TEXT,
  ADD COLUMN subscription_status    TEXT NOT NULL
    DEFAULT 'never_subscribed'
    CHECK (subscription_status IN
      ('never_subscribed','trialing','active','past_due','canceled')),
  ADD COLUMN trial_end_at            TIMESTAMPTZ;

CREATE TABLE stripe_events (
  id           SERIAL PRIMARY KEY,
  event_id     TEXT UNIQUE NOT NULL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error        TEXT
);
```

Plus SQLAlchemy models for the new columns + StripeEvent.

### 3. Stripe service wrappers (backend)

- `app/services/stripe_client.py` — thin wrapper around the
  Stripe Python SDK: `create_customer`, `create_subscription`,
  `update_subscription_items`, `pause_collection`,
  `cancel_subscription`, `create_billing_portal_session`,
  `verify_webhook`. No business logic.
- `app/services/billing.py` — domain logic:
  - `start_admin_trial(tenant)`: creates Customer + Subscription
    with `trial_period_days=30`, items per `billing_model`
  - `start_member_trial(person, tenant)`: members_pay-only;
    Customer + Subscription with trial
  - `reconcile_team_pays_seats(tenant)`: counts active members,
    PATCHes `price_member` quantity on the tenant's Subscription
  - `switch_billing_model(tenant, new_model)`: handles both
    directions, including the team→members rug-pull warning flow
  - `pause_members_when_admin_lapses(tenant)`: bulk
    `pause_collection` on every members_pay member sub when the
    admin's sub goes unpaid/canceled
  - `has_app_access(person, tenant) -> bool`: the gate logic
    above
  - `can_generate_for(tenant, target_date) -> tuple[bool, str?]`:
    the trial-horizon check (current month + 2 max while
    `trialing`)

### 4. Webhook endpoint

`POST /api/stripe/webhook`:
- Verify signature against `STRIPE_WEBHOOK_SECRET`
- Idempotent via `stripe_events.event_id` unique constraint
- Dispatch on event type:
  - `customer.subscription.updated` / `.deleted` → update relevant
    `subscription_status` (tenant or person, via Stripe metadata
    `tenant_id` or `person_id`)
  - `customer.subscription.trial_will_end` → send "7 days left"
    email
  - `invoice.paid` → update `trial_end_at`/period info
  - `invoice.payment_failed` → flag past_due, send email
- Each handler emits a transactional email via the existing email
  worker when appropriate

### 5. Trial horizon enforcement

`can_generate_for(tenant, target_date)` wired into:

- `POST /api/schedules/{id}/generate`
- `POST /api/periodos/{id}/generate` (check `periodo.end_date`,
  not just start, so a Verano Jul–Sep started in May is blocked)
- `POST /api/schedules` (create)

Returns 403 with the explainer string the frontend renders verbatim.

### 6. Access gating (the hard gate)

- `has_app_access(person, tenant)` helper in `routes/deps.py`
- New dependency `require_active_subscription` for write
  endpoints: planning generate/edit, invite, approve swaps/
  vacations/coverage, publish
- Read endpoints unaffected (people keep viewing history)
- `routes/me.py` login flow: reject if `has_app_access` returns
  False and there's no `never_subscribed` reactivation path open

### 7. Onboarding flow update

- New step at end of onboarding: billing model picker (radio +
  copy from the "Billing model — picked at signup" section above)
- After choice, `start_admin_trial(tenant)` runs
- Defaults persisted on tenant

### 8. Member invite flow update

- For `members_pay` tenants, invite-accept page after password
  setup gets the two-button choice:
  - "Probar 30 días gratis" → `start_member_trial(person, tenant)`,
    lands them on /me
  - "No, gracias — seguiré en papel" → person stays
    `never_subscribed`, no login access (logout, page says
    "tu cuenta queda lista; si más adelante quieres acceso,
    pídeselo a tu admin")
- For `team_pays` tenants, skip the choice — straight to /me;
  `reconcile_team_pays_seats(tenant)` runs in the activate handler

### 9. `/admin/billing` page

- Plan summary: billing_model, status, trial countdown / next
  invoice date + amount
- Seat breakdown: admins × N, members × M (in team_pays mode this
  is also what's being billed)
- "Cambiar modelo de pago" toggle: members_pay ↔ team_pays, with
  confirmation modal for team→members (explains the team gets
  invited to subscribe themselves with a 30-day grace period)
- "Gestionar facturación" button → Stripe Customer Portal session
- Past invoices list (link to portal)

### 10. `/me/billing` page

- Renders only for `members_pay` tenants
- Under `team_pays`: shows "Tu equipo paga tu suscripción — sin
  acción requerida"
- `members_pay` states:
  - `never_subscribed`: "Activar acceso a la app — 30 días gratis"
    → starts trial
  - `trialing` / `active`: status + next invoice + "Gestionar
    tarjeta" → Stripe Portal
  - `past_due`: "Actualiza tu método de pago" prompt
  - `canceled`: "Reactivar 4,90 €/mes" prompt

### 11. Banners + UI states

- Admin banners: trial ending (days remaining starting day 21),
  past_due (red), canceled/unpaid (red, with reactivation CTA)
- Member banners: same set for personal subs under `members_pay`
- Trial-horizon banner on `/admin/schedule`:
  > Durante la prueba puedes planificar hasta {month+2}. Suscríbete
  > para todo el año →
- Generate button: disabled for out-of-horizon months with tooltip
  + link to `/admin/billing`
- Lapsed admin: read-only banner across /admin
- Lapsed member: read-only banner + paywall page when they hit
  any write surface

### 12. Team list subscription chips (`/admin/team`)

Per-member chip showing subscription state:
- 🟢 Activo (paying, in trial, or covered by team_pays)
- 🟡 Prueba (personal trial running under members_pay)
- ⚪ En papel (never_subscribed or canceled — admin plans them but
  they don't see the app)

Sortable column. Hover tooltip on each chip explains what it
means + the relevant date (trial ends, next bill, etc.).

### 13. Grandfather migration (alpha pilots)

One-off SQL — pulled into migration 0080's `upgrade()` or a
follow-up data migration:

```sql
UPDATE tenants
   SET subscription_status = 'active',
       trial_end_at        = '2099-12-31',
       billing_model       = 'team_pays'  -- they all behave like team_pays since nothing's billed
 WHERE created_at < '<billing-go-live-date>';

UPDATE persons p
   SET subscription_status = 'active',
       trial_end_at        = '2099-12-31'
  FROM memberships m
 WHERE m.person_id = p.id
   AND m.tenant_id IN (SELECT id FROM tenants WHERE created_at < '<billing-go-live-date>');
```

### 14. Email templates × 9

Admin:
- Trial ending (day 23 / day 27 / day 29 — three sends, same
  template with countdown number)
- Trial ended → past_due (day 31)
- Payment failed
- Subscription canceled

Member (members_pay):
- Trial ending (same cadence)
- Trial ended
- Payment failed

System:
- "Your team switched to team_pays — your personal sub has been
  refunded and you continue with access at no cost"

All sent through the existing email worker.

### 15. Landing pricing page update

In `web/src/app/page.tsx`:
- Member card subtitle: "Opcional — cada miembro decide"
- Add a third callout below the two cards: "¿Servicio con
  presupuesto? Pagas todo de una sola factura: 29,90 € + 4,90 €
  por miembro. Configurable desde la cuenta del admin."
- FAQ pricing answer updated to mention both billing models

### 16. CLAUDE.md / RUNBOOK addendum

- Stripe keys + webhook secret location (`/srv/albus/.env`)
- Test card numbers (`4242 4242 4242 4242` etc.)
- How to replay a webhook locally (`stripe trigger ...`)
- How to manually grandfather a tenant if needed

## Open questions (self-serve)

Model is settled. These are build-time decisions to make as we go:

- **Multi-tenant person edge case**: a Person who's a member of two
  equipos, each with a different `billing_model`. Access logic per
  tenant per the helper above; confirm during step 6 that the
  helper handles this cleanly with no leaks.
- **Refund policy on mid-month cancellation**: Stripe's default is
  "credit toward next invoice." For a final cancel (no next
  invoice) we may want explicit refund logic — TBD by step 9.
- **Tax invoice address collection**: hospital's billing address
  comes via Stripe Portal at first-card-entry. Confirm Spanish
  AEAT-compliance with whatever Stripe Tax emits.
- **Exact copy** for: trial-ending banner / emails, past-due
  banner, paywall page for canceled members, team→members switch
  warning modal.
- **Annual variant**: roadmap, not v1. Add a price tier in Stripe
  later when we have customer pull.

## Decisions confirmed in conversation

For the record, in case future-Florian wonders if a knob was missed:

- ✅ Stripe as the provider
- ✅ Default `billing_model = 'members_pay'`
- ✅ Card not required at signup (trial-without-card)
- ✅ Pendientes don't count as billable seats
- ✅ Multiple admins → each at €29.90/mo
- ✅ Soft warning for 7 days then hard gate on lapse
- ✅ NIF/CIF mandatory at first card entry (via Stripe Portal)
- ✅ No annual discount yet (roadmap)
- ✅ Auto-pause member subs when admin's lapses
- ✅ "Never subscribed" members can't log in at all (under
  members_pay; the "no thanks I'll stay on paper" path goes here)
- ✅ Alpha pilots grandfathered (full €0 lifetime, admin + members)
- ✅ Billing model switchable post-signup
- ✅ Trial-only horizon: current month + 2 months
- ✅ Periodos especiales: horizon check against `periodo.end_date`

## Enterprise tier

Sold top-down to hospital RH / dirección médica once we have a
beachhead inside the hospital (2–3 services already on self-serve,
admins happy, RH curious). This is **not** the first SKU we
build — see "Phasing" below.

### Pricing structure

- **Per-service fee**, volume-discounted vs self-serve. Indicative:
  €19/servicio/mo when ≥3 services on contract, €15 at ≥6.
- **Hospital platform fee** that bundles the data layer + SSO +
  dedicated support. Indicative: €500–1500/mo depending on hospital
  size (number of beds is the easiest external proxy).
- **All adjunto app access included** — no individual subs to
  chase, no fragmentation. Residentes still free (now redundant
  with "everyone included" but kept as policy).
- **Annual contract**, signed via a real MSA. Stripe Billing still
  handles the actual charge but with a custom-quoted invoice
  generated from the negotiated terms.

### Included beyond self-serve

| Feature | Self-serve | Enterprise |
|---|---|---|
| Solver, rules, planning, PDF | ✓ | ✓ |
| Admin's app access | ✓ | ✓ |
| Adjunto app access | optional, €5/mo each | included for all |
| Sub-equipos | ✓ | ✓ |
| Convenio compliance dashboard | — (or premium add-on) | ✓ |
| Cross-service analytics | — | ✓ |
| Headcount planning | — | ✓ |
| Equity / fairness audit trail | — | ✓ |
| SSO (Entra / Google Workspace) | — | ✓ |
| Dedicated account contact | — | ✓ |
| Custom contract / DPA | — | ✓ |

### GTM motion

Top-down. The pitch is to RH or dirección médica, not the jefe de
servicio. The triggers that get the meeting:

1. The hospital noticed Trivu is already running in 2–3 services
   informally → RH wants it "officialised" so they have a single
   contract, single invoice, and visibility into what each service
   is doing.
2. A compliance scare (inspection, complaint, fine) → RH wants the
   convenio compliance dashboard as a risk-reduction tool.
3. Annual budget cycle for "tools used by clinicians" → enterprise
   software is a normal line item.

What they buy is the **data layer**. Without it, "hospital pays
3 × €25 self-serve = €75/mo" is identical to self-serve totals
and there's no reason to formalise. The platform fee covers the
enterprise-only features the hospital RH cares about that no jefe
would.

## Data layer

What we can derive from the scheduling data that justifies the
hospital platform fee. Ranked by **realism × value** — i.e., what
moves a procurement decision and is reasonable for us to actually
build.

### 1. Convenio compliance dashboard ★★★

Spanish public healthcare has hard legal caps from the convenio
colectivo + the EU Working Time Directive. Examples:

- Residente R1: max 4 guardias/mes
- Min 12h rest between shifts
- Max 48h/week averaged over 4 months
- Max 7 consecutive workdays

The hospital RH has **no easy way today** to verify that the
schedules built by each service comply. They find out when a
clinician files a grievance or an inspector shows up. We sit on
all the data — flagging breaches in real time is mechanical.

What it looks like:

- Real-time list of current breaches across all services
- Per-person + per-categoría thresholds (configurable; ships
  with Spanish defaults)
- Solver hard-constraint mode: "no breaches allowed" vs
  warning-only (admin choice per rule)
- Monthly compliance report PDF, signed timestamp, AEAT-compliant
  format → hospital legal department gets exactly what they need
  at audit time
- Per-service compliance status on a hospital dashboard so RH can
  see who needs attention

Standalone justifies a meaningful chunk of the platform fee. The
legal-risk reduction is concrete and quantifiable.

### 2. Cross-service workload analytics ★★★

Once a hospital has ≥2 services on Trivu, the hospital sees what
no single jefe can:

- Avg guardias / FTE / mes by service
- Baja médica rate by service (often a leading indicator of
  burnout or management issues)
- Overtime hours by service (budgeting input)
- Coverage gaps when bloqueos cluster across services
  (vacaciones / formación overlap)
- Schedule-publication lead time by service (how late do jefes
  publish?)

The aggregation is trivial code. The value is being the **only
source** of cross-service operational data. The hospital can't
get this from their HIS, their HR system, or their payroll system
— those don't know about turnos at the grain we do.

### 3. Headcount planning ★★

"Based on the last 6 months of schedules, your service needs +1.3
FTE adjuntos to keep guardias at convenio-compliant levels without
overtime."

A budget-conversation tool for jefes negotiating with gerencia,
and a justification tool for RH approving headcount requests.
Each hospital hire is €60–90k/yr — getting the count right
matters.

Less critical than #1 / #2 but a strong "show this in a sales
demo" feature.

### 4. Equity / fairness audit trail ★★

Every assignment Trivu makes carries a reason (rule that fired,
equity weight, etc.). Surface that as a per-person report: "Tú
has hecho 5 guardias en mayo. Trivu intentó asignar 4. La 5ª
salió por X."

When a clinician complains the schedule is unfair, the jefe
shows them the audit trail. Reduces internal conflict, defends
against discrimination claims. RH cares because grievances cost
HR time and reputational risk.

### 5. Burnout / overload early warning ★

Cumulative-load scoring (hours + nights + weekend density +
recent bajas) → flag individuals trending toward a likely burnout
window. Simple version: rolling 8-week hours percentile within
the service.

Useful but harder to validate. False positives are expensive —
you don't want to tell every busy adjunto they're burning out.
Lower priority than #1 in the first release.

### Skip for v1

- **Cross-tenant benchmarking** (anonymised "your service does X
  vs avg Y"). Legally sensitive — Spanish hospitals will want
  explicit data-sharing consent, and the data is health-adjacent.
  Defer.
- **AI insights / "smart recommendations"**. Buzzwordy without
  specifics. Don't build until we have a concrete recommendation
  type customers ask for.

## Phasing

Don't build the data layer or the enterprise tier before we have
paying self-serve tenants. The order of operations matters —
each phase informs the next.

### Phase 1: self-serve (Stripe integration)

1–2 weeks. Ship the self-serve tiers as described above. No data
layer, no enterprise SKU yet. Goal: get the billing plumbing real
and convert the first 3–5 tenants. See "Implementation chunks"
section above for the ordered checklist.

### Phase 2: convenio compliance as a premium feature

Build #1 (convenio compliance dashboard). Available to self-serve
admins as a **paid add-on** (e.g., +€15/mo per tenant). Included
in enterprise.

Reasoning: even a single-service admin gets real value from
compliance flags. Premium pricing tests the willingness-to-pay
signal before we commit to the full enterprise build.

### Phase 3: cross-service analytics + enterprise launch

Only when at least one hospital has 2+ services on self-serve AND
expressed interest in a hospital-wide deal. Build #2 (cross-
service analytics), SSO, account-management surface. Now the
enterprise SKU is real — sell it.

### Phase 4: data layer expansion

Iterate on the data layer based on what enterprise customers
actually ask for. Don't pre-build features unless someone has
asked for them by name.

## Open questions (enterprise)

To be revisited when we enter Phase 3:

- Final pricing: per-service fee + platform fee numbers, or all-in
  per-bed pricing?
- DPA template — needs to comply with RGPD + LOPDGDD. Lawyer
  drafts before first enterprise close.
- SSO: build native (SAML / OIDC) or use a third-party (WorkOS,
  Auth0)? Third-party is faster but eats margin.
- Data residency: do we commit to EU-only Postgres replica?
  Bigger hospitals will ask.
- Multi-tenant data isolation guarantees: RGPD-grade. Already
  enforced by FORCE ROW LEVEL SECURITY but needs an auditable
  story we can hand to a CISO.

## When to build

**Greenlit.** Next session starts with Implementation chunk #1
(Stripe setup) and #2 (migration 0080). Chunks 3–16 follow in
order. Goal: ship self-serve billing end-to-end before opening
the doors past the alpha pilots.

# Billing plan — Trivu

Pricing + monetisation reference. Source of truth for when we
start building the Stripe integration. Not yet implemented in
code.

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

Two SKUs. Two payer types.

| Who pays | What | €/mo | Annual (2 mo free) |
|---|---|---|---|
| **Tenant** (admin / hospital) | Admin tooling: solver, rules, planning, PDF export, stats, sub-equipos, swap admin view. Includes the admin's own app access. Includes app access for every residente. | **€25** | **€250/yr** |
| **Individual adjunto** (optional, per person) | Their own app access: mobile schedule view, push notifications, swap requests, bloqueo requests | **€5** | **€50/yr** |
| Residente (any sub-equipo member) | App access included. Cannot opt in or out; included by virtue of being in a sub-equipo. | **€0** | — |
| Admin | App access included in the tenant fee | — | — |

**Trial**: 30 days on the tenant subscription. No card upfront.
Subscription created with Stripe `trial_period_days=30` at signup.

**Pendientes** (invited members who haven't activated): counted as
scheduled members — the solver picks them up like any other
Membership. They consume no individual subscription seat by default;
if/when they activate as an adjunto and want app access, they can
subscribe themselves like any other adjunto.

**Disabled memberships** (`disabled_at IS NOT NULL`): not billed,
treated as removed for app-access purposes.

## Who buys what

### The tenant subscription

- Bought by the admin on signup
- Self-serve via Stripe Checkout — corporate card, no procurement
  needed for amounts under ~€500/mo
- Single line item: `Trivu — Planificación` × 1
- Annual variant offers 2 months free (`€250/yr` price ID separate
  from the monthly one)

### The individual adjunto subscription

- Bought by each adjunto from `/me/billing`
- Stripe Checkout, personal or expense card
- Subscribers get the digital layer; non-subscribers fall back to
  reading the printed PDF the admin posts
- Cancels anytime via Stripe Customer Portal; no impact on the
  schedule

### Cross-tenant adjuntos

A Person who's a member of multiple tenants:
- Pays **one** individual subscription, follows them across all
  tenants
- The tenant subscription is per-tenant — if they belong to two
  paying tenants, each tenant pays its own €25/mo

## Why this shape

1. **Admin's value is independent of member adoption.** Tenant fee
   buys planning power. The solver, rules, equity, PDF export all
   work regardless of how many adjuntos pay for individual app
   access. Zero adjunto subscriptions → admin still gets full value
   for €25/mo.
2. **Adjuntos who don't pay return to the pre-Trivu baseline** —
   they read the printed PDF the admin posts, ask the admin for
   swaps in the hallway. The product still works for the team,
   they just lose the digital coordination layer.
3. **Residentes free, by design.** Charging residentes personally
   for employer-mandated tooling is culturally and legally murky in
   Spanish public healthcare. They're scheduled like anyone else;
   they just don't pay. Sub-equipo membership is the technical flag.
4. **Self-serve everywhere.** No sales team needed. Admin uses
   corporate Visa on Stripe Checkout. Adjunto uses personal card on
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

1–2 weeks total. Order matters; later items depend on earlier.

1. **Stripe setup** (external, not code)
   - Create Stripe account, enable Stripe Tax, set Spanish tax IDs
   - Create 4 Prices: tenant monthly €25, tenant annual €250,
     adjunto monthly €5, adjunto annual €50
   - Set the webhook signing secret in the production env

2. **Migration**: `tenant_subscriptions`
   ```
   tenant_id (PK, FK tenants),
   stripe_customer_id, stripe_subscription_id,
   status, current_period_end, trial_ends_at,
   cancel_at_period_end, plan_interval ('month' | 'year'),
   created_at, updated_at
   ```

3. **Migration**: `person_subscriptions` (individual adjunto subs)
   ```
   person_id (PK, FK persons),
   stripe_customer_id, stripe_subscription_id,
   status, current_period_end,
   cancel_at_period_end, plan_interval,
   created_at, updated_at
   ```

4. **Migration**: `billing_events` (webhook idempotency + debugging)
   ```
   id, stripe_event_id (unique), event_type,
   payload_json, received_at, processed_at, error
   ```

5. **Helpers**
   - `has_member_app_access(person, tenant_id) -> bool`:
     - true if `roles` includes `admin` for this tenant
     - true if `Membership.group_id IS NOT NULL` for this tenant
       (sub-equipo / residente)
     - true if `person_subscriptions.status IN ('trialing', 'active')`
     - else false → PDF-only
   - `tenant_has_active_subscription(tenant_id) -> bool`

6. **Webhook**: `POST /api/billing/webhook`
   - Verify signature against `STRIPE_WEBHOOK_SECRET`
   - Idempotent via `billing_events.stripe_event_id` unique
   - Handle: `customer.subscription.{updated,deleted,trial_will_end}`,
     `invoice.{paid,payment_failed}`
   - Branches on whether the subscription belongs to a tenant or a
     person via custom metadata on the Stripe subscription

7. **Signup hook**: every new tenant signup creates a Stripe Customer
   + tenant subscription with `trial_period_days=30`. No card
   collected at this point.

8. **`/admin/billing` page**
   - Plan summary, trial countdown, current period end
   - "Gestionar pago" button → Stripe Customer Portal (one-click,
     no form rendering on our side)
   - Seat breakdown for context (X adjuntos paying app-access, Y
     pendientes, Z residentes free)

9. **`/me/billing` page**
   - Adjunto-only (admins + residentes see "incluido en tu plan")
   - "Activar acceso a la app — €5/mes" button → Stripe Checkout
   - If already subscribed: "Gestionar suscripción" → Customer Portal

10. **App-access gate middleware**
    - On any non-PDF, non-essential endpoint: enforce
      `has_member_app_access`
    - 402 with `detail: "app_access_required"`
    - Frontend intercepts and shows the upgrade prompt

11. **Past-due gating middleware**
    - On any mutation route while the tenant subscription is in
      `past_due` (>7d) / `unpaid` / `canceled`: 402 with
      `detail: "tenant_subscription_unpaid"`

12. **CLAUDE.md addendum**
    - Document Stripe keys, webhook secret, test card numbers,
      how to replay a webhook locally

## Open questions (self-serve)

None for the model itself. Build-time decisions deferred to
implementation:

- Exact text of the trial-ending email (template + 7-day-out timing)
- Exact text of the past-due banner in /admin and /me shells
- Whether to expose annual upgrade as a one-click action or require
  a portal visit
- Whether to add `/admin/billing/invoices` (mirror of what the
  Customer Portal already shows) or just deep-link to the portal

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

Per the user's call: **plan only for now, don't build**. Re-open
this doc when (a) we have at least one tenant interested in
paying self-serve, or (b) we've finished the rest of the
post-signup polish.

# Billing plan — Trivu

Pricing + monetisation reference. Source of truth for when we
start building the Stripe integration. Not yet implemented in
code.

## Pricing

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

## Open questions

None for the model itself. Build-time decisions deferred to
implementation:

- Exact text of the trial-ending email (template + 7-day-out timing)
- Exact text of the past-due banner in /admin and /me shells
- Whether to expose annual upgrade as a one-click action or require
  a portal visit
- Whether to add `/admin/billing/invoices` (mirror of what the
  Customer Portal already shows) or just deep-link to the portal

## When to build

Per the user's call: **plan only for now, don't build**. Re-open
this doc when (a) we have at least one tenant interested in paying,
or (b) we've finished the rest of the post-signup polish.

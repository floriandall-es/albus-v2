"""Billing domain logic (migration 0080).

This module holds the pure decision logic the rest of the codebase
needs to check billing state — without depending on Stripe.

Three things live here today:

  - `has_app_access(person, tenant)` — can this Person log into
    the app for THIS tenant? Routes through whichever
    `billing_model` the tenant uses.

  - `trial_horizon_end(today)` — the last date a trial admin is
    allowed to plan up to. Today + 2 calendar months (inclusive).

  - `can_generate_for(tenant, target_date, today=None)` — the
    guard called by the three planning-generation endpoints.
    Returns (False, reason) for blocked cases so the route can
    422/403 with a user-facing message.

What's NOT here: Stripe API calls (those live in
`app.services.stripe_client`), seat reconciliation (that lives in
`app.services.subscription_reconciler` — to be written), webhook
dispatch (`app.routes.stripe_webhook`).

The helpers are deliberately stateless — every input comes via
arguments — so they're trivial to unit-test without a DB.

See docs/billing-plan.md, chunks 4 / 5 / 6.
"""

from __future__ import annotations

import calendar
from datetime import date

from app.models import Person, Tenant


# Statuses that confer access. `trialing` and `active` are the
# happy paths; `past_due` is the 7-day grace window before the
# hard gate kicks in. `unpaid` and `canceled` are the no-access
# end states. `never_subscribed` means the Person opted out at
# invite-time (or pre-billing) — also no access.
_ACTIVE_STATUSES: frozenset[str] = frozenset({"trialing", "active", "past_due"})


def has_app_access(person: Person, tenant: Tenant) -> bool:
    """Can this Person open the app in this Tenant?

    Under `team_pays` the answer is the tenant's subscription
    status — the admin is paying for everyone. Under `members_pay`
    each Person pays for themselves and the answer is the person's
    own subscription status.

    Read-only views (already-published planning) bypass this check
    via dedicated endpoints; this gate covers the active-use
    surfaces (logging in, requesting swaps, viewing live updates,
    etc.). See `require_active_subscription` in `routes/deps.py`
    (to be added) for the call site.
    """
    if tenant.billing_model == "team_pays":
        return (tenant.subscription_status or "") in _ACTIVE_STATUSES
    # members_pay
    return person.subscription_status in _ACTIVE_STATUSES


def trial_horizon_end(today: date) -> date:
    """The last date a trial admin is allowed to plan up to.

    Today + 2 calendar months, inclusive of the entire end month.
    If today is 2026-05-28, the horizon ends 2026-07-31. A periodo
    or schedule with `end_date > 2026-07-31` is rejected for a
    trialing admin.

    Doesn't depend on `tenant` — every trial gets the same window.
    Called by `can_generate_for`.
    """
    # We want the last day of the month that's `today.month + 2`.
    y, m = today.year, today.month + 2
    # Roll into next year if we overflow December.
    while m > 12:
        m -= 12
        y += 1
    last_day = calendar.monthrange(y, m)[1]
    return date(y, m, last_day)


def can_generate_for(
    tenant: Tenant,
    target_date: date,
    *,
    today: date | None = None,
) -> tuple[bool, str | None]:
    """Decide whether the tenant can generate planning that ends on
    `target_date`. Used by the three generate endpoints:

      - POST /api/schedules                       (target = period last day)
      - POST /api/schedules/{id}/generate         (same)
      - POST /api/periodos/{id}/generate          (target = periodo.end_date)

    Returns `(True, None)` when allowed, `(False, reason)` when
    blocked. The reason is a Spanish user-facing string — the
    route hands it straight back as the 403 detail.

    Hard gates (no generation at all):
      - `unpaid` / `canceled` subscription
      - `None` subscription_status (shouldn't happen post-migration,
        but defensive — treats unknown as blocked)

    Trial gate (limited horizon):
      - `trialing` subscription + target beyond `trial_horizon_end`

    Otherwise allowed.
    """
    today = today or date.today()
    s = tenant.subscription_status

    if s in (None, "canceled", "unpaid"):
        return (
            False,
            "Tu suscripción no está activa. Reactívala para generar "
            "nuevas planificaciones.",
        )

    if s == "trialing":
        horizon = trial_horizon_end(today)
        if target_date > horizon:
            return (
                False,
                f"Durante la prueba sólo puedes planificar hasta "
                f"{_format_es_month_year(horizon)}. Suscríbete para "
                f"planificar todo el año.",
            )

    # 'active' or 'past_due' (within the 7-day grace window — the
    # hard-gate transition to 'unpaid' is what stops us) → unlimited
    # horizon.
    return True, None


def _format_es_month_year(d: date) -> str:
    """'julio 2026' — Spanish month + year, lowercased. Inline so
    `can_generate_for` doesn't reach into a frontend i18n module."""
    months_es = (
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    )
    return f"{months_es[d.month - 1]} de {d.year}"

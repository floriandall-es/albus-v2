"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * Persistent billing-state banner shown across /admin and /me.
 *
 * The same component covers four trigger states (chunk 11 of
 * docs/billing-plan.md):
 *
 *   1. Trial countdown      — starts 9 days before trial_end_at,
 *                              i.e. only the last week + change.
 *   2. Past-due payment     — amber, shown until the next attempt
 *                              succeeds OR the sub flips to unpaid.
 *   3. Lapsed (unpaid)      — red, hard read-only banner.
 *   4. Cancelled            — red, "Reactiva tu suscripción" CTA.
 *
 * For admins we read the TENANT subscription status; for members
 * (anyone without the admin role) we read the PERSON status under
 * members_pay, or fall back to the tenant status under team_pays.
 * Grandfathered tenants (alpha pilots) carry trial_end_at =
 * 2099-12-31 — the countdown logic naturally short-circuits long
 * before that, so they never see the banner.
 *
 * Banner self-hides until /me resolves so we never flash a stale
 * "your trial is ending" between page transitions.
 */
export function BillingBanner() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (!me.data) return null;

  const tenant = me.data.current_tenant;
  const person = me.data.person;
  const isAdmin = me.data.memberships.some((m) => m.roles.includes("admin"));

  // Pick the right subscription state for this user in this
  // tenant. Admins always look at the tenant sub; non-admins
  // look at their own sub under members_pay and the tenant sub
  // under team_pays (since under team_pays the admin's payment
  // gates everyone's access).
  const status: string | null = isAdmin || tenant.billing_model === "team_pays"
    ? tenant.subscription_status
    : person.subscription_status;
  // Trial end date for the chosen subscription. Same selection
  // logic as `status` above.
  const trialEndAt: string | null = isAdmin
    || tenant.billing_model === "team_pays"
    ? tenant.trial_end_at
    : person.trial_end_at;

  // Friendlier URL for whichever view this user lives in. Admins
  // get /admin/billing, members get /me/billing.
  const billingHref = isAdmin ? "/admin/billing" : "/me/billing";

  // ── Trial countdown ─────────────────────────────────────────
  // Only fires when status==='trialing'. Hidden until the last 9
  // days so we don't badger trial admins for the first three weeks.
  if (status === "trialing" && trialEndAt) {
    const ms = new Date(trialEndAt).getTime() - Date.now();
    const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
    // Grandfathered far-future dates: skip entirely. Anything
    // beyond 60 days is by definition not a real trial we want
    // to nag about.
    if (days > 60) return null;
    if (days > 9) return null;
    return (
      <BannerShell tone="info">
        <span className="font-medium">
          {days <= 0
            ? "Tu prueba ha terminado."
            : days === 1
              ? "Te queda 1 día de prueba."
              : `Te quedan ${days} días de prueba.`}
        </span>{" "}
        <Link
          href={billingHref}
          className="font-medium underline hover:no-underline"
        >
          Activa tu suscripción →
        </Link>
      </BannerShell>
    );
  }

  if (status === "past_due") {
    return (
      <BannerShell tone="warning">
        <span className="font-medium">El último cobro ha fallado.</span>{" "}
        <Link
          href={billingHref}
          className="font-medium underline hover:no-underline"
        >
          Actualiza tu método de pago →
        </Link>
      </BannerShell>
    );
  }

  if (status === "unpaid") {
    return (
      <BannerShell tone="danger">
        <span className="font-medium">Tu suscripción está sin pagar.</span>{" "}
        <Link
          href={billingHref}
          className="font-medium underline hover:no-underline"
        >
          Reactívala →
        </Link>
      </BannerShell>
    );
  }

  if (status === "canceled") {
    return (
      <BannerShell tone="danger">
        <span className="font-medium">Tu suscripción está cancelada.</span>{" "}
        <Link
          href={billingHref}
          className="font-medium underline hover:no-underline"
        >
          Reactívala →
        </Link>
      </BannerShell>
    );
  }

  return null;
}

function BannerShell({
  tone,
  children,
}: {
  tone: "info" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const cls = {
    info: "border-brand-200 bg-brand-50 text-brand-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-rose-200 bg-rose-50 text-rose-900",
  }[tone];
  return (
    <div className={`border-b ${cls} px-6 py-2 text-sm`}>
      {children}
    </div>
  );
}

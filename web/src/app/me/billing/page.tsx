"use client";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";

/** /me/billing — chunk 10 of docs/billing-plan.md.
 *
 * Branches by `tenant_billing_model`:
 *
 *   team_pays    → single "Tu equipo paga tu suscripción" card.
 *                  No actionable buttons.
 *   members_pay  → status + trial countdown + Portal launcher,
 *                  same shape as /admin/billing but personal.
 *
 * Stripe-side work goes through /api/billing/me + /api/billing/me/portal.
 * This page never calls Stripe directly. */
export default function MeBillingPage() {
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const justActivated = searchParams.get("activated") === "1";
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  // The admin's app access is bundled into the tenant subscription
  // they manage from /admin/billing — exposing the personal
  // Activar flow here would create a second sub on top of the
  // tenant one (double-charge).
  const currentMembership = me.data?.memberships.find(
    (m) => m.tenant_id === me.data?.current_tenant.id,
  );
  const isAdminHere = (currentMembership?.roles ?? []).includes("admin");
  const billing = useQuery({
    queryKey: ["my-billing"],
    queryFn: api.getMyBilling,
  });
  const openPortal = useMutation({
    mutationFn: () => api.openMyBillingPortal(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });
  const activate = useMutation({
    mutationFn: () => api.activateMyBilling(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  // After Stripe redirects back with ?activated=1, the webhook
  // may take a couple of seconds to flip our DB row. Re-fetch
  // every 2s for ~10s so the page transitions from "trialing"
  // → "active" without the user having to refresh.
  useEffect(() => {
    if (!justActivated) return;
    qc.invalidateQueries({ queryKey: ["my-billing"] });
    const id = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["my-billing"] });
    }, 2000);
    const stop = setTimeout(() => clearInterval(id), 10_000);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [justActivated, qc]);

  const trialDaysLeft = useMemo(() => {
    if (
      billing.data?.subscription_status !== "trialing"
      || !billing.data?.trial_end_at
    ) {
      return null;
    }
    const ms = new Date(billing.data.trial_end_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }, [billing.data]);

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-brand-600" />
            Facturación
          </span>
        }
      />

      {billing.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}

      {justActivated && (
        <div className="mb-6 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <strong>Suscripción activada.</strong> Gracias por confiar en
          Trivu — verás el estado actualizado en unos segundos.
        </div>
      )}

      {billing.data && (
        <div className="space-y-6">
          {/* Admin shortcut: their app access is bundled into the
              tenant subscription (price_admin), so they never need
              the personal Activar flow. Send them to /admin/billing
              and short-circuit the rest of this page. */}
          {isAdminHere && (
            <Card>
              <div className="p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                  Tu acceso está incluido en la suscripción del servicio
                </h2>
                <p className="mt-2 text-sm text-gray-600">
                  Como administrador del servicio, tu acceso a la app está
                  cubierto por la suscripción del equipo. Gestiona tarjeta,
                  facturas y modelo de cobro desde Facturación admin.
                </p>
                <div className="mt-4">
                  <a
                    href="/admin/billing"
                    className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                  >
                    Ir a Facturación admin →
                  </a>
                </div>
              </div>
            </Card>
          )}

          {/* Team_pays: short courtesy card and nothing else. */}
          {!isAdminHere
            && billing.data.tenant_billing_model === "team_pays" && (
            <Card>
              <div className="p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                  Tu equipo paga tu suscripción
                </h2>
                <p className="mt-2 text-sm text-gray-600">
                  No tienes que hacer nada. El admin de tu equipo cubre el
                  acceso a la app para todos los miembros. Cuando el admin
                  decida cambiar a «Cada persona paga su acceso», recibirás
                  un correo con 30 días para activar la tuya.
                </p>
              </div>
            </Card>
          )}

          {/* Members_pay: the full personal billing flow.
              Skipped for admins via the !isAdminHere guard so we
              never expose a second Activar button on top of the
              tenant sub. */}
          {!isAdminHere
            && billing.data.tenant_billing_model === "members_pay" && (
            <>
              <Card>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-semibold text-gray-900">
                        Tu suscripción
                      </h2>
                      <p className="mt-1 text-xs text-gray-500">
                        {billing.data.subscription_status === "active"
                          ? "4,90 €/mes. Cancela cuando quieras desde el portal."
                          : "4,90 €/mes cuando actives la suscripción."}
                      </p>
                    </div>
                    <MyStatusBadge status={billing.data.subscription_status} />
                  </div>

                  {billing.data.subscription_status === "trialing"
                    && trialDaysLeft !== null && (
                      <div className="mt-4 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-800">
                        Te quedan <strong>{trialDaysLeft} días</strong> de
                        prueba gratis. Tras la prueba, activa la suscripción
                        para seguir usando la app — no se cobra nada
                        automáticamente.
                      </div>
                    )}
                  {billing.data.subscription_status === "past_due" && (
                    <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      El último cobro ha fallado. Actualiza tu tarjeta para
                      mantener el acceso.
                    </div>
                  )}
                  {billing.data.subscription_status === "canceled" && (
                    <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
                      Tu suscripción está cancelada. Reactívala para volver a
                      ver tus turnos en la app.
                    </div>
                  )}
                  {billing.data.subscription_status === "never_subscribed" && (
                    <div className="mt-4 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-700">
                      Todavía no has activado el acceso a la app. Pídele a tu
                      admin que te reenvíe la invitación si quieres probarla
                      durante 30 días gratis.
                    </div>
                  )}
                </div>
              </Card>

              {/* Two states sharing a card slot:
                  - No Stripe Customer yet → primary CTA is "Activar
                    suscripción" (sends to Checkout).
                  - Has a Customer → primary CTA is the Portal
                    launcher (card / invoices / cancel from
                    Stripe-hosted page). */}
              {!billing.data.has_stripe_customer && (
                <Card>
                  <div className="p-5">
                    <h2 className="text-sm font-semibold text-gray-900">
                      Activar suscripción
                    </h2>
                    <p className="mt-1 text-xs text-gray-500">
                      Te llevamos a Stripe para introducir la tarjeta. Si
                      todavía tienes días de prueba, los respetamos —
                      empezarás a pagar cuando acabe la prueba.
                    </p>
                    <div className="mt-4 flex items-center gap-3">
                      <Button
                        onClick={() => activate.mutate()}
                        disabled={activate.isPending}
                      >
                        <Sparkles className="h-4 w-4" />
                        {activate.isPending
                          ? "Abriendo…"
                          : "Activar suscripción"}
                      </Button>
                    </div>
                    {activate.isError && (
                      <p className="mt-2 text-xs text-rose-700">
                        {(activate.error as Error).message}
                      </p>
                    )}
                  </div>
                </Card>
              )}

              {billing.data.has_stripe_customer && (
                <Card>
                  <div className="p-5">
                    <h2 className="text-sm font-semibold text-gray-900">
                      Método de pago y facturas
                    </h2>
                    <p className="mt-1 text-xs text-gray-500">
                      Se abre el portal de Stripe con tu tarjeta, facturas e
                      información fiscal.
                    </p>
                    <div className="mt-4 flex items-center gap-3">
                      <Button
                        onClick={() => openPortal.mutate()}
                        disabled={openPortal.isPending}
                      >
                        <ExternalLink className="h-4 w-4" />
                        {openPortal.isPending
                          ? "Abriendo…"
                          : "Gestionar facturación"}
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MyStatusBadge({
  status,
}: {
  status: string;
}) {
  switch (status) {
    case "trialing":
      return <StatusPill tone="info">En prueba</StatusPill>;
    case "active":
      return <StatusPill tone="success">Activa</StatusPill>;
    case "past_due":
      return <StatusPill tone="warning">Pago atrasado</StatusPill>;
    case "canceled":
      return <StatusPill tone="danger">Cancelada</StatusPill>;
    default:
      return <StatusPill tone="neutral">Sin activar</StatusPill>;
  }
}

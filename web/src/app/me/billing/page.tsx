"use client";
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, ExternalLink } from "lucide-react";
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

      {billing.data && (
        <div className="space-y-6">
          {/* Team_pays: short courtesy card and nothing else. */}
          {billing.data.tenant_billing_model === "team_pays" && (
            <Card>
              <div className="p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                  Tu equipo paga tu suscripción
                </h2>
                <p className="mt-2 text-sm text-gray-600">
                  No tienes que hacer nada. El admin de tu equipo cubre el
                  acceso a la app para todos los miembros. Cuando el admin
                  decida cambiar a «Cada miembro decide», recibirás un correo
                  con 30 días para activar la tuya.
                </p>
              </div>
            </Card>
          )}

          {/* Members_pay: the full personal billing flow. */}
          {billing.data.tenant_billing_model === "members_pay" && (
            <>
              <Card>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-semibold text-gray-900">
                        Tu suscripción
                      </h2>
                      <p className="mt-1 text-xs text-gray-500">
                        4,90 €/mes. Cancela cuando quieras desde el portal.
                      </p>
                    </div>
                    <MyStatusBadge status={billing.data.subscription_status} />
                  </div>

                  {billing.data.subscription_status === "trialing"
                    && trialDaysLeft !== null && (
                      <div className="mt-4 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-800">
                        Te quedan <strong>{trialDaysLeft} días</strong> de
                        prueba gratis. Tras la prueba se renueva
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
                      disabled={
                        !billing.data.has_stripe_customer
                        || openPortal.isPending
                      }
                    >
                      <ExternalLink className="h-4 w-4" />
                      {openPortal.isPending
                        ? "Abriendo…"
                        : "Gestionar facturación"}
                    </Button>
                    {!billing.data.has_stripe_customer && (
                      <span className="text-xs text-gray-500">
                        Disponible cuando actives tu prueba.
                      </span>
                    )}
                  </div>
                </div>
              </Card>
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

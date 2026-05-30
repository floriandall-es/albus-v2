"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";

/** /admin/billing — chunk 9 of docs/billing-plan.md.
 *
 * One page, four cards:
 *   1. Estado de la suscripción      (status + trial countdown)
 *   2. Modelo de facturación          (members_pay ↔ team_pays toggle)
 *   3. Asientos                       (seat breakdown)
 *   4. Facturación + facturas         (Stripe Portal launcher)
 *
 * The page is admin-only (the layout already gates that). Stripe-
 * side actions (Portal redirect, plan switch confirmation) round-
 * trip through /api/billing/* — this page never talks to Stripe
 * directly. */
export default function AdminBillingPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const summary = useQuery({
    queryKey: ["billing-summary"],
    queryFn: api.getBillingSummary,
  });

  // The model toggle persists on every click so a reload mid-edit
  // doesn't lose the pick. Confirmation modal lives in this same
  // file — only shown when moving FROM team_pays TO members_pay,
  // because that direction kicks the team off shared coverage and
  // requires each member to subscribe themselves.
  const [confirmSwitch, setConfirmSwitch] = useState<
    "members_pay" | "team_pays" | null
  >(null);

  const setModel = useMutation({
    mutationFn: (m: "members_pay" | "team_pays") =>
      api.updateBillingModel(m),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-summary"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      setConfirmSwitch(null);
    },
  });

  const openPortal = useMutation({
    mutationFn: () => api.openBillingPortal(),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  const tenant = me.data?.current_tenant;
  const billingModel = summary.data?.billing_model ?? tenant?.billing_model;
  const status = summary.data?.subscription_status ?? tenant?.subscription_status;
  const trialEnd = summary.data?.trial_end_at ?? tenant?.trial_end_at;

  // Days remaining on the trial — null when not trialing. Decimals
  // are rounded UP so day-29 reads as "1 día restante" rather than
  // "0", which would look like the trial had already ended.
  const trialDaysLeft = useMemo(() => {
    if (status !== "trialing" || !trialEnd) return null;
    const ms = new Date(trialEnd).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  }, [status, trialEnd]);

  const pickModel = (m: "members_pay" | "team_pays") => {
    if (m === billingModel) return;
    // Going team_pays → members_pay is the disruptive direction:
    // everyone who currently has access via the team sub will get
    // a 30-day grace period to start their own. Confirm first.
    if (billingModel === "team_pays" && m === "members_pay") {
      setConfirmSwitch(m);
      return;
    }
    setModel.mutate(m);
  };

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

      <div className="space-y-6">
        {/* ---------- 1. Estado de la suscripción ---------- */}
        <Card>
          <div className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  Estado de la suscripción
                </h2>
                <p className="mt-1 text-xs text-gray-500">
                  {status === "active"
                    ? (billingModel === "team_pays"
                      ? "Tu equipo paga una sola factura para todos."
                      : "Tu equipo paga 29,90 €/mes. Cada miembro decide si quiere activar su acceso al móvil por 4,90 €/mes.")
                    : (billingModel === "team_pays"
                      ? "Cuando actives la suscripción, pagarás una sola factura para todo el equipo (29,90 € + 4,90 €/miembro/mes)."
                      : "Cuando actives la suscripción, pagarás 29,90 €/mes. Cada miembro decide si quiere activar su acceso al móvil por 4,90 €/mes.")}
                </p>
              </div>
              <StatusBadge status={status} />
            </div>

            {status === "trialing" && trialDaysLeft !== null && (
              <div className="mt-4 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-800">
                Te quedan <strong>{trialDaysLeft} días</strong> de prueba
                gratis{trialEnd && (
                  <> (hasta el {new Date(trialEnd).toLocaleDateString("es-ES", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })})</>
                )}. Tras la prueba, activa la suscripción para seguir
                usando la app — no se cobra nada automáticamente.
              </div>
            )}
            {status === "past_due" && (
              <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                El último cobro ha fallado. Actualiza tu método de pago para
                evitar perder acceso.
              </div>
            )}
            {(status === "canceled" || status === "unpaid") && (
              <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
                Tu suscripción no está activa. Reactívala para seguir
                planificando.
              </div>
            )}
          </div>
        </Card>

        {/* ---------- 2. Modelo de facturación ---------- */}
        <Card>
          <div className="p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              Modelo de facturación
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Cambia cuando quieras. La transición da 30 días de gracia a los
              miembros afectados.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <ModelOption
                selected={billingModel === "members_pay"}
                onSelect={() => pickModel("members_pay")}
                title="Cada persona paga su acceso"
                price="Admin 29,90 €/mes · Miembro 4,90 €/mes"
                body="Tú pagas tu cuenta. Cada miembro decide si quiere activar su acceso y paga su propia suscripción."
                badge="Más flexible"
              />
              <ModelOption
                selected={billingModel === "team_pays"}
                onSelect={() => pickModel("team_pays")}
                title="El administrador paga todo el equipo"
                price="Admin 29,90 €/mes · Miembro 4,90 €/mes"
                body="Una única factura. El administrador asume el coste de todos los miembros y estos tienen acceso automáticamente."
                badge="Una factura"
              />
            </div>
            {setModel.isError && (
              <p className="mt-2 text-xs text-rose-600">
                No se ha podido cambiar el modelo. Inténtalo de nuevo.
              </p>
            )}
          </div>
        </Card>

        {/* ---------- 3. Asientos ---------- */}
        <Card>
          <div className="p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              Asientos en tu equipo
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              {billingModel === "team_pays"
                ? "Pagas por cada miembro activo. Las suscripciones individuales no aplican."
                : "Cada miembro decide si activa su acceso al móvil. Tú no pagas por nadie más."}
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SeatStat
                label="Total"
                value={summary.data?.seats_total ?? 0}
              />
              <SeatStat
                label="Activos"
                value={summary.data?.seats_subscribed ?? 0}
                tone="success"
              />
              <SeatStat
                label="En prueba"
                value={summary.data?.seats_trialing ?? 0}
                tone="info"
              />
              <SeatStat
                label="En papel"
                value={summary.data?.seats_paper ?? 0}
                tone="neutral"
              />
            </dl>
          </div>
        </Card>

        {/* ---------- 4. Facturación + portal ---------- */}
        <Card>
          <div className="p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              Método de pago y facturas
            </h2>
            <p className="mt-1 text-xs text-gray-500">
              Se abre el portal de Stripe en una pestaña nueva con tu tarjeta,
              historial de facturas y dirección fiscal.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Button
                onClick={() => openPortal.mutate()}
                disabled={
                  !summary.data?.has_stripe_customer || openPortal.isPending
                }
              >
                <ExternalLink className="h-4 w-4" />
                {openPortal.isPending ? "Abriendo…" : "Gestionar facturación"}
              </Button>
              {!summary.data?.has_stripe_customer && (
                <span className="text-xs text-gray-500">
                  Disponible cuando actives la suscripción.
                </span>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* ---------- Confirmation modal for team→members switch ---------- */}
      {confirmSwitch && (
        <ConfirmSwitchModal
          onCancel={() => setConfirmSwitch(null)}
          onConfirm={() => setModel.mutate(confirmSwitch)}
          pending={setModel.isPending}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents — kept inline because nothing else uses them.
// ---------------------------------------------------------------------------

function StatusBadge({
  status,
}: {
  status: string | null | undefined;
}) {
  switch (status) {
    case "trialing":
      return <StatusPill tone="info">En prueba</StatusPill>;
    case "active":
      return <StatusPill tone="success">Activa</StatusPill>;
    case "past_due":
      return <StatusPill tone="warning">Pago atrasado</StatusPill>;
    case "unpaid":
      return <StatusPill tone="danger">Sin pagar</StatusPill>;
    case "canceled":
      return <StatusPill tone="danger">Cancelada</StatusPill>;
    default:
      // Grandfathered alpha pilots have a non-null 'active' status
      // via migration 0081; this branch covers tenants that have
      // never engaged with billing at all (shouldn't happen post-
      // migration but be defensive — show "Sin configurar").
      return <StatusPill tone="neutral">Sin configurar</StatusPill>;
  }
}

function ModelOption({
  selected,
  onSelect,
  title,
  price,
  body,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  price: string;
  body: string;
  badge: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        "text-left rounded-md border p-3 transition-colors "
        + (selected
          ? "border-brand-500 ring-2 ring-brand-500/30 bg-brand-50/40"
          : "border-gray-200 hover:bg-gray-50")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        <span
          className={
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider "
            + (selected
              ? "bg-brand-600 text-white"
              : "bg-gray-100 text-gray-600")
          }
        >
          {badge}
        </span>
      </div>
      <div className="mt-1 text-xs font-medium text-gray-700">{price}</div>
      <p className="mt-2 text-xs leading-snug text-gray-600">{body}</p>
    </button>
  );
}

function SeatStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "success" | "info";
}) {
  const colour = {
    neutral: "text-gray-900",
    success: "text-emerald-700",
    info: "text-sky-700",
  }[tone];
  return (
    <div className="rounded-md bg-gray-50 px-3 py-2 ring-1 ring-gray-200">
      <dt className="text-[11px] uppercase tracking-wider text-gray-500">
        {label}
      </dt>
      <dd className={`mt-1 text-lg font-semibold tabular-nums ${colour}`}>
        {value}
      </dd>
    </div>
  );
}

function ConfirmSwitchModal({
  onCancel,
  onConfirm,
  pending,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-gray-900">
          Cambiar a «Cada persona paga su acceso»
        </h3>
        <p className="mt-2 text-sm text-gray-600">
          Tu equipo ya no tendrá la suscripción cubierta. Cada miembro
          recibirá un correo para activar la suya con 30 días de prueba
          gratis. Quien no la active seguirá apareciendo en tu
          planificación pero no podrá abrir la app.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? "Cambiando…" : "Cambiar de todas formas"}
          </Button>
        </div>
      </div>
    </div>
  );
}

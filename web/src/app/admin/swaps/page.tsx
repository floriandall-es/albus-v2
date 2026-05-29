"use client";
import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeftRight, Check, X } from "lucide-react";
import {
  api,
  type SwapAssignmentSummary,
  type SwapOffer,
  type SwapResponse,
  type SwapVetoScope,
} from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";

export default function AdminSwapsPage() {
  const q = useQuery({
    queryKey: ["admin-swaps"],
    queryFn: api.adminListSwaps,
  });

  // Migration 0084. Split the offer list into "needs admin action
  // now" vs the historical audit log. Pending-admin offers float
  // to the top in their own section with approve / veto buttons;
  // everything else falls into the read-only table below.
  const pendingAdmin = useMemo(
    () => (q.data ?? []).filter((o) => o.status === "pending_admin"),
    [q.data],
  );
  const history = useMemo(
    () => (q.data ?? []).filter((o) => o.status !== "pending_admin"),
    [q.data],
  );

  return (
    <>
      <PageHeader title="Cambios de turno" />
      <p className="mb-4 text-sm text-gray-600">
        Los miembros del equipo gestionan los cambios entre ellos. Activa
        la aprobación obligatoria si quieres revisar cada cambio antes de
        que se aplique. Si necesitas revertir una asignación, ábrela desde
        la planificación correspondiente.
      </p>

      <div className="mb-4">
        <ApprovalToggleCard />
      </div>
      <div className="mb-6">
        <SwapLimitCard />
      </div>

      {q.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {q.isError && <ErrorText>{(q.error as Error).message}</ErrorText>}

      {pendingAdmin.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-700">
            Esperan tu aprobación
          </h2>
          <div className="space-y-3">
            {pendingAdmin.map((o) => (
              <PendingAdminCard key={o.id} offer={o} />
            ))}
          </div>
        </section>
      )}

      {q.data && q.data.length === 0 && (
        <EmptyState
          icon={<ArrowLeftRight className="h-5 w-5" />}
          title="Aún no hay cambios de turno"
          description="Cuando los miembros del equipo intercambien turnos, aparecerán aquí."
        />
      )}
      {history.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Solicitante</th>
                <th className="px-4 py-2 font-medium">Turno</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Resuelto con</th>
                <th className="px-4 py-2 font-medium">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {history.map((o: SwapOffer) => {
                const accepted = o.responses.find(
                  (r) => r.status === "accepted",
                );
                return (
                  <tr key={o.id} className="border-b last:border-b-0 align-top">
                    <td className="px-4 py-2">{o.requested_by_person_name}</td>
                    <td className="px-4 py-2">
                      <div>{shiftLabel(o.assignment)}</div>
                      {o.notes && (
                        <div className="mt-0.5 text-xs text-gray-500">
                          {o.notes}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={o.status} />
                      {/* Migration 0084. Audit row for offers that
                          went through the admin-approval flow —
                          shows who decided and when, plus any veto
                          note. */}
                      {o.admin_decided_at && (
                        <div className="mt-1 text-[11px] text-gray-500">
                          {o.status === "vetoed" ? "Denegado" : "Aprobado"}{" "}
                          por{" "}
                          <span className="font-medium text-gray-700">
                            {o.admin_decided_by_person_name ?? "admin"}
                          </span>
                          {o.admin_decision_notes && (
                            <div className="text-gray-500">
                              “{o.admin_decision_notes}”
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-700">
                      {accepted ? (
                        <>
                          <div className="font-medium text-gray-900">
                            {accepted.responder_person_name}
                          </div>
                          <div className="text-gray-600">
                            {accepted.kind === "cover"
                              ? "cubrió el turno"
                              : "cambió"}
                            {accepted.kind === "swap"
                            && accepted.swap_assignment && (
                              <>
                                {" "}por{" "}
                                <span className="font-medium text-gray-900">
                                  {shiftLabel(accepted.swap_assignment)}
                                </span>
                              </>
                            )}
                          </div>
                        </>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      <div>
                        {new Date(o.created_at).toLocaleDateString()}
                      </div>
                      {o.closed_at && (
                        <div className="text-gray-400">
                          → {new Date(o.closed_at).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function shiftLabel(a: SwapAssignmentSummary): string {
  const d = a.date;
  const wd = new Date(d).getUTCDay();
  const day = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd];
  return `${day} ${d.slice(8, 10)}/${d.slice(5, 7)} · ${a.slot_name}`;
}

function StatusBadge({ status }: { status: string }) {
  const tone = (
    {
      open: "warning",
      pending_admin: "warning",
      fulfilled: "success",
      cancelled: "neutral",
      vetoed: "danger",
    } as const
  )[status] ?? "neutral";
  const label: Record<string, string> = {
    open: "Abierta",
    pending_admin: "Esperando admin",
    fulfilled: "Cumplida",
    cancelled: "Cancelada",
    vetoed: "Denegada",
  };
  return <StatusPill tone={tone}>{label[status] ?? status}</StatusPill>;
}

/** Per-tenant cap on cambios per member per monthly schedule.
 * Reads the current limit from /api/me (Tenant.max_swaps_per_member_per_month),
 * lets the admin set or clear it via PATCH /api/tenants/me. Empty input =
 * unlimited; integer >= 0 = the cap. */
function SwapLimitCard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const current = me.data?.current_tenant.max_swaps_per_member_per_month ?? null;
  const [value, setValue] = useState<string>(
    current === null ? "" : String(current),
  );
  // Sync local state when the source value changes (e.g. after a save).
  useEffect(() => {
    setValue(current === null ? "" : String(current));
  }, [current]);

  const save = useMutation({
    mutationFn: (next: number | null) =>
      api.updateTenantDefaults({ max_swaps_per_member_per_month: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const parsed = value.trim() === "" ? null : Number(value);
  const isValid =
    parsed === null
    || (Number.isInteger(parsed) && parsed >= 0);
  const dirty = parsed !== current;

  return (
    <Card>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-gray-900">
              Límite de cambios por mes y persona
            </h3>
            <p className="mt-0.5 text-xs text-gray-500 max-w-xl">
              Tope opcional. Cada cambio cumplido cuenta sólo para
              quien lo pidió, dentro del mes del turno original —
              cubrir un turno ajeno no resta cuota a quien ayuda.
              Déjalo en blanco para no limitar.
            </p>
          </div>
          <span
            className={
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium "
              + (current === null
                ? "bg-gray-100 text-gray-700"
                : "bg-brand-100 text-brand-700")
            }
          >
            {current === null
              ? "Sin límite"
              : `${current} ${current === 1 ? "cambio" : "cambios"} / mes`}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs font-medium text-gray-700">
              Máximo de cambios por mes
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Sin límite"
              className="mt-1 block w-32 rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
          </label>
          <Button
            onClick={() => save.mutate(parsed)}
            disabled={!isValid || !dirty || save.isPending}
          >
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
          {current !== null && (
            <button
              type="button"
              onClick={() => save.mutate(null)}
              disabled={save.isPending}
              className="text-xs text-gray-600 hover:underline disabled:opacity-50"
            >
              Quitar límite
            </button>
          )}
        </div>
        {!isValid && (
          <p className="mt-1 text-xs text-rose-700">
            Introduce un entero ≥ 0 o deja el campo vacío.
          </p>
        )}
        {save.isError && (
          <p className="mt-1 text-xs text-rose-700">
            {(save.error as Error).message}
          </p>
        )}
      </div>
    </Card>
  );
}

/** Migration 0084. Tenant-level toggle: should every cambio go
 * through admin approval before it applies? Off by default — the
 * legacy "requester decision is final" flow keeps working
 * unchanged. Flipping it on doesn't touch existing offers; the
 * flag is read at the moment the requester clicks Aceptar. */
function ApprovalToggleCard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const current = me.data?.current_tenant.swap_requires_admin_approval ?? false;
  const save = useMutation({
    mutationFn: (next: boolean) =>
      api.updateTenantDefaults({ swap_requires_admin_approval: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["admin-swaps"] });
      qc.invalidateQueries({ queryKey: ["admin-pendientes"] });
    },
  });

  return (
    <Card>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-gray-900">
              Aprobación de cambios por admin
            </h3>
            <p className="mt-0.5 text-xs text-gray-500 max-w-xl">
              Si lo activas, cuando un miembro acepte la respuesta a su
              solicitud, el cambio queda en espera hasta que un admin lo
              apruebe. Sin marcar, el cambio se aplica al instante (es el
              comportamiento por defecto).
            </p>
          </div>
          <span
            className={
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium "
              + (current
                ? "bg-amber-100 text-amber-800"
                : "bg-gray-100 text-gray-700")
            }
          >
            {current ? "Activada" : "Desactivada"}
          </span>
        </div>
        <div className="mt-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              checked={current}
              onChange={(e) => save.mutate(e.target.checked)}
              disabled={save.isPending || me.isLoading}
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            Requerir aprobación del admin antes de aplicar un cambio
          </label>
        </div>
        {save.isError && (
          <p className="mt-1 text-xs text-rose-700">
            {(save.error as Error).message}
          </p>
        )}
      </div>
    </Card>
  );
}

/** Migration 0084. One pending-admin offer rendered as a card the
 * admin can approve or veto. Lists every still-pending response on
 * the offer — admins can also approve a different one if the
 * staged response no longer makes sense (the staged one shows up
 * as "Esperando admin" / amber, siblings show "Pendiente"). */
function PendingAdminCard({ offer }: { offer: SwapOffer }) {
  const qc = useQueryClient();
  const [vetoFor, setVetoFor] = useState<number | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-swaps"] });
    qc.invalidateQueries({ queryKey: ["admin-pendientes"] });
  };

  const approve = useMutation({
    mutationFn: (responseId: number) =>
      api.adminApproveSwapResponse(offer.id, responseId),
    onSuccess: invalidate,
  });
  const veto = useMutation({
    mutationFn: (args: {
      responseId: number;
      scope: SwapVetoScope;
      notes: string | null;
    }) =>
      api.adminVetoSwapResponse(offer.id, args.responseId, {
        scope: args.scope,
        notes: args.notes,
      }),
    onSuccess: () => {
      invalidate();
      setVetoFor(null);
    },
  });

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            {offer.requested_by_person_name} · {shiftLabel(offer.assignment)}
          </div>
          {offer.notes && (
            <div className="mt-0.5 text-xs text-gray-600">{offer.notes}</div>
          )}
        </div>
        <StatusBadge status={offer.status} />
      </div>

      <ul className="mt-3 space-y-2 border-t border-amber-200 pt-3">
        {offer.responses
          .filter(
            (r) => r.status === "pending_admin" || r.status === "pending",
          )
          .map((r) => (
            <li key={r.id} className="text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">
                    {r.responder_person_name}{" "}
                    <span className="font-normal text-gray-600">
                      {r.kind === "cover"
                        ? "se ofrece a cubrir"
                        : "propone cambio"}
                    </span>
                  </div>
                  {r.kind === "swap" && r.swap_assignment && (
                    <div className="text-xs text-gray-600">
                      Por:{" "}
                      <span className="font-medium text-gray-800">
                        {shiftLabel(r.swap_assignment)}
                      </span>
                    </div>
                  )}
                  {r.notes && (
                    <div className="mt-0.5 text-xs text-gray-500">
                      {r.notes}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.status === "pending_admin" ? (
                    <StatusPill tone="warning">Esperando admin</StatusPill>
                  ) : (
                    <StatusPill tone="neutral">Pendiente</StatusPill>
                  )}
                  {/* Approve / veto only for the response the
                      requester actually picked. Siblings are read-
                      only here; if the admin wants a different
                      colleague to cover, they should veto with
                      scope=response_only and let the requester
                      re-pick. */}
                  {r.status === "pending_admin" && (
                    <>
                      <button
                        type="button"
                        onClick={() => approve.mutate(r.id)}
                        disabled={approve.isPending || veto.isPending}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Aprobar
                      </button>
                      <button
                        type="button"
                        onClick={() => setVetoFor(r.id)}
                        disabled={approve.isPending || veto.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                        Denegar
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
      </ul>

      {approve.isError && (
        <p className="mt-2 text-xs text-rose-700">
          {(approve.error as Error).message}
        </p>
      )}

      {vetoFor !== null && (
        <VetoForm
          response={offer.responses.find((r) => r.id === vetoFor)!}
          onCancel={() => setVetoFor(null)}
          onSubmit={(scope, notes) =>
            veto.mutate({ responseId: vetoFor, scope, notes })
          }
          isPending={veto.isPending}
          error={veto.error as Error | null}
        />
      )}
    </div>
  );
}

/** Inline veto form: pick scope (response_only / entire_offer) and
 * optionally explain. The note is mailed to the requester and the
 * affected responder so they know why. */
function VetoForm({
  response,
  onCancel,
  onSubmit,
  isPending,
  error,
}: {
  response: SwapResponse;
  onCancel: () => void;
  onSubmit: (scope: SwapVetoScope, notes: string | null) => void;
  isPending: boolean;
  error: Error | null;
}) {
  const [scope, setScope] = useState<SwapVetoScope>("response_only");
  const [notes, setNotes] = useState("");
  return (
    <div className="mt-3 rounded-md border border-rose-200 bg-rose-50/40 p-3">
      <div className="mb-2 text-xs font-semibold text-rose-800">
        Denegar la propuesta de {response.responder_person_name}
      </div>
      <fieldset className="space-y-1.5 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="veto-scope"
            checked={scope === "response_only"}
            onChange={() => setScope("response_only")}
            className="mt-1"
          />
          <span>
            <span className="font-medium">
              Sólo esta respuesta
            </span>{" "}
            <span className="text-gray-600">
              — la solicitud sigue abierta y el solicitante puede aceptar
              otra.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="veto-scope"
            checked={scope === "entire_offer"}
            onChange={() => setScope("entire_offer")}
            className="mt-1"
          />
          <span>
            <span className="font-medium">
              Toda la solicitud
            </span>{" "}
            <span className="text-gray-600">
              — se cierra el cambio para todos los respondedores.
            </span>
          </span>
        </label>
      </fieldset>
      <label className="mt-2 block">
        <span className="text-xs font-medium text-gray-700">
          Motivo (opcional, se envía por email a las personas afectadas)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
      </label>
      {error && (
        <p className="mt-1 text-xs text-rose-700">{error.message}</p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => onSubmit(scope, notes.trim() || null)}
          disabled={isPending}
          className="rounded-md bg-rose-700 px-2 py-1 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-50"
        >
          {isPending ? "Enviando…" : "Confirmar denegación"}
        </button>
      </div>
    </div>
  );
}

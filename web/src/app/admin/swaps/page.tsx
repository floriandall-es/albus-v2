"use client";
import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import {
  api,
  type SwapAssignmentSummary,
  type SwapOffer,
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

  return (
    <>
      <PageHeader title="Cambios de turno" />
      <p className="mb-4 text-sm text-gray-600">
        Histórico informativo: los miembros del equipo gestionan los cambios
        entre ellos. Si necesitas revertir una asignación, ábrela desde la
        planificación correspondiente.
      </p>

      <div className="mb-6">
        <SwapLimitCard />
      </div>
      {q.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {q.isError && <ErrorText>{(q.error as Error).message}</ErrorText>}
      {q.data && q.data.length === 0 && (
        <EmptyState
          icon={<ArrowLeftRight className="h-5 w-5" />}
          title="Aún no hay cambios de turno"
          description="Cuando los miembros del equipo intercambien turnos, aparecerán aquí."
        />
      )}
      {q.data && q.data.length > 0 && (
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
              {q.data.map((o: SwapOffer) => {
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
      fulfilled: "success",
      cancelled: "neutral",
    } as const
  )[status] ?? "neutral";
  const label: Record<string, string> = {
    open: "Abierta",
    fulfilled: "Cumplida",
    cancelled: "Cancelada",
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

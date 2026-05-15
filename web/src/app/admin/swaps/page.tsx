"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import {
  api,
  type SwapAssignmentSummary,
  type SwapOffer,
} from "@/lib/api";
import {
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

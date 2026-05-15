"use client";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";
import { PlanningGrid } from "@/components/schedule/planning-grid";
import { formatPeriod } from "@/components/admin/month-picker";
import { EmptyState } from "@/components/admin/ui";
import { CalendarDays } from "lucide-react";

export default function TurnosPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });

  // Team members only see PUBLISHED schedules. Drafts are admin-only —
  // assignments can still change at that stage.
  const publishedSchedules = useMemo(() => {
    if (!schedules.data) return [];
    return schedules.data.filter((s) => s.status === "published");
  }, [schedules.data]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [swapTarget, setSwapTarget] = useState<Assignment | null>(null);
  useEffect(() => {
    if (selectedId !== null) return;
    if (publishedSchedules.length === 0) return;
    setSelectedId(publishedSchedules[0].id);
  }, [publishedSchedules, selectedId]);

  const detail = useQuery({
    queryKey: ["schedule", selectedId],
    queryFn: () => api.getSchedule(selectedId!),
    enabled: selectedId !== null,
  });

  const holidays = useQuery({
    queryKey: ["holidays-detail", detail.data?.period],
    queryFn: () =>
      api.listHolidays(new Date(detail.data!.period).getFullYear()),
    enabled: !!detail.data,
  });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  if (me.isLoading || schedules.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (me.isError) {
    return (
      <p className="text-sm text-red-600">{(me.error as Error).message}</p>
    );
  }
  if (!me.data) return null;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Planificación</h1>
        {publishedSchedules.length > 0 && (
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            {publishedSchedules.map((s) => (
              <option key={s.id} value={s.id}>
                {formatPeriod(s.period)}
              </option>
            ))}
          </select>
        )}
      </div>

      {publishedSchedules.length === 0 && (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title="Aún no hay planificación publicada"
          description="Cuando el responsable publique un mes, lo verás aquí."
        />
      )}

      {selectedId !== null && detail.isLoading && (
        <p className="text-sm text-gray-500">Cargando planificación…</p>
      )}
      {selectedId !== null && detail.data && (
        <>
          <p className="mb-4 text-xs text-gray-500">
            Tus turnos están resaltados en azul. Haz clic en uno para
            pedir cobertura.
          </p>
          <PlanningGrid
            assignments={detail.data.assignments}
            holidayDates={holidayDates}
            highlightPersonId={me.data.person.id}
            onCellClick={(a) => setSwapTarget(a)}
            cellIsClickable={(a) =>
              a.person_id === me.data!.person.id && !a.locked_at
            }
            teamMembers={team.data}
          />
        </>
      )}

      {swapTarget && (
        <RequestCoverageModal
          assignment={swapTarget}
          onClose={() => setSwapTarget(null)}
        />
      )}
    </>
  );
}

function RequestCoverageModal({
  assignment,
  onClose,
}: {
  assignment: Assignment;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      api.createSwapOffer({
        assignment_id: assignment.id,
        notes: notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swap-offers"] });
      onClose();
    },
  });

  const wd = new Date(assignment.date).getUTCDay();
  const dayLabel = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd];
  const dateLabel = `${dayLabel} ${assignment.date.slice(8, 10)}/${assignment.date.slice(5, 7)}/${assignment.date.slice(0, 4)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Pedir cobertura</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <div className="rounded-md bg-gray-50 p-3 text-sm">
            <div className="text-xs text-gray-500">Turno a cubrir</div>
            <div className="font-medium">
              {dateLabel} · {assignment.slot_name}
              {assignment.team_role_label && (
                <span className="text-gray-500">
                  {" "}· {assignment.team_role_label}
                </span>
              )}
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Nota (opcional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Por qué necesitas cobertura, preferencias de cambio, etc."
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          {submit.isError && (
            <p className="text-sm text-red-700">
              {(submit.error as Error).message}
            </p>
          )}

          <p className="text-xs text-gray-500">
            Los demás miembros del equipo recibirán un email y podrán
            ofrecerse a cubrirlo o proponer un cambio.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submit.isPending}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submit.isPending ? "Enviando…" : "Pedir cobertura"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

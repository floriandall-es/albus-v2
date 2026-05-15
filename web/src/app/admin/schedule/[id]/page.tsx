"use client";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";
import {
  Button,
  Card,
  ErrorText,
  Modal,
} from "@/components/admin/ui";
import { PlanningGrid } from "@/components/schedule/planning-grid";
import { formatPeriod } from "@/components/admin/month-picker";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

export default function ScheduleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = Number(params.id);
  const [editing, setEditing] = useState<Assignment | null>(null);

  const detail = useQuery({
    queryKey: ["schedule", id],
    queryFn: () => api.getSchedule(id),
    enabled: !Number.isNaN(id),
  });
  const holidays = useQuery({
    queryKey: ["holidays-detail", detail.data?.period],
    queryFn: () =>
      api.listHolidays(new Date(detail.data!.period).getFullYear()),
    enabled: !!detail.data,
  });

  const publish = useMutation({
    mutationFn: () => api.publishSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", id] }),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", id] }),
  });
  const unarchive = useMutation({
    mutationFn: () => api.unarchiveSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", id] });
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => api.generateSchedule(detail.data!.period),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace(`/admin/schedule/${data.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace("/admin/schedule");
    },
  });

  const absences = useQuery({
    queryKey: ["team-absences", detail.data?.period],
    queryFn: () => {
      const period = detail.data!.period;
      // Bound the query to the schedule's month (a year fits in the
      // browser cache anyway, but this keeps the payload tight).
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const from = `${period.slice(0, 7)}-01`;
      const to = `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
      return api.listTeamAbsences({ from, to });
    },
    enabled: !!detail.data,
  });

  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  if (detail.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (detail.isError || !detail.data) {
    return <ErrorText>{(detail.error as Error)?.message ?? "Error"}</ErrorText>;
  }

  const s = detail.data;
  const isEditable = s.status === "draft";
  // Surface mutation errors that until now were swallowed silently
  // (e.g. unarchive failing → button briefly disables, nothing else).
  // First non-null wins; refreshing detail.data implicitly clears the
  // visible error after a successful retry.
  const actionError =
    (publish.error as Error | null)
    ?? (archive.error as Error | null)
    ?? (unarchive.error as Error | null)
    ?? (regenerate.error as Error | null)
    ?? (remove.error as Error | null);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{`Planificación · ${formatPeriod(s.period)}`}</h1>
        <div className="flex gap-2">
          {s.status === "draft" && (
            <>
              <Button
                variant="secondary"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
              >
                Regenerar
              </Button>
              <Button
                onClick={() => publish.mutate()}
                disabled={publish.isPending}
              >
                Publicar
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    confirm(
                      `¿Eliminar el borrador de ${formatPeriod(s.period)}? Esta acción no se puede deshacer.`,
                    )
                  ) {
                    remove.mutate();
                  }
                }}
                disabled={remove.isPending}
              >
                Eliminar
              </Button>
            </>
          )}
          {s.status === "published" && (
            <Button
              variant="secondary"
              onClick={() => archive.mutate()}
              disabled={archive.isPending}
            >
              Archivar
            </Button>
          )}
          {s.status === "archived" && (
            <Button
              variant="secondary"
              onClick={() => unarchive.mutate()}
              disabled={unarchive.isPending}
            >
              {unarchive.isPending ? "Desarchivando…" : "Desarchivar"}
            </Button>
          )}
        </div>
      </div>
      {actionError && (
        <div className="mb-3">
          <ErrorText>{actionError.message}</ErrorText>
        </div>
      )}
      <p className="mb-4 text-sm text-gray-600">
        Estado: <span className="font-medium">{STATUS_LABEL[s.status]}</span>
        {s.solver_used && (
          <span
            className={
              "ml-3 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide "
              + (s.solver_used === "cpsat"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-800 border border-amber-200")
            }
            title={
              s.solver_used === "cpsat"
                ? "CP-SAT: solver óptimo con equidad, descansos y reglas cruzadas aplicadas."
                : "Greedy: respaldo round-robin. CP-SAT no encontró solución factible — equidad y restricciones suaves no se aplicaron."
            }
          >
            {s.solver_used === "cpsat" ? "CP-SAT" : "Greedy (respaldo)"}
          </span>
        )}
        {isEditable && (
          <span className="ml-3 text-xs text-gray-500">
            (haz clic en una celda para editarla)
          </span>
        )}
      </p>

      <PlanningGrid
        assignments={s.assignments}
        holidayDates={holidayDates}
        onCellClick={isEditable ? (a) => setEditing(a) : undefined}
        absences={absences.data}
      />

      <BalanceStats
        assignments={s.assignments}
        holidayDates={holidayDates}
      />

      {editing && (
        <AssignmentEditModal
          assignment={editing}
          scheduleId={id}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}


function AssignmentEditModal({
  assignment,
  scheduleId,
  onClose,
}: {
  assignment: Assignment;
  scheduleId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [selectedPid, setSelectedPid] = useState<number | "">(
    assignment.person_id ?? "",
  );

  const eligible = useQuery({
    queryKey: ["eligible", scheduleId, assignment.id],
    queryFn: () => api.listEligiblePersons(scheduleId, assignment.id),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["schedule", scheduleId] });

  const save = useMutation({
    mutationFn: () =>
      api.patchAssignment(scheduleId, assignment.id, {
        person_id: selectedPid === "" ? null : Number(selectedPid),
        clear_person: selectedPid === "",
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const clear = useMutation({
    mutationFn: () =>
      api.patchAssignment(scheduleId, assignment.id, { clear_person: true }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const lock = useMutation({
    mutationFn: () =>
      assignment.locked_at
        ? api.unlockAssignment(scheduleId, assignment.id)
        : api.lockAssignment(scheduleId, assignment.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Asignar a ${assignment.slot_name} (${assignment.date})`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Persona</span>
          <select
            value={String(selectedPid)}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedPid(v === "" ? "" : Number(v));
            }}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
          >
            <option value="">— Sin cubrir —</option>
            {(eligible.data ?? []).map((p) => (
              <option key={p.person_id} value={String(p.person_id)}>
                {p.person_name}
              </option>
            ))}
          </select>
        </label>
        {eligible.isLoading && (
          <p className="text-xs text-gray-500">Cargando elegibles…</p>
        )}
        {eligible.data && eligible.data.length === 0 && (
          <p className="text-xs text-amber-700">
            Nadie cumple los requisitos para este slot/fecha.
          </p>
        )}
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => lock.mutate()}
              disabled={lock.isPending}
            >
              {assignment.locked_at ? "Desbloquear" : "Bloquear"}
            </Button>
            <Button
              variant="danger"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
            >
              Vaciar
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Asignar"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Balance stats: per-person counts of slot assignments. Lets the admin see
// at a glance whether the schedule is fairly distributed. Min/max highlighted
// per column so outliers stand out.
// ---------------------------------------------------------------------------

function BalanceStats({
  assignments,
  holidayDates,
}: {
  assignments: Assignment[];
  holidayDates: Set<string>;
}) {
  const stats = useMemo(() => {
    // (slot_name, person_id) -> count, plus per-row totals + weekend/holiday
    const persons = new Map<number, string>();
    const slotNames = new Set<string>();
    const counts = new Map<string, Map<number, number>>(); // slot -> pid -> n
    const weByPerson = new Map<number, number>();         // pid -> we/holiday count
    for (const a of assignments) {
      if (a.person_id === null || a.person_name === null) continue;
      persons.set(a.person_id, a.person_name);
      slotNames.add(a.slot_name);
      let row = counts.get(a.slot_name);
      if (!row) {
        row = new Map();
        counts.set(a.slot_name, row);
      }
      row.set(a.person_id, (row.get(a.person_id) ?? 0) + 1);
      const wd = new Date(a.date).getUTCDay();
      if (wd === 0 || wd === 6 || holidayDates.has(a.date)) {
        weByPerson.set(a.person_id, (weByPerson.get(a.person_id) ?? 0) + 1);
      }
    }
    const personsSorted = Array.from(persons.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
    const slotNamesSorted = Array.from(slotNames).sort();

    // Per-slot (row) min/max across persons for highlighting.
    const minMaxBySlot = new Map<string, { min: number; max: number }>();
    for (const slot of slotNamesSorted) {
      const row = counts.get(slot)!;
      let mn = Infinity;
      let mx = -Infinity;
      for (const [pid] of personsSorted) {
        const v = row.get(pid) ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      minMaxBySlot.set(slot, { min: mn, max: mx });
    }

    // Per-person totals + min/max across persons.
    const totalByPerson = new Map<number, number>();
    for (const [pid] of personsSorted) {
      let s = 0;
      for (const slot of slotNamesSorted) {
        s += counts.get(slot)?.get(pid) ?? 0;
      }
      totalByPerson.set(pid, s);
    }
    let totalMin = Infinity;
    let totalMax = -Infinity;
    for (const v of totalByPerson.values()) {
      if (v < totalMin) totalMin = v;
      if (v > totalMax) totalMax = v;
    }
    let weMin = Infinity;
    let weMax = -Infinity;
    for (const [pid] of personsSorted) {
      const v = weByPerson.get(pid) ?? 0;
      if (v < weMin) weMin = v;
      if (v > weMax) weMax = v;
    }
    return {
      personsSorted,
      slotNamesSorted,
      counts,
      minMaxBySlot,
      totalByPerson,
      totalMin,
      totalMax,
      weByPerson,
      weMin,
      weMax,
    };
  }, [assignments, holidayDates]);

  if (stats.personsSorted.length === 0) return null;

  const cellClass = (
    v: number,
    mn: number,
    mx: number,
    differs: boolean,
  ) => {
    if (!differs) return "text-gray-700";
    if (v === mx && mx !== mn) return "text-rose-700 font-medium";
    if (v === mn && mx !== mn) return "text-emerald-700";
    return "text-gray-700";
  };

  return (
    <div className="mt-6 inline-block max-w-full overflow-x-auto">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">
        Reparto por persona
      </h2>
      <Card>
        <table className="text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 text-left">
            <tr className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2">Turno</th>
              {stats.personsSorted.map(([pid, name]) => (
                <th
                  key={pid}
                  className="px-3 py-2 text-right whitespace-nowrap normal-case font-medium text-gray-700 text-xs tracking-normal"
                >
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.slotNamesSorted.map((slot) => {
              const row = stats.counts.get(slot)!;
              const mm = stats.minMaxBySlot.get(slot)!;
              return (
                <tr key={slot} className="border-b">
                  <td className="px-3 py-2 whitespace-nowrap">{slot}</td>
                  {stats.personsSorted.map(([pid]) => {
                    const v = row.get(pid) ?? 0;
                    return (
                      <td
                        key={pid}
                        className={
                          "px-3 py-2 text-right "
                          + cellClass(v, mm.min, mm.max, mm.min !== mm.max)
                        }
                      >
                        {v || "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-b bg-gray-50">
              <td
                className="px-3 py-2 font-medium whitespace-nowrap"
                title="Asignaciones en sábado, domingo o festivo"
              >
                Fines de semana / festivos
              </td>
              {stats.personsSorted.map(([pid]) => {
                const v = stats.weByPerson.get(pid) ?? 0;
                return (
                  <td
                    key={pid}
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        v,
                        stats.weMin,
                        stats.weMax,
                        stats.weMin !== stats.weMax,
                      )
                    }
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
            <tr className="bg-gray-50 font-medium">
              <td className="px-3 py-2">Total</td>
              {stats.personsSorted.map(([pid]) => {
                const v = stats.totalByPerson.get(pid) ?? 0;
                return (
                  <td
                    key={pid}
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        v,
                        stats.totalMin,
                        stats.totalMax,
                        stats.totalMin !== stats.totalMax,
                      )
                    }
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </Card>
      <p className="mt-2 text-[11px] text-gray-500">
        <span className="text-rose-700">Rojo</span>: máximo de la fila ·{" "}
        <span className="text-emerald-700">verde</span>: mínimo. Diferencias
        grandes indican desbalance.
      </p>
    </div>
  );
}

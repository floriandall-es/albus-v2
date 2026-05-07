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

  const grid = useMemo(() => buildGrid(detail.data?.assignments ?? []), [
    detail.data,
  ]);
  const dates = grid.dates;
  const slotRows = grid.slotRows;
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
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{`Planificación · ${s.period}`}</h1>
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
                      `¿Eliminar el borrador de ${s.period}? Esta acción no se puede deshacer.`,
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
        </div>
      </div>
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

      <div className="overflow-x-auto">
        <Card>
          <table className="text-xs">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="sticky left-0 bg-gray-50 z-10 px-2 py-1 text-left font-medium border-r min-w-[160px]">
                  Slot
                </th>
                {dates.map((d) => {
                  const isHoliday = holidayDates.has(d);
                  const dt = new Date(d);
                  const wd = dt.getDay();
                  const isWeekend = wd === 0 || wd === 6;
                  return (
                    <th
                      key={d}
                      className={`px-1 py-1 font-medium text-center min-w-[80px] ${
                        isHoliday
                          ? "bg-amber-100 text-amber-900"
                          : isWeekend
                          ? "bg-gray-100 text-gray-600"
                          : ""
                      }`}
                    >
                      <div>{d.slice(8)}</div>
                      <div className="font-normal text-[10px]">
                        {["dom","lun","mar","mié","jue","vie","sáb"][wd]}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {slotRows.map((row) => (
                <tr key={row.slot_id} className="border-b last:border-b-0">
                  <td className="sticky left-0 bg-white z-10 px-2 py-1 border-r font-medium">
                    {row.display_name}
                  </td>
                  {dates.map((d) => {
                    const cell = row.cells[d] ?? [];
                    const empty =
                      cell.length === 0 || cell.every((a) => a.person_id === null);
                    return (
                      <td
                        key={d}
                        className={`align-top px-1 py-1 ${
                          empty ? "bg-red-50" : ""
                        }`}
                      >
                        {cell.length === 0 ? (
                          <span className="text-[10px] text-gray-400">—</span>
                        ) : (
                          cell.map((a) => (
                            <button
                              type="button"
                              key={a.id}
                              onClick={() => isEditable && setEditing(a)}
                              disabled={!isEditable}
                              className={`block w-full text-left leading-tight ${
                                a.person_id === null ? "text-red-700" : ""
                              } ${isEditable ? "hover:bg-blue-50 rounded cursor-pointer" : "cursor-default"}`}
                              title={a.notes ?? ""}
                            >
                              <span className="inline-flex items-center gap-1">
                                {a.locked_at && (
                                  <LockIcon className="h-3 w-3 text-amber-600" />
                                )}
                                {a.person_id === null ? (
                                  "Sin cubrir"
                                ) : (
                                  <>
                                    {a.person_name}
                                    {a.team_role_label && (
                                      <span className="text-gray-500">
                                        {" "}· {a.team_role_label}
                                      </span>
                                    )}
                                  </>
                                )}
                              </span>
                            </button>
                          ))
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

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

function buildGrid(assignments: Assignment[]) {
  const dates = Array.from(new Set(assignments.map((a) => a.date))).sort();
  const slotMap = new Map<
    number,
    {
      slot_id: number;
      slot_name: string;
      display_name: string;
      cells: Record<string, Assignment[]>;
    }
  >();
  for (const a of assignments) {
    let row = slotMap.get(a.slot_id);
    if (!row) {
      row = {
        slot_id: a.slot_id,
        slot_name: a.slot_name,
        display_name: a.slot_name,
        cells: {},
      };
      slotMap.set(a.slot_id, row);
    }
    if (!row.cells[a.date]) row.cells[a.date] = [];
    row.cells[a.date].push(a);
  }
  // Disambiguate same-named slots so the user can tell them apart.
  // (UNIQUE(tenant_id, lower(name)) is supposed to prevent this, but
  // historical data may still contain duplicates — show #id rather than
  // collapse them.)
  const nameCounts = new Map<string, number>();
  for (const row of slotMap.values()) {
    nameCounts.set(row.slot_name, (nameCounts.get(row.slot_name) ?? 0) + 1);
  }
  for (const row of slotMap.values()) {
    if ((nameCounts.get(row.slot_name) ?? 0) > 1) {
      row.display_name = `${row.slot_name} · #${row.slot_id}`;
    }
  }
  const slotRows = Array.from(slotMap.values()).sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );
  return { dates, slotRows };
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
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
    // person -> { total, weekend_holiday, perSlot: { name -> count } }
    const byPerson = new Map<
      number,
      {
        person_id: number;
        person_name: string;
        total: number;
        we_or_holiday: number;
        perSlot: Map<string, number>;
      }
    >();
    const slotNames = new Set<string>();
    for (const a of assignments) {
      if (a.person_id === null || a.person_name === null) continue;
      slotNames.add(a.slot_name);
      let row = byPerson.get(a.person_id);
      if (!row) {
        row = {
          person_id: a.person_id,
          person_name: a.person_name,
          total: 0,
          we_or_holiday: 0,
          perSlot: new Map(),
        };
        byPerson.set(a.person_id, row);
      }
      row.total += 1;
      const wd = new Date(a.date).getUTCDay(); // 0=Sun..6=Sat
      if (wd === 0 || wd === 6 || holidayDates.has(a.date)) {
        row.we_or_holiday += 1;
      }
      row.perSlot.set(a.slot_name, (row.perSlot.get(a.slot_name) ?? 0) + 1);
    }
    const rows = Array.from(byPerson.values()).sort((a, b) =>
      a.person_name.localeCompare(b.person_name),
    );
    const slotNamesSorted = Array.from(slotNames).sort();

    // Per-slot min/max for highlighting outliers.
    const minMaxBySlot = new Map<string, { min: number; max: number }>();
    for (const name of slotNamesSorted) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const r of rows) {
        const v = r.perSlot.get(name) ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      minMaxBySlot.set(name, { min: mn, max: mx });
    }
    let totalMin = Infinity;
    let totalMax = -Infinity;
    let weMin = Infinity;
    let weMax = -Infinity;
    for (const r of rows) {
      if (r.total < totalMin) totalMin = r.total;
      if (r.total > totalMax) totalMax = r.total;
      if (r.we_or_holiday < weMin) weMin = r.we_or_holiday;
      if (r.we_or_holiday > weMax) weMax = r.we_or_holiday;
    }
    return {
      rows,
      slotNamesSorted,
      minMaxBySlot,
      totalMin,
      totalMax,
      weMin,
      weMax,
    };
  }, [assignments, holidayDates]);

  if (stats.rows.length === 0) return null;

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
    <div className="mt-6">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">
        Reparto por persona
      </h2>
      <div className="overflow-x-auto">
        <Card>
          <table className="w-full text-xs">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-3 py-2 font-medium">Persona</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
                <th
                  className="px-3 py-2 font-medium text-right"
                  title="Asignaciones en sábado, domingo o festivo"
                >
                  Fines de semana / festivos
                </th>
                {stats.slotNamesSorted.map((name) => (
                  <th
                    key={name}
                    className="px-3 py-2 font-medium text-right"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((r) => (
                <tr key={r.person_id} className="border-b last:border-b-0">
                  <td className="px-3 py-2">{r.person_name}</td>
                  <td
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        r.total,
                        stats.totalMin,
                        stats.totalMax,
                        stats.totalMin !== stats.totalMax,
                      )
                    }
                  >
                    {r.total}
                  </td>
                  <td
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        r.we_or_holiday,
                        stats.weMin,
                        stats.weMax,
                        stats.weMin !== stats.weMax,
                      )
                    }
                  >
                    {r.we_or_holiday}
                  </td>
                  {stats.slotNamesSorted.map((name) => {
                    const v = r.perSlot.get(name) ?? 0;
                    const mm = stats.minMaxBySlot.get(name)!;
                    return (
                      <td
                        key={name}
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
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        <span className="text-rose-700">Rojo</span>: máximo de la columna ·{" "}
        <span className="text-emerald-700">verde</span>: mínimo. Diferencias
        grandes pueden indicar desbalance — revisa reglas o asignaciones
        manuales.
      </p>
    </div>
  );
}

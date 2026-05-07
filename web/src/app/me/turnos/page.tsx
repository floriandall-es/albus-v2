"use client";
import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

export default function TurnosPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });

  // Show non-archived schedules first; default-select the most recent
  // published one if any, otherwise the most recent (excluding archived).
  const visibleSchedules = useMemo(() => {
    if (!schedules.data) return [];
    return schedules.data.filter((s) => s.status !== "archived");
  }, [schedules.data]);

  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    if (selectedId !== null) return;
    if (visibleSchedules.length === 0) return;
    const published = visibleSchedules.find((s) => s.status === "published");
    setSelectedId((published ?? visibleSchedules[0]).id);
  }, [visibleSchedules, selectedId]);

  const detail = useQuery({
    queryKey: ["schedule", selectedId],
    queryFn: () => api.getSchedule(selectedId!),
    enabled: selectedId !== null,
  });

  if (me.isLoading || schedules.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (me.isError) {
    return (
      <p className="text-sm text-red-600">{(me.error as Error).message}</p>
    );
  }
  if (!me.data) return null;

  const myPersonId = me.data.person.id;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Mis turnos</h1>
        {visibleSchedules.length > 0 && (
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            {visibleSchedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.period} · {STATUS_LABEL[s.status] ?? s.status}
              </option>
            ))}
          </select>
        )}
      </div>

      {visibleSchedules.length === 0 && (
        <p className="text-sm text-gray-500">
          Aún no hay planificaciones disponibles.
        </p>
      )}

      {selectedId !== null && detail.isLoading && (
        <p className="text-sm text-gray-500">Cargando planificación…</p>
      )}
      {selectedId !== null && detail.data && (
        <MyAssignments
          assignments={detail.data.assignments.filter(
            (a) => a.person_id === myPersonId,
          )}
          period={detail.data.period}
          status={detail.data.status}
        />
      )}
    </>
  );
}

function MyAssignments({
  assignments,
  period,
  status,
}: {
  assignments: Array<{
    date: string;
    slot_name: string;
    team_role_label: string | null;
    notes: string | null;
  }>;
  period: string;
  status: string;
}) {
  const sorted = useMemo(
    () =>
      [...assignments].sort(
        (a, b) => a.date.localeCompare(b.date) || a.slot_name.localeCompare(b.slot_name),
      ),
    [assignments],
  );

  // Group by date so multiple slots on the same day stack visually.
  const byDate = useMemo(() => {
    const m = new Map<string, typeof sorted>();
    for (const a of sorted) {
      const arr = m.get(a.date);
      if (arr) arr.push(a);
      else m.set(a.date, [a]);
    }
    return Array.from(m.entries());
  }, [sorted]);

  if (status === "draft") {
    return (
      <div className="max-w-2xl space-y-3">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Esta planificación todavía está en borrador — puede cambiar antes
          de publicarse.
        </div>
        <AssignmentList byDate={byDate} period={period} />
      </div>
    );
  }
  return (
    <div className="max-w-2xl">
      <AssignmentList byDate={byDate} period={period} />
    </div>
  );
}

function AssignmentList({
  byDate,
  period,
}: {
  byDate: Array<
    [
      string,
      Array<{
        date: string;
        slot_name: string;
        team_role_label: string | null;
        notes: string | null;
      }>,
    ]
  >;
  period: string;
}) {
  if (byDate.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No tienes asignaciones en {period.slice(0, 7)}.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border bg-white">
      {byDate.map(([date, items]) => {
        const d = new Date(date);
        const wd = d.getUTCDay();
        const isWE = wd === 0 || wd === 6;
        return (
          <li
            key={date}
            className={
              "flex items-start gap-4 p-3 "
              + (isWE ? "bg-amber-50/40" : "")
            }
          >
            <div className="w-20 shrink-0">
              <div className="text-sm font-semibold">{date.slice(8, 10)}</div>
              <div className="text-[11px] text-gray-500">
                {["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd]}{" "}
                {date.slice(5, 7)}/{date.slice(0, 4)}
              </div>
            </div>
            <div className="flex-1 space-y-1">
              {items.map((a, idx) => (
                <div key={idx} className="text-sm">
                  <span className="font-medium">{a.slot_name}</span>
                  {a.team_role_label && (
                    <span className="ml-1 text-gray-500">
                      · {a.team_role_label}
                    </span>
                  )}
                  {a.notes && (
                    <div className="text-xs text-gray-500">{a.notes}</div>
                  )}
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

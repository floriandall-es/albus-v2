"use client";
import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";
import { Button, Card, ErrorText, PageHeader } from "@/components/admin/ui";

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
  return (
    <>
      <PageHeader
        title={`Planificación · ${s.period}`}
        action={
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
        }
      />
      <p className="mb-4 text-sm text-gray-600">
        Estado: <span className="font-medium">{STATUS_LABEL[s.status]}</span>
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
                    {row.slot_name}
                  </td>
                  {dates.map((d) => {
                    const cell = row.cells[d] ?? [];
                    return (
                      <td
                        key={d}
                        className={`align-top px-1 py-1 ${
                          cell.length === 0 || cell.every((a) => a.person_id === null)
                            ? "bg-red-50"
                            : ""
                        }`}
                      >
                        {cell.length === 0 ? (
                          <span className="text-[10px] text-gray-400">—</span>
                        ) : (
                          cell.map((a) => (
                            <div
                              key={a.id}
                              className={`leading-tight ${
                                a.person_id === null ? "text-red-700" : ""
                              }`}
                              title={a.notes ?? ""}
                            >
                              {a.person_id === null ? (
                                "Sin cubrir"
                              ) : (
                                <>
                                  {a.person_name}
                                  {a.team_role_label && (
                                    <span className="text-gray-500">
                                      {" "}
                                      · {a.team_role_label}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
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
    </>
  );
}

function buildGrid(assignments: Assignment[]) {
  const dates = Array.from(new Set(assignments.map((a) => a.date))).sort();
  const slotMap = new Map<
    number,
    { slot_id: number; slot_name: string; cells: Record<string, Assignment[]> }
  >();
  for (const a of assignments) {
    let row = slotMap.get(a.slot_id);
    if (!row) {
      row = { slot_id: a.slot_id, slot_name: a.slot_name, cells: {} };
      slotMap.set(a.slot_id, row);
    }
    if (!row.cells[a.date]) row.cells[a.date] = [];
    row.cells[a.date].push(a);
  }
  const slotRows = Array.from(slotMap.values()).sort((a, b) =>
    a.slot_name.localeCompare(b.slot_name),
  );
  return { dates, slotRows };
}

"use client";
import { personLastName, type TeamAbsence } from "@/lib/api";

/**
 * "Libre" row for the three bespoke sub-equipo planning grids
 * (lead/planificacion, admin/groups/[id]/planificacion,
 * me/sub-equipos/[id]). All three are local table layouts that
 * predate the shared PlanningGrid; rather than refactor them to
 * the shared component (which has different cell semantics), we
 * append this single read-only row at the bottom.
 *
 * Caller wiring:
 *   1. Fetch team-absences for the schedule's month.
 *   2. Filter to the group's members (by intersecting with the
 *      team list's group_id).
 *   3. Pass the resulting `absences` array; this component
 *      expands the ranges into one chip per absent person per day.
 *
 * Renders nothing when there are no absences in range — keeps
 * the table footprint identical to before.
 */
export function GroupLibreRow({
  yy,
  mm,
  days,
  absences,
}: {
  yy: number;
  mm: number;
  days: number[];
  absences: TeamAbsence[];
}) {
  if (absences.length === 0) return null;

  // Expand each absence range into per-date entries; dedupe by
  // person_id per day in case a person has two overlapping blocks.
  const byDate = new Map<
    string,
    { person_id: number; person_name: string; person_last_name: string | null }[]
  >();
  for (const a of absences) {
    // Parse dates as local Y/M/D (no timezone surprises).
    const [sy, sm, sd] = a.start_date.split("-").map(Number);
    const [ey, em, ed] = a.end_date.split("-").map(Number);
    const start = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);
    const cur = new Date(start);
    while (cur <= end) {
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      const list = byDate.get(key) ?? [];
      if (!list.some((p) => p.person_id === a.person_id)) {
        list.push({
          person_id: a.person_id,
          person_name: a.person_name,
          person_last_name: a.person_last_name,
        });
        byDate.set(key, list);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  return (
    <tr className="border-t-2 border-emerald-200/60 bg-emerald-50/30">
      <td className="sticky left-0 z-10 border-r border-gray-200 border-t-2 border-t-emerald-200/60 bg-emerald-50/60 px-3 py-2 align-middle">
        <span className="flex items-center gap-2 font-medium text-gray-800">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          <span>Libre</span>
        </span>
      </td>
      {days.map((d) => {
        const dateStr = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const absent = byDate.get(dateStr) ?? [];
        return (
          <td
            key={d}
            className="border-r border-gray-100 last:border-r-0 align-top p-0"
          >
            <div className="min-h-10 px-1 py-1 text-center text-[10px] leading-tight">
              {absent.length === 0 ? (
                <span className="text-gray-300">—</span>
              ) : (
                <div className="flex flex-col gap-0.5 items-center">
                  {absent.map((p) => (
                    <span
                      key={p.person_id}
                      className="truncate text-emerald-800"
                      title={p.person_name}
                    >
                      {personLastName({
                        name: p.person_name,
                        last_name: p.person_last_name,
                      })}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

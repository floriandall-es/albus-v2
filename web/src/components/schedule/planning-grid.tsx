"use client";
import { useMemo } from "react";
import type { Assignment } from "@/lib/api";
import { Card } from "@/components/admin/ui";

// Shared planning grid: slot rows × date columns. Used by:
// - admin schedule detail (interactive — cells open the editor on click)
// - team-member "Mis turnos" view (read-only)
//
// `highlightPersonId` tints cells where that person appears, so a user
// looking at the full team grid can find their own shifts at a glance.

export type PlanningGridProps = {
  assignments: Assignment[];
  holidayDates: Set<string>;
  onCellClick?: (a: Assignment) => void;
  /** Only invoke onCellClick when this returns true. Defaults to true
   * for all cells when onCellClick is provided. Useful for read-only-ish
   * views where only specific cells (e.g. the current user's own) should
   * be clickable. */
  cellIsClickable?: (a: Assignment) => boolean;
  highlightPersonId?: number | null;
};

export function PlanningGrid({
  assignments,
  holidayDates,
  onCellClick,
  cellIsClickable,
  highlightPersonId = null,
}: PlanningGridProps) {
  const grid = useMemo(() => buildGrid(assignments), [assignments]);
  const interactive = !!onCellClick;

  if (grid.slotRows.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        Esta planificación no tiene asignaciones.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Card>
        <table className="text-xs">
          <thead className="border-b bg-gray-50">
            <tr>
              <th className="sticky left-0 bg-gray-50 z-10 px-2 py-1 text-left font-medium border-r min-w-[160px]">
                Slot
              </th>
              {grid.dates.map((d) => {
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
                      {["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd]}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {grid.slotRows.map((row) => (
              <tr key={row.slot_id} className="border-b last:border-b-0">
                <td className="sticky left-0 bg-white z-10 px-2 py-1 border-r font-medium">
                  {row.display_name}
                </td>
                {grid.dates.map((d) => {
                  const cell = row.cells[d] ?? [];
                  const empty =
                    cell.length === 0
                    || cell.every((a) => a.person_id === null);
                  const hasMe =
                    highlightPersonId !== null
                    && cell.some((a) => a.person_id === highlightPersonId);
                  return (
                    <td
                      key={d}
                      className={
                        "align-top px-1 py-1 "
                        + (empty
                          ? "bg-red-50"
                          : hasMe
                            ? "bg-blue-50"
                            : "")
                      }
                    >
                      {cell.length === 0 ? (
                        <span className="text-[10px] text-gray-400">—</span>
                      ) : (
                        cell.map((a) => {
                          const isMe =
                            highlightPersonId !== null
                            && a.person_id === highlightPersonId;
                          const content = (
                            <span className="inline-flex items-center gap-1">
                              {a.locked_at && (
                                <LockIcon className="h-3 w-3 text-amber-600" />
                              )}
                              {a.person_id === null ? (
                                "Sin cubrir"
                              ) : (
                                <>
                                  <span className={isMe ? "font-semibold" : ""}>
                                    {a.person_name}
                                  </span>
                                  {a.team_role_label && (
                                    <span className="text-gray-500">
                                      {" "}
                                      · {a.team_role_label}
                                    </span>
                                  )}
                                </>
                              )}
                            </span>
                          );
                          const clickable =
                            interactive
                            && (cellIsClickable
                              ? cellIsClickable(a)
                              : true);
                          if (clickable) {
                            return (
                              <button
                                type="button"
                                key={a.id}
                                onClick={() => onCellClick!(a)}
                                className={
                                  "block w-full text-left leading-tight hover:bg-blue-100 rounded cursor-pointer "
                                  + (a.person_id === null ? "text-red-700" : "")
                                }
                                title={
                                  isMe
                                    ? "Haz clic para pedir cobertura para este turno"
                                    : (a.notes ?? "")
                                }
                              >
                                {content}
                              </button>
                            );
                          }
                          return (
                            <div
                              key={a.id}
                              className={
                                "block w-full text-left leading-tight "
                                + (a.person_id === null ? "text-red-700" : "")
                              }
                              title={a.notes ?? ""}
                            >
                              {content}
                            </div>
                          );
                        })
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

"use client";
import { useMemo } from "react";
import {
  avatarSrc,
  type Assignment,
  type TeamMember,
} from "@/lib/api";

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
  /** When provided, the grid renders an extra "Libre" row at the bottom
   * showing the team members NOT assigned to any slot that day. */
  teamMembers?: TeamMember[];
};

export function PlanningGrid({
  assignments,
  holidayDates,
  onCellClick,
  cellIsClickable,
  highlightPersonId = null,
  teamMembers,
}: PlanningGridProps) {
  const grid = useMemo(() => buildGrid(assignments), [assignments]);
  const interactive = !!onCellClick;

  // For each date, list team members not assigned to ANY slot. A null
  // person_id (Sin cubrir) doesn't count as "taken".
  const libreByDate = useMemo(() => {
    if (!teamMembers || teamMembers.length === 0) return null;
    const assignedByDate = new Map<string, Set<number>>();
    for (const a of assignments) {
      if (a.person_id === null) continue;
      let set = assignedByDate.get(a.date);
      if (!set) {
        set = new Set();
        assignedByDate.set(a.date, set);
      }
      set.add(a.person_id);
    }
    const result = new Map<string, TeamMember[]>();
    for (const d of grid.dates) {
      const assigned = assignedByDate.get(d) ?? new Set();
      const libre = teamMembers
        .filter((m) => !assigned.has(m.person_id))
        .sort((a, b) => a.person_name.localeCompare(b.person_name));
      result.set(d, libre);
    }
    return result;
  }, [assignments, teamMembers, grid.dates]);

  if (grid.slotRows.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        Esta planificación no tiene asignaciones.
      </p>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="overflow-x-auto rounded-xl bg-white shadow-soft ring-1 ring-gray-200">
      <table className="text-xs">
        <thead className="bg-gray-50">
          <tr>
            <th className="sticky left-0 bg-gray-50 z-10 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-r border-gray-200 min-w-[180px]">
              Turno
            </th>
            {grid.dates.map((d) => {
              const isHoliday = holidayDates.has(d);
              const dt = new Date(d);
              const wd = dt.getDay();
              const isWeekend = wd === 0 || wd === 6;
              const isToday = d === today;
              return (
                <th
                  key={d}
                  className={
                    "px-1 py-2.5 text-center min-w-[84px] border-b "
                    + (isToday
                      ? "bg-brand-50 border-brand-200 "
                      : isHoliday
                        ? "bg-amber-50 border-amber-200 "
                        : isWeekend
                          ? "bg-gray-100/60 border-gray-200 "
                          : "border-gray-200 ")
                  }
                >
                  <div
                    className={
                      "text-sm font-semibold "
                      + (isToday
                        ? "text-brand-700"
                        : isHoliday
                          ? "text-amber-900"
                          : isWeekend
                            ? "text-gray-500"
                            : "text-gray-900")
                    }
                  >
                    {d.slice(8)}
                  </div>
                  <div
                    className={
                      "font-medium text-[10px] uppercase tracking-wide "
                      + (isToday
                        ? "text-brand-600"
                        : isHoliday
                          ? "text-amber-700"
                          : isWeekend
                            ? "text-gray-400"
                            : "text-gray-500")
                    }
                  >
                    {["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd]}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.slotRows.map((row, rowIdx) => (
            <tr
              key={row.slot_id}
              className={rowIdx % 2 === 1 ? "bg-gray-50/40" : ""}
            >
              <td
                className={
                  "sticky left-0 z-10 px-3 py-2 border-r border-gray-200 font-medium text-gray-800 "
                  + (rowIdx % 2 === 1 ? "bg-gray-50/90" : "bg-white")
                }
              >
                <span className="flex items-center gap-2">
                  {row.color && (
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: row.color }}
                    />
                  )}
                  <span>{row.display_name}</span>
                </span>
              </td>
              {grid.dates.map((d) => {
                const cell = row.cells[d] ?? [];
                const empty =
                  cell.length === 0
                  || cell.every((a) => a.person_id === null);
                const hasMe =
                  highlightPersonId !== null
                  && cell.some((a) => a.person_id === highlightPersonId);
                const isToday = d === today;
                return (
                  <td
                    key={d}
                    className={
                      "align-top px-1.5 py-2 border-b border-gray-100 "
                      + (empty
                        ? "bg-rose-50/70"
                        : hasMe
                          ? "bg-brand-50/70"
                          : isToday
                            ? "bg-brand-50/30"
                            : "")
                    }
                  >
                    {cell.length === 0 ? (
                      <span className="text-[11px] text-gray-300">—</span>
                    ) : (
                      cell.map((a) => {
                        const isMe =
                          highlightPersonId !== null
                          && a.person_id === highlightPersonId;
                        // When the user view sets a highlight, dim every
                        // OTHER assignment so own shifts pop. No effect
                        // on the admin grid (no highlight set there).
                        const dim =
                          highlightPersonId !== null
                          && !isMe
                          && a.person_id !== null;
                        const content = (
                          <span
                            className={
                              "inline-flex items-center gap-1.5 max-w-full "
                              + (dim ? "opacity-60" : "")
                            }
                          >
                            {a.person_id !== null && a.person_name && (
                              <Avatar
                                name={a.person_name}
                                mine={isMe}
                                imageUrl={a.person_avatar_url}
                              />
                            )}
                            {a.locked_at && (
                              <LockIcon className="h-3 w-3 text-amber-600 shrink-0" />
                            )}
                            {a.swap_offer_id != null && (
                              <SwapIcon className="h-3 w-3 text-sky-600 shrink-0" />
                            )}
                              {a.person_id === null ? (
                                <span className="text-rose-700 font-medium">
                                  Sin cubrir
                                </span>
                              ) : (
                                <>
                                  <span
                                    className={
                                      isMe
                                        ? "font-semibold text-brand-700"
                                        : "text-gray-800"
                                    }
                                  >
                                    {a.person_name}
                                  </span>
                                  {a.team_role_label && (
                                    <span className="text-gray-400">
                                      {" "}· {a.team_role_label}
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
                          const swapTooltip = a.swap_offer_id != null
                            ? "Turno modificado por un cambio entre miembros"
                            : null;
                          const tooltip = [
                            isMe && clickable
                              ? "Haz clic para pedir cobertura para este turno"
                              : null,
                            swapTooltip,
                            a.notes,
                          ]
                            .filter(Boolean)
                            .join(" · ");
                          if (clickable) {
                            return (
                              <button
                                type="button"
                                key={a.id}
                                onClick={() => onCellClick!(a)}
                                className="block w-full text-left leading-tight rounded px-1 -mx-1 cursor-pointer hover:bg-brand-100/60 transition-colors"
                                title={tooltip || undefined}
                              >
                                {content}
                              </button>
                            );
                          }
                          return (
                            <div
                              key={a.id}
                              className="block w-full text-left leading-tight"
                              title={tooltip || undefined}
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
            {libreByDate && (
              <tr className="bg-emerald-50/30 border-t-2 border-gray-200">
                <td className="sticky left-0 z-10 bg-emerald-50/60 px-3 py-2 border-r border-gray-200 font-medium text-gray-800">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full shrink-0 bg-emerald-500" />
                    <span>Libre</span>
                  </span>
                </td>
                {grid.dates.map((d) => {
                  const libre = libreByDate.get(d) ?? [];
                  const isToday = d === today;
                  return (
                    <td
                      key={d}
                      className={
                        "align-top px-1.5 py-2 border-b border-gray-100 "
                        + (isToday ? "bg-brand-50/20 " : "")
                      }
                    >
                      {libre.length === 0 ? (
                        <span className="text-[11px] text-gray-300">—</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1">
                          {libre.map((m) => {
                            const isMe =
                              highlightPersonId !== null
                              && m.person_id === highlightPersonId;
                            return (
                              <span
                                key={m.person_id}
                                title={m.person_name}
                              >
                                <Avatar
                                  name={m.person_name}
                                  mine={isMe}
                                  imageUrl={m.person_avatar_url}
                                />
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
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
      color: string | null;
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
        color: a.slot_color ?? null,
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

// Soft pastel palette for slot row dots + person avatar backgrounds.
// Picked deterministically from a name so the same person/slot always
// gets the same colour across re-renders and sessions.
const AVATAR_PALETTE = [
  { bg: "#fef3c7", fg: "#92400e" }, // amber
  { bg: "#dbeafe", fg: "#1e40af" }, // blue
  { bg: "#dcfce7", fg: "#166534" }, // green
  { bg: "#fce7f3", fg: "#9d174d" }, // pink
  { bg: "#e0e7ff", fg: "#3730a3" }, // indigo
  { bg: "#ffe4e6", fg: "#9f1239" }, // rose
  { bg: "#ccfbf1", fg: "#115e59" }, // teal
  { bg: "#f3e8ff", fg: "#6b21a8" }, // purple
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function paletteFor(name: string) {
  return AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Avatar({
  name,
  mine,
  imageUrl,
}: {
  name: string;
  mine: boolean;
  imageUrl?: string | null;
}) {
  const ringClass = mine ? "ring-2 ring-brand-500 ring-offset-1" : "";
  const src = avatarSrc(imageUrl ?? null);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={
          "h-5 w-5 shrink-0 rounded-full object-cover " + ringClass
        }
      />
    );
  }
  const p = paletteFor(name);
  return (
    <span
      className={
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold "
        + ringClass
      }
      style={{ backgroundColor: p.bg, color: p.fg }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
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

function SwapIcon({ className }: { className?: string }) {
  // Two opposing arrows = swap.
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
      <path d="M7 17l-4-4 4-4" />
      <path d="M3 13h14" />
      <path d="M17 7l4 4-4 4" />
      <path d="M21 11H7" />
    </svg>
  );
}

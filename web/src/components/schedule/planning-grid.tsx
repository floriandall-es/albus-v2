"use client";
import { useMemo } from "react";
import {
  avatarSrc,
  personLastName,
  type Assignment,
  type MeetingInstance,
  type TeamAbsence,
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
  /** Approved availability blocks (vacation, baja, formación, …)
   * covering the displayed dates. When provided, an extra "Libre" row
   * appears at the bottom with one avatar per absent person per day. */
  absences?: TeamAbsence[];
  /** Admin-only (and only when the schedule is editable). When
   * provided, each Libre cell becomes clickable so the caller can pop
   * a "manage absences for this date" modal — add and remove. The
   * read-only views and the published/archived schedule view leave
   * this undefined and the Libre row stays non-interactive. */
  onAbsenceCellClick?: (date: string) => void;
  /** Meeting occurrences (ad-hoc + expanded regular templates) the
   * caller is allowed to see. When provided, a "Reuniones" row appears
   * above Libre with one chip per meeting per date. Meetings outside
   * the grid's date range are silently ignored. */
  meetings?: MeetingInstance[];
  /** Assignment ids that participate in at least one rule violation.
   * Cells matching one of these get a small rose-coloured corner
   * marker so the admin can spot the conflicts on the grid. Tooltip
   * lives on the ViolationsBanner above the grid; this is purely a
   * visual cue. */
  flaggedAssignmentIds?: Set<number>;
  /** Optional override for the date columns. When provided, the
   * grid renders exactly these dates as columns (sorted ascending)
   * instead of deriving them from the assignment set. Used by the
   * /me/turnos personal table so off days appear as empty columns
   * next to working days. Slot rows still come from `assignments`
   * — so an empty `assignments` plus `forceDates` produces an
   * empty grid (no rows). */
  forceDates?: string[];
};

export function PlanningGrid({
  assignments,
  holidayDates,
  onCellClick,
  cellIsClickable,
  highlightPersonId = null,
  absences,
  onAbsenceCellClick,
  meetings,
  flaggedAssignmentIds,
  forceDates,
}: PlanningGridProps) {
  const grid = useMemo(
    () => buildGrid(assignments, forceDates),
    [assignments, forceDates],
  );
  const interactive = !!onCellClick;

  // Group meetings by date so each grid column knows which to show.
  // Sort within a date by start_time for a stable order.
  const meetingsByDate = useMemo(() => {
    if (!meetings) return null;
    const map = new Map<string, MeetingInstance[]>();
    for (const m of meetings) {
      const list = map.get(m.date) ?? [];
      list.push(m);
      map.set(m.date, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    }
    return map;
  }, [meetings]);

  // Expand each absence range into a per-date list of absent persons.
  // Same person can appear in multiple blocks; dedupe by person_id.
  const absencesByDate = useMemo(() => {
    if (!absences) return null;
    const result = new Map<
      string,
      {
        person_id: number;
        person_name: string;
        person_last_name: string | null;
        person_avatar_url: string | null;
        block_type: string;
      }[]
    >();
    for (const d of grid.dates) {
      const items: typeof result extends Map<string, infer V> ? V : never = [];
      const seen = new Set<number>();
      for (const a of absences) {
        if (a.start_date <= d && d <= a.end_date) {
          if (seen.has(a.person_id)) continue;
          seen.add(a.person_id);
          items.push({
            person_id: a.person_id,
            person_name: a.person_name,
            person_last_name: a.person_last_name,
            person_avatar_url: a.person_avatar_url,
            block_type: a.block_type,
          });
        }
      }
      items.sort((x, y) => x.person_name.localeCompare(y.person_name));
      result.set(d, items);
    }
    return result;
  }, [absences, grid.dates]);

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
      {/* `border-separate border-spacing-0` is what makes
          `sticky` actually work on the first column. Tailwind
          preflight sets tables to `border-collapse: collapse`,
          which prevents browsers from honouring
          `position: sticky` on td/th — the activities column
          would silently scroll out of view as the admin moved
          horizontally through a month. Separate borders + zero
          spacing keeps the visual flat-grid layout while letting
          the sticky-left cells stay pinned. */}
      <table className="text-xs border-separate border-spacing-0">
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
              key={`${row.slot_id}|${row.team_role_label ?? ""}`}
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
                  <span className="flex flex-col leading-tight">
                    <span>{row.display_name}</span>
                    {row.team_role_label && (
                      <span className="text-xs font-normal text-gray-500">
                        {row.team_role_label}
                      </span>
                    )}
                  </span>
                </span>
              </td>
              {grid.dates.map((d) => {
                const cell = row.cells[d] ?? [];
                // Sprint 28: a cell is "dismissed" if the admin marked
                // this (slot, date) as "No aplica". The dismissal
                // cascades so every row in the cell shares the flag.
                const isDismissed =
                  cell.length > 0
                  && cell.every((a) => a.dismissed_at !== null);
                // Member views (highlightPersonId set on /me/turnos)
                // collapse dismissed → "this day doesn't apply" so the
                // grid stays uncluttered. Members don't need to see the
                // admin's override marker; they just need to know "no
                // shift for me today" — same outcome as a weekday the
                // slot doesn't run. Admin views keep the explicit
                // strikethrough "No aplica" pill so the override is
                // visible and clickable to revert.
                const memberView = highlightPersonId !== null;
                const isDismissedAdminPill = isDismissed && !memberView;
                const isDismissedAsEmpty = isDismissed && memberView;
                const empty =
                  !isDismissed
                  && (cell.length === 0
                    || cell.every((a) => a.person_id === null));
                const hasMe =
                  highlightPersonId !== null
                  && cell.some((a) => a.person_id === highlightPersonId);
                const isToday = d === today;
                // True when any assignment in this cell shows up in a
                // rule violation — drives a rose ring around the cell
                // so the admin can spot conflicts at a glance.
                const isFlagged =
                  flaggedAssignmentIds
                  && cell.some((a) => flaggedAssignmentIds.has(a.id));
                return (
                  <td
                    key={d}
                    className={
                      "align-top px-1.5 py-2 border-b border-gray-100 "
                      + (isFlagged ? "ring-2 ring-inset ring-rose-400 " : "")
                      + (isDismissedAdminPill
                        ? "bg-gray-100"
                        : empty || isDismissedAsEmpty
                          ? "bg-rose-50/70"
                          : hasMe
                            ? "bg-brand-50/70"
                            : isToday
                              ? "bg-brand-50/30"
                              : "")
                    }
                  >
                    {isDismissedAdminPill ? (
                      // Render ONE "No aplica" pill regardless of how
                      // many sibling rows the dismissal cascaded to.
                      // The admin can click any of them to re-apply.
                      (() => {
                        const a = cell[0];
                        const content = (
                          <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 italic line-through">
                            No aplica
                          </span>
                        );
                        return onCellClick ? (
                          <button
                            type="button"
                            onClick={() => onCellClick(a)}
                            className="block w-full text-left hover:bg-gray-200/60 rounded px-0.5"
                          >
                            {content}
                          </button>
                        ) : (
                          content
                        );
                      })()
                    ) : isDismissedAsEmpty || cell.length === 0 ? (
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
                            {/* Lock icon is admin-only. Members
                                don't need to know an admin
                                pinned the shift — the lock's
                                visible behaviour for them is
                                "the swap modal doesn't open",
                                which the cellIsClickable prop
                                already enforces. highlightPersonId
                                is set on /me views and unset on
                                /admin views — same discriminator
                                used by the dismissed-cell render. */}
                            {a.locked_at && highlightPersonId === null && (
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
                                // Sprint 16: the role label moved to
                                // the left-column row header; cells
                                // only show the person now.
                                // Sprint 18: render the last name in
                                // the tight grid cells — falls back
                                // to the legacy full name when the
                                // person hasn't filled in the split.
                                <span
                                  className={
                                    isMe
                                      ? "font-semibold text-brand-700"
                                      : "text-gray-800"
                                  }
                                >
                                  {personLastName({
                                    name: a.person_name ?? "",
                                    last_name: a.person_last_name,
                                  })}
                                </span>
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
            {meetingsByDate && (
              // The `border-t-2` on the <tr> would render the
              // section separator under border-collapse:collapse;
              // we use border-separate now, so the border has to
              // live on the cells. Same below for the absences
              // (emerald) row.
              <tr className="bg-violet-50/30">
                <td className="sticky left-0 z-10 bg-violet-50/60 px-3 py-2 border-r border-t-2 border-r-gray-200 border-t-gray-200 font-medium text-gray-800">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full shrink-0 bg-violet-500" />
                    <span>Reuniones</span>
                  </span>
                </td>
                {grid.dates.map((d) => {
                  const items = meetingsByDate.get(d) ?? [];
                  const isToday = d === today;
                  return (
                    <td
                      key={d}
                      className={
                        "align-top px-1.5 py-2 border-b border-t-2 border-b-gray-100 border-t-gray-200 "
                        + (isToday ? "bg-brand-50/20 " : "")
                      }
                    >
                      {items.length === 0 ? (
                        <span className="text-[11px] text-gray-300">—</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {items.map((m) => (
                            <span
                              key={`${m.meeting_id}_${m.start_time}`}
                              className="inline-flex flex-col leading-tight"
                              title={
                                [
                                  m.location,
                                  m.organizer_name
                                    ? `Organiza ${m.organizer_name}`
                                    : null,
                                  m.description,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || undefined
                              }
                            >
                              <span className="font-medium text-violet-800 truncate">
                                {m.title}
                              </span>
                              <span className="text-[10px] text-violet-600">
                                {m.start_time.slice(0, 5)}
                                –{m.end_time.slice(0, 5)}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            )}
            {absencesByDate && (
              <tr className="bg-emerald-50/30">
                <td className="sticky left-0 z-10 bg-emerald-50/60 px-3 py-2 border-r border-t-2 border-r-gray-200 border-t-gray-200 font-medium text-gray-800">
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full shrink-0 bg-emerald-500" />
                    <span>Libre</span>
                  </span>
                </td>
                {grid.dates.map((d) => {
                  const absent = absencesByDate.get(d) ?? [];
                  const isToday = d === today;
                  const cellContent =
                    absent.length === 0 ? (
                      <span className="text-[11px] text-gray-300">—</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {absent.map((m) => {
                          const isMe =
                            highlightPersonId !== null
                            && m.person_id === highlightPersonId;
                          return (
                            <span
                              key={m.person_id}
                              className="inline-flex items-center gap-1.5 leading-tight"
                              title={
                                BLOCK_LABEL[m.block_type] ?? m.block_type
                              }
                            >
                              <Avatar
                                name={m.person_name}
                                mine={isMe}
                                imageUrl={m.person_avatar_url}
                              />
                              <span
                                className={
                                  isMe
                                    ? "font-semibold text-brand-700"
                                    : "text-gray-800"
                                }
                              >
                                {personLastName({
                                  name: m.person_name,
                                  last_name: m.person_last_name,
                                })}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    );
                  const baseCellClass =
                    "align-top px-1.5 py-2 border-b border-t-2 border-b-gray-100 border-t-gray-200 "
                    + (isToday ? "bg-brand-50/20 " : "");
                  if (onAbsenceCellClick) {
                    return (
                      <td key={d} className={baseCellClass + "p-0"}>
                        <button
                          type="button"
                          onClick={() => onAbsenceCellClick(d)}
                          title="Gestionar personas ausentes este día"
                          className={
                            "block w-full h-full text-left px-1.5 py-2 cursor-pointer "
                            + "hover:bg-emerald-100/50 transition-colors group"
                          }
                        >
                          {cellContent}
                          <span
                            className="block text-[10px] text-emerald-700/70 opacity-0 group-hover:opacity-100 mt-0.5"
                            aria-hidden
                          >
                            Gestionar
                          </span>
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={d} className={baseCellClass}>
                      {cellContent}
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

function buildGrid(assignments: Assignment[], forceDates?: string[]) {
  // Date columns: either the caller-supplied override (sorted +
  // deduped defensively), or the natural set derived from the
  // assignments. The override path is used by /me/turnos to keep
  // off-day columns visible even when the user has no shifts on
  // those days.
  const dates = forceDates
    ? Array.from(new Set(forceDates)).sort()
    : Array.from(new Set(assignments.map((a) => a.date))).sort();
  // Sprint 16: rows are keyed by (slot_id, team_role_label) instead of
  // just slot_id. A team_composition slot with three roles becomes
  // three rows; the left column carries the role label and each cell
  // contains only one assignment, instead of stuffing all roles into
  // one super-row.
  type GridRow = {
    slot_id: number;
    slot_name: string;
    /** Admin-controlled order (see Slot.position). Mirrored from
     * the first assignment we see for the slot — same value across
     * all of that slot's role rows. */
    slot_position: number;
    team_role_label: string | null;
    display_name: string;
    color: string | null;
    /** Set when the slot belongs to a sub-team group. Used to
     * render a small pill on the row label so admins can tell at
     * a glance which rows are managed by a group lead. */
    group_name: string | null;
    cells: Record<string, Assignment[]>;
  };
  const rowMap = new Map<string, GridRow>();
  const rowKey = (slot_id: number, role: string | null) =>
    `${slot_id}|${role ?? ""}`;
  for (const a of assignments) {
    const role = a.team_role_label ?? null;
    const key = rowKey(a.slot_id, role);
    let row = rowMap.get(key);
    if (!row) {
      row = {
        slot_id: a.slot_id,
        slot_name: a.slot_name,
        slot_position: a.slot_position ?? 0,
        team_role_label: role,
        display_name: a.slot_name,
        color: a.slot_color ?? null,
        group_name: a.slot_group_name ?? null,
        cells: {},
      };
      rowMap.set(key, row);
    }
    if (!row.cells[a.date]) row.cells[a.date] = [];
    row.cells[a.date].push(a);
  }
  // Disambiguate slots that share a name by appending "· #id". Count
  // DISTINCT slot_ids per name — naively counting rows would over-fire
  // here because the same slot now contributes one row per role.
  const slotIdsByName = new Map<string, Set<number>>();
  for (const row of rowMap.values()) {
    const set = slotIdsByName.get(row.slot_name) ?? new Set<number>();
    set.add(row.slot_id);
    slotIdsByName.set(row.slot_name, set);
  }
  for (const row of rowMap.values()) {
    if ((slotIdsByName.get(row.slot_name)?.size ?? 0) > 1) {
      row.display_name = `${row.slot_name} · #${row.slot_id}`;
    }
  }
  const slotRows = Array.from(rowMap.values()).sort((a, b) => {
    // Primary sort: admin-controlled position (sprint 17). Falls
    // through to display_name + role label for deterministic order
    // when two slots happen to share a position (rare).
    if (a.slot_position !== b.slot_position) {
      return a.slot_position - b.slot_position;
    }
    const byName = a.display_name.localeCompare(b.display_name);
    if (byName !== 0) return byName;
    // Same slot: keep the no-role row (rare — shouldn't coexist with
    // role rows, but defensive) first, then alpha by role label so
    // "Quirofano 1" precedes "Quirofano 2".
    if (a.team_role_label === null && b.team_role_label !== null) return -1;
    if (a.team_role_label !== null && b.team_role_label === null) return 1;
    return (a.team_role_label ?? "").localeCompare(b.team_role_label ?? "");
  });
  return { dates, slotRows };
}

const BLOCK_LABEL: Record<string, string> = {
  vacation: "Vacaciones",
  sick: "Baja médica",
  training: "Formación",
  personal: "Personal",
  other: "Otro",
};

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

// Exported so other pages (e.g. the schedule detail's BalanceStats
// table) can reuse the same look + initials-fallback for person
// avatars without duplicating the styling.
export function Avatar({
  name,
  mine,
  imageUrl,
  size = "sm",
}: {
  name: string;
  mine: boolean;
  imageUrl?: string | null;
  /** "sm" = 20px (default — matches the grid cells, message rows,
   * and shift list rows). "md" = 36px, used by the /me/turnos
   * Equipo+Lista row where the assigned person is the row's
   * leading visual element. */
  size?: "sm" | "md";
}) {
  const ringClass = mine ? "ring-2 ring-brand-500 ring-offset-1" : "";
  const dimClass = size === "md" ? "h-9 w-9" : "h-5 w-5";
  const initialsTextClass = size === "md" ? "text-xs" : "text-[9px]";
  const src = avatarSrc(imageUrl ?? null);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={
          dimClass
          + " shrink-0 rounded-full object-cover "
          + ringClass
        }
      />
    );
  }
  const p = paletteFor(name);
  return (
    <span
      className={
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold "
        + dimClass
        + " "
        + initialsTextClass
        + " "
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

"use client";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
// - /me/turnos Servicio scope (multi-section, one band per Equipo)
//
// `highlightPersonId` tints cells where that person appears, so a user
// looking at the full team grid can find their own shifts at a glance.

/** One band of the grid. The grid renders ONE shared set of date
 * columns and one band per section, each with its own slot rows and
 * (optional) Reuniones + Libre rows. The single-section call sites
 * (/admin/schedule, /me/turnos Mis/Equipo, /lead/planificacion) use
 * the legacy top-level props; the multi-section call site (/me/turnos
 * Servicio scope) passes `sections` instead and gets one big table
 * where every band shares column widths and horizontal scroll. */
export type PlanningGridSection = {
  /** Sticky band header rendered above this section's slot rows. Pass
   * null to suppress (the legacy single-section path uses null because
   * the page title already names the team). */
  label: ReactNode | null;
  assignments: Assignment[];
  /** Approved availability blocks for THIS section's team. When set,
   * a Libre row renders at the bottom of the section's band. */
  absences?: TeamAbsence[];
  /** Meeting occurrences for THIS section's team. When set, a
   * Reuniones row renders between the slot rows and the Libre row. */
  meetings?: MeetingInstance[];
  /** Person to highlight in this section's cells (used by /me/turnos
   * for the user's own team — sibling teams pass null because the
   * caller isn't a member). */
  highlightPersonId?: number | null;
  /** Click handler for slot cells in this section. Read-only sections
   * (sibling teams in Servicio scope) leave this undefined. */
  onCellClick?: (a: Assignment) => void;
  cellIsClickable?: (a: Assignment) => boolean;
  /** Admin-only click handler for the Libre row. Same per-section
   * gating as onCellClick. */
  onAbsenceCellClick?: (date: string) => void;
};

export type PlanningGridProps = {
  // -----------------------------------------------------------------
  // Legacy single-section props. Kept so existing call sites (admin
  // schedule detail, /me/turnos Mis + Equipo, /lead/planificacion)
  // don't need to change. When `sections` is provided these are
  // ignored.
  // -----------------------------------------------------------------
  assignments?: Assignment[];
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

  // -----------------------------------------------------------------
  // Multi-section variant. When provided, the grid renders one band
  // per section sharing a single set of date columns — so column
  // widths line up across sections and horizontal scroll moves every
  // band in lockstep. The legacy single-section props above are
  // ignored when this is set.
  // -----------------------------------------------------------------
  sections?: PlanningGridSection[];

  // -----------------------------------------------------------------
  // Always-global props
  // -----------------------------------------------------------------
  holidayDates: Set<string>;
  /** Admin-only. When provided, "—" cells (cells with no Assignment
   * row at all — typically legacy migrated data where the cell
   * disappeared) become clickable. The caller decides what to do
   * with the (slot_id, team_role_id, date) tuple; current usage POSTs
   * a Sin-cubrir Assignment so the cell becomes editable through the
   * normal flow. Leave undefined to keep "—" cells inert. */
  onEmptyCellClick?: (args: {
    slot_id: number;
    team_role_id: number | null;
    slot_name: string;
    team_role_label: string | null;
    date: string;
  }) => void;
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
   * next to working days, and by Servicio scope so all bands share
   * the same windows regardless of which team has assignments. */
  forceDates?: string[];
  /** True on member-facing views (/me/turnos), false on admin views
   * (/admin/schedule…). Decides framing — uncovered cells read as
   * "—" instead of the rose "Sin cubrir" pill, dismissed cells
   * render as empty rather than as the strikethrough "No aplica"
   * pill. Falls back to `sectionHighlight !== null` per-section
   * when not set, so legacy callers that don't pass it (single
   * /me section with a highlight) still behave correctly. The
   * explicit prop is what fixes the case where /me/turnos shows
   * sibling-team sections (no highlight, but still member view). */
  memberView?: boolean;
  /** Dates on which the highlighted member is libre (vacation, baja,
   * etc.). When set, those columns get an emerald tint across the
   * header and all rows — same palette as the Libre row — so it
   * reads as a continuous vertical band "you're off this day".
   * Caller responsibility (it's per-section semantically, but we
   * pass it at the top level because /me/turnos's grid has a single
   * highlighted person and we don't want to bloat every section). */
  highlightAbsenceDates?: Set<string>;
};

export function PlanningGrid({
  assignments,
  onCellClick,
  cellIsClickable,
  highlightPersonId = null,
  absences,
  onAbsenceCellClick,
  meetings,
  sections,
  holidayDates,
  onEmptyCellClick,
  flaggedAssignmentIds,
  forceDates,
  memberView,
  highlightAbsenceDates,
}: PlanningGridProps) {
  // Normalize: explicit sections, or wrap the legacy props as one
  // anonymous section. The legacy path keeps every existing call
  // site working without any change.
  const resolvedSections = useMemo<PlanningGridSection[]>(() => {
    if (sections) return sections;
    return [
      {
        label: null,
        assignments: assignments ?? [],
        absences,
        meetings,
        highlightPersonId,
        onCellClick,
        cellIsClickable,
        onAbsenceCellClick,
      },
    ];
  }, [
    sections,
    assignments,
    absences,
    meetings,
    highlightPersonId,
    onCellClick,
    cellIsClickable,
    onAbsenceCellClick,
  ]);

  // Unified date axis — the whole point of multi-section mode: all
  // bands share these exact column widths and scroll together.
  const dates = useMemo(() => {
    if (forceDates) return Array.from(new Set(forceDates)).sort();
    const all = new Set<string>();
    for (const s of resolvedSections) {
      for (const a of s.assignments) all.add(a.date);
    }
    return Array.from(all).sort();
  }, [resolvedSections, forceDates]);

  // Per-section grid built against the shared dates axis. Calling
  // buildGrid with the shared dates guarantees every section's row
  // map has the same date keyspace.
  const sectionGrids = useMemo(
    () => resolvedSections.map((s) => buildGrid(s.assignments, dates)),
    [resolvedSections, dates],
  );

  const totalRows = sectionGrids.reduce(
    (sum, g) => sum + g.slotRows.length,
    0,
  );
  if (totalRows === 0) {
    return (
      <p className="text-sm text-gray-500">
        Esta planificación no tiene asignaciones.
      </p>
    );
  }

  return (
    <PlanningGridInner
      resolvedSections={resolvedSections}
      sectionGrids={sectionGrids}
      dates={dates}
      holidayDates={holidayDates}
      flaggedAssignmentIds={flaggedAssignmentIds}
      onEmptyCellClick={onEmptyCellClick}
      memberView={memberView}
      highlightAbsenceDates={highlightAbsenceDates}
    />
  );
}

/** Split out so the scroll-container ref + the today-scroll effect
 * can live next to each other without polluting the parent's hooks.
 * Pure presentation — every render-relevant value is already
 * resolved by PlanningGrid. */
function PlanningGridInner({
  resolvedSections,
  sectionGrids,
  dates,
  holidayDates,
  flaggedAssignmentIds,
  onEmptyCellClick,
  memberView,
  highlightAbsenceDates,
}: {
  resolvedSections: PlanningGridSection[];
  sectionGrids: ReturnType<typeof buildGrid>[];
  dates: string[];
  holidayDates: Set<string>;
  flaggedAssignmentIds?: Set<number>;
  onEmptyCellClick?: PlanningGridProps["onEmptyCellClick"];
  memberView?: boolean;
  highlightAbsenceDates?: Set<string>;
}) {
  // Today, computed once on mount. Used by both the cell-coloring
  // logic and the auto-scroll effect below. A page kept open past
  // midnight will keep the previous day highlighted until reload —
  // acceptable for our workflow.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Clicking a meeting chip opens a small read-only detail card.
  // Handled internally so no call site has to thread a callback.
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingInstance | null>(
    null,
  );

  // Scroll today into view as the first visible date column on
  // initial render + whenever the date window changes. The sticky
  // "Turno" column's width is subtracted so today doesn't slide
  // underneath it. Skipped when today isn't in the rendered range
  // (e.g. viewing a non-current schedule) — the natural leftmost
  // position is the right default in that case.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (!dates.includes(today)) return;
    const th = container.querySelector<HTMLElement>(
      `[data-date="${today}"]`,
    );
    if (!th) return;
    const stickyCol = container.querySelector<HTMLElement>(
      "thead th[data-sticky-col='true']",
    );
    const stickyWidth = stickyCol?.offsetWidth ?? 0;
    // Math.max guards against negative scrollLeft when today happens
    // to be the very first date in the range (offsetLeft would be
    // smaller than the sticky column width).
    container.scrollLeft = Math.max(0, th.offsetLeft - stickyWidth);
  }, [dates, today]);

  return (
    <>
    <div
      ref={scrollContainerRef}
      className="overflow-x-auto rounded-xl bg-white shadow-soft ring-1 ring-gray-200"
    >
      {/* `border-separate border-spacing-0` is what makes `sticky`
          actually work on the first column. Tailwind preflight sets
          tables to `border-collapse: collapse`, which prevents
          browsers from honouring `position: sticky` on td/th — the
          activities column would silently scroll out of view as the
          user moved horizontally through a month. Separate borders +
          zero spacing keeps the visual flat-grid layout while
          letting the sticky-left cells stay pinned. */}
      <table className="text-xs border-separate border-spacing-0">
        <thead className="bg-gray-50">
          <tr>
            {/* No min-width: the column auto-sizes to the longest
                slot name (the th and body cells share the column
                width in a table). The 180px floor used to eat
                ~half the screen on mobile for short names like
                "Guardia" or "Planta". */}
            <th
              data-sticky-col="true"
              className="sticky left-0 bg-gray-50 z-10 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-r border-gray-200 whitespace-nowrap"
            >
              Turno
            </th>
            {dates.map((d) => {
              const isHoliday = holidayDates.has(d);
              const dt = new Date(d);
              const wd = dt.getDay();
              const isWeekend = wd === 0 || wd === 6;
              const isToday = d === today;
              const isMyAbsence =
                highlightAbsenceDates?.has(d) ?? false;
              return (
                <th
                  key={d}
                  data-date={d}
                  className={
                    "px-1 py-2.5 text-center min-w-[84px] border-b "
                    + (isToday
                      ? "bg-brand-50 border-brand-200 "
                      : isMyAbsence
                        ? "bg-emerald-50 border-emerald-200 "
                        : isHoliday
                          ? "bg-amber-50 border-amber-200 "
                          : isWeekend
                            ? "bg-slate-100 border-gray-200 "
                            : "border-gray-200 ")
                  }
                >
                  <div
                    className={
                      "text-sm font-semibold "
                      + (isToday
                        ? "text-brand-700"
                        : isMyAbsence
                          ? "text-emerald-900"
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
                        : isMyAbsence
                          ? "text-emerald-700"
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
          {resolvedSections.map((section, sectIdx) => {
            const grid = sectionGrids[sectIdx];
            const sectionInteractive = !!section.onCellClick;
            const sectionHighlight = section.highlightPersonId ?? null;

            // Per-section meetings + absences maps. Plain function
            // calls (not useMemo — hooks can't run inside .map). The
            // data sets are small enough that per-render recomputation
            // is cheap.
            const meetingsByDate = section.meetings
              ? buildMeetingsByDate(section.meetings)
              : null;
            const absencesByDate = section.absences
              ? buildAbsencesByDate(section.absences, dates)
              : null;

            return (
              <Fragment key={`section-${sectIdx}`}>
                {/* Band header. The TD paints the colored band across
                    the full table width via colspan; an INNER sticky
                    div holds the label so it stays glued to the left
                    viewport edge when the user scrolls horizontally.
                    Doing the sticky on the TD itself doesn't work —
                    `position: sticky` on a colspan'd <td> is unreliable
                    across browsers (the background stays but the inline
                    content scrolls with the table). The inner-div
                    pattern sidesteps that — the div picks up the
                    nearest scrolling ancestor (the outer overflow-x-auto
                    div) and sticks to its left edge correctly. */}
                {section.label !== null && (
                  <tr>
                    <td
                      colSpan={dates.length + 1}
                      className={
                        "bg-brand-50/60 p-0 border-b border-brand-100 "
                        + (sectIdx > 0 ? "border-t-4 border-t-gray-100" : "")
                      }
                    >
                      <div className="sticky left-0 inline-flex items-center px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-brand-800">
                        {section.label}
                      </div>
                    </td>
                  </tr>
                )}
                {grid.slotRows.map((row, rowIdx) => (
                  <tr
                    key={`${sectIdx}|${row.slot_id}|${row.team_role_label ?? ""}`}
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
                          <span className="whitespace-nowrap">
                            {row.display_name}
                          </span>
                          {row.team_role_label && (
                            <span className="whitespace-nowrap text-xs font-normal text-gray-500">
                              {row.team_role_label}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    {dates.map((d) => {
                      const cell = row.cells[d] ?? [];
                      // Sprint 28: a cell is "dismissed" if the admin
                      // marked this (slot, date) as "No aplica". The
                      // dismissal cascades so every row in the cell
                      // shares the flag.
                      const isDismissed =
                        cell.length > 0
                        && cell.every((a) => a.dismissed_at !== null);
                      // Member views (/me/turnos) collapse dismissed
                      // → "this day doesn't apply" so the grid
                      // stays uncluttered. Members don't need to
                      // see the admin's override marker; they just
                      // need to know "no shift for me today" —
                      // same outcome as a weekday the slot doesn't
                      // run. Admin views keep the explicit
                      // strikethrough "No aplica" pill so the
                      // override is visible and clickable to
                      // revert.
                      //
                      // Discriminator: the explicit top-level
                      // `memberView` prop when callers pass it
                      // (which fixes /me/turnos sibling sections
                      // that have no highlight), falling back to
                      // sectionHighlight for legacy single-section
                      // callers that never pass the prop.
                      const isMemberView =
                        memberView ?? sectionHighlight !== null;
                      const isDismissedAdminPill =
                        isDismissed && !isMemberView;
                      const isDismissedAsEmpty = isDismissed && isMemberView;
                      const empty =
                        !isDismissed
                        && (cell.length === 0
                          || cell.every((a) => a.person_id === null));
                      const hasMe =
                        sectionHighlight !== null
                        && cell.some(
                          (a) => a.person_id === sectionHighlight,
                        );
                      const isToday = d === today;
                      const wd = new Date(d).getDay();
                      const isWeekend = wd === 0 || wd === 6;
                      const isHoliday = holidayDates.has(d);
                      const isMyAbsence =
                        highlightAbsenceDates?.has(d) ?? false;
                      const isFlagged =
                        flaggedAssignmentIds
                        && cell.some((a) =>
                          flaggedAssignmentIds.has(a.id),
                        );
                      return (
                        <td
                          key={d}
                          className={
                            "align-top px-1.5 py-2 border-b border-gray-100 "
                            + (isFlagged
                              ? "ring-2 ring-inset ring-rose-400 "
                              : "")
                            + (isDismissedAdminPill
                              ? "bg-gray-100"
                              : empty || isDismissedAsEmpty
                                ? "bg-rose-50/70"
                                : hasMe
                                  ? "bg-brand-50/70"
                                  : isToday
                                    ? "bg-brand-50/30"
                                    : isMyAbsence
                                      ? "bg-emerald-50"
                                      : isHoliday
                                        ? "bg-amber-50"
                                        : isWeekend
                                          ? "bg-slate-100"
                                          : "")
                          }
                        >
                          {isDismissedAdminPill ? (
                            (() => {
                              const a = cell[0];
                              const content = (
                                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 italic line-through">
                                  No aplica
                                </span>
                              );
                              return section.onCellClick ? (
                                <button
                                  type="button"
                                  onClick={() => section.onCellClick!(a)}
                                  className="block w-full text-left hover:bg-gray-200/60 rounded px-0.5"
                                >
                                  {content}
                                </button>
                              ) : (
                                content
                              );
                            })()
                          ) : isDismissedAsEmpty || cell.length === 0 ? (
                            cell.length === 0 && onEmptyCellClick ? (
                              <button
                                type="button"
                                onClick={() =>
                                  onEmptyCellClick({
                                    slot_id: row.slot_id,
                                    team_role_id: row.team_role_id,
                                    slot_name: row.slot_name,
                                    team_role_label: row.team_role_label,
                                    date: d,
                                  })
                                }
                                className="block w-full text-left text-[11px] text-gray-300 hover:text-rose-700 hover:bg-rose-100/60 rounded px-0.5"
                                title="Crear celda Sin cubrir"
                              >
                                —
                              </button>
                            ) : (
                              <span className="text-[11px] text-gray-300">
                                —
                              </span>
                            )
                          ) : (
                            cell.map((a) => {
                              const isMe =
                                sectionHighlight !== null
                                && a.person_id === sectionHighlight;
                              const dim =
                                sectionHighlight !== null
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
                                  {/* Lock icon is admin-only.
                                      Members don't need to know
                                      an admin pinned the shift —
                                      the lock's visible behaviour
                                      for them is "the swap modal
                                      doesn't open", which the
                                      cellIsClickable prop already
                                      enforces. sectionHighlight is
                                      set on /me views and unset
                                      on /admin views — same
                                      discriminator used by the
                                      dismissed-cell render. */}
                                  {a.locked_at
                                    && sectionHighlight === null && (
                                      <LockIcon className="h-3 w-3 text-amber-600 shrink-0" />
                                    )}
                                  {a.swap_offer_id != null && (
                                    <SwapIcon className="h-3 w-3 text-sky-600 shrink-0" />
                                  )}
                                  {a.person_id === null ? (
                                    // Member views (/me/turnos, including
                                    // sibling-team sections on the
                                    // Servicio scope) render a subtle
                                    // dash — "Sin cubrir" in rose is
                                    // admin language and looks alarming
                                    // to a member who can't act on it
                                    // anyway. Admin views keep the
                                    // explicit rose label since the
                                    // admin DOES need to notice + fix.
                                    isMemberView ? (
                                      <span className="text-gray-400">—</span>
                                    ) : (
                                      <span className="text-rose-700 font-medium">
                                        Sin cubrir
                                      </span>
                                    )
                                  ) : (
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
                                sectionInteractive
                                && (section.cellIsClickable
                                  ? section.cellIsClickable(a)
                                  : true);
                              const swapTooltip =
                                a.swap_offer_id != null
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
                                    onClick={() => section.onCellClick!(a)}
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
                    {dates.map((d) => {
                      const items = meetingsByDate.get(d) ?? [];
                      const isToday = d === today;
                      const wd = new Date(d).getDay();
                      const isWeekend = wd === 0 || wd === 6;
                      const isHoliday = holidayDates.has(d);
                      const isMyAbsence =
                        highlightAbsenceDates?.has(d) ?? false;
                      return (
                        <td
                          key={d}
                          className={
                            "align-top px-1.5 py-2 border-b border-t-2 border-b-gray-100 border-t-gray-200 "
                            + (isToday
                              ? "bg-brand-50/20 "
                              : isMyAbsence
                                ? "bg-emerald-50 "
                                : isHoliday
                                  ? "bg-amber-50 "
                                  : isWeekend
                                    ? "bg-slate-100 "
                                    : "")
                          }
                        >
                          {items.length === 0 ? (
                            <span className="text-[11px] text-gray-300">
                              —
                            </span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {items.map((m) => (
                                <button
                                  type="button"
                                  key={`${m.meeting_id}_${m.start_time}`}
                                  onClick={() => setSelectedMeeting(m)}
                                  className="inline-flex w-full flex-col rounded leading-tight text-left -mx-0.5 px-0.5 hover:bg-violet-100/70 transition-colors cursor-pointer"
                                  title="Ver detalles de la reunión"
                                >
                                  <span className="font-medium text-violet-800 truncate">
                                    {m.title}
                                  </span>
                                  <span className="text-[10px] text-violet-600">
                                    {m.start_time.slice(0, 5)}
                                    –{m.end_time.slice(0, 5)}
                                  </span>
                                </button>
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
                    {dates.map((d) => {
                      const absent = absencesByDate.get(d) ?? [];
                      const isToday = d === today;
                      const wd = new Date(d).getDay();
                      const isWeekend = wd === 0 || wd === 6;
                      const isHoliday = holidayDates.has(d);
                      const cellContent =
                        absent.length === 0 ? (
                          <span className="text-[11px] text-gray-300">
                            —
                          </span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {absent.map((m) => {
                              const isMe =
                                sectionHighlight !== null
                                && m.person_id === sectionHighlight;
                              return (
                                <span
                                  key={m.person_id}
                                  className="inline-flex items-center gap-1.5 leading-tight"
                                  title={
                                    BLOCK_LABEL[m.block_type]
                                    ?? m.block_type
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
                        + (isToday
                          ? "bg-brand-50/20 "
                          : isHoliday
                            ? "bg-amber-50 "
                            : isWeekend
                              ? "bg-slate-100 "
                              : "");
                      if (section.onAbsenceCellClick) {
                        return (
                          <td key={d} className={baseCellClass + "p-0"}>
                            <button
                              type="button"
                              onClick={() =>
                                section.onAbsenceCellClick!(d)
                              }
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
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
    {selectedMeeting && (
      <MeetingDetailModal
        meeting={selectedMeeting}
        onClose={() => setSelectedMeeting(null)}
      />
    )}
    </>
  );
}

/** Read-only detail card for a meeting chip. Basic info only — the
 * full edit/manage flow lives on /me/reuniones (and /admin/reuniones
 * for organizers). The backdrop is a real <button> so closing is
 * keyboard-accessible without extra handlers. */
function MeetingDetailModal({
  meeting,
  onClose,
}: {
  meeting: MeetingInstance;
  onClose: () => void;
}) {
  // Anchor at noon so a "YYYY-MM-DD" never slips to the previous day
  // when formatted in the local timezone.
  const dateLabel = new Date(`${meeting.date}T12:00:00`).toLocaleDateString(
    "es-ES",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  );
  const kindLabel =
    meeting.kind === "regular" ? "Reunión periódica" : "Reunión puntual";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl ring-1 ring-gray-200">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
              {kindLabel}
            </span>
            <h2 className="mt-1.5 text-base font-semibold text-gray-900 break-words">
              {meeting.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-gray-500">Fecha</dt>
            <dd className="capitalize text-gray-800">{dateLabel}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-gray-500">Hora</dt>
            <dd className="text-gray-800">
              {meeting.start_time.slice(0, 5)}–{meeting.end_time.slice(0, 5)}
            </dd>
          </div>
          {meeting.location && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-gray-500">Lugar</dt>
              <dd className="text-gray-800 break-words">{meeting.location}</dd>
            </div>
          )}
          {meeting.organizer_name && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-gray-500">Organiza</dt>
              <dd className="text-gray-800">{meeting.organizer_name}</dd>
            </div>
          )}
        </dl>

        {meeting.description && (
          <p className="mt-3 whitespace-pre-wrap border-t border-gray-100 pt-3 text-sm text-gray-700">
            {meeting.description}
          </p>
        )}
      </div>
    </div>
  );
}

function buildMeetingsByDate(meetings: MeetingInstance[]) {
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
}

function buildAbsencesByDate(absences: TeamAbsence[], dates: string[]) {
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
  for (const d of dates) {
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
    /** Team-role id paired with team_role_label. Carried so the
     * "create assignment for empty cell" flow can POST with the
     * right role on team_composition slots. Same value across
     * every cell in this row (rows are keyed by role). */
    team_role_id: number | null;
    display_name: string;
    color: string | null;
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
        team_role_id: a.team_role_id ?? null,
        display_name: a.slot_name,
        color: a.slot_color ?? null,
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
   * leading visual element. "lg" = 56px, used by the directory
   * cards where the avatar is the hero of each card. */
  size?: "sm" | "md" | "lg";
}) {
  const ringClass = mine ? "ring-2 ring-brand-500 ring-offset-1" : "";
  const dimClass =
    size === "lg" ? "h-14 w-14" : size === "md" ? "h-9 w-9" : "h-5 w-5";
  const initialsTextClass =
    size === "lg" ? "text-lg" : size === "md" ? "text-xs" : "text-[9px]";
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

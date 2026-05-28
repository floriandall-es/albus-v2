"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  api,
  type Assignment,
  type MeetingInstance,
  type MeResponse,
  type ServicioTimelineCell,
  type TeamAbsence,
} from "@/lib/api";
import {
  PlanningGrid,
  type PlanningGridSection,
} from "@/components/schedule/planning-grid";
import { formatPeriod } from "@/components/admin/month-picker";
import { Button, EmptyState, ErrorText } from "@/components/admin/ui";
import {
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  LayoutGrid,
  List,
  Network,
  User,
  Users,
} from "lucide-react";
import {
  formatLongDate,
  todayIso as getTodayIso,
} from "@/lib/dates";
import { DayByDayList, ShiftSection } from "@/components/me/shift-list";
import { RequestCoverageModal } from "@/components/me/request-coverage-modal";
import { CalendarExportModal } from "@/components/me/calendar-export-modal";

// Persisted user preferences. The page exposes three orthogonal
// toggles — Ámbito (mine vs equipo), Vista (list vs grid) and
// Rango (3 days, current week, entire month) — so we persist them
// separately. Each combination is valid. localStorage keys kept
// short + namespaced.
const SCOPE_STORAGE_KEY = "trivu.me.turnos.scope";
const VIEW_STORAGE_KEY = "trivu.me.turnos.view";
const RANGE_STORAGE_KEY = "trivu.me.turnos.range";
// Hidden-shift-types filter. Stored as a JSON array of slot ids so
// the choice survives across schedule switches. We store HIDDEN
// rather than VISIBLE ids so the default state (= empty array) is
// "show everything" — that way a new slot the admin adds later
// shows up automatically instead of being silently filtered out.
const HIDDEN_SLOTS_STORAGE_KEY = "trivu.me.turnos.hiddenSlots";
/** Three slices of the same planning data:
 *  - "mine"     = only the caller's own assignments
 *  - "team"     = the entire current tenant's published schedule
 *  - "servicio" = the current tenant's grid plus an extra grid per
 *                 sibling Equipo in the Servicio that shares its
 *                 planning. Only offered when the tenant belongs to a
 *                 Servicio. Replaces the standalone /me/servicio page
 *                 (kept as a redirect for any deep links). */
type Scope = "mine" | "team" | "servicio";
type ViewMode = "list" | "grid";
/** "3d"  = today + next 2 days (rolling window starting today).
 *  "week" = Mon–Sun of the current week.
 *  "month" = full schedule period (the original behaviour). */
type Range = "3d" | "week" | "month";

/** Inclusive YYYY-MM-DD bounds for the active Range relative to
 * `todayIso`. Returns null for "month" — the caller treats null as
 * "no date filter, render the entire selected schedule". */
function computeDateRange(
  range: Range,
  todayIso: string,
): { from: string; to: string } | null {
  if (range === "month") return null;
  const [yy, mm, dd] = todayIso.split("-").map(Number);
  if (range === "3d") {
    const end = new Date(yy, mm - 1, dd);
    end.setDate(end.getDate() + 2);
    return { from: todayIso, to: toIsoLocal(end) };
  }
  // "week" — find Monday of the current week (Spanish convention:
  // Mon = first day of week). getDay() returns 0 for Sunday, 1 for
  // Monday, …, 6 for Saturday. Shift so Mon=0, Sun=6.
  const today = new Date(yy, mm - 1, dd);
  const dow = (today.getDay() + 6) % 7; // 0..6, Mon=0
  const mon = new Date(yy, mm - 1, dd);
  mon.setDate(mon.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return { from: toIsoLocal(mon), to: toIsoLocal(sun) };
}

function toIsoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** First and last day (YYYY-MM-DD) of the calendar month referenced
 * by the schedule's `period` field. Used by Mis turnos to enumerate
 * every day of the month when Rango = "Mes". */
function computeMonthBounds(periodIso: string): { from: string; to: string } {
  const [y, m] = periodIso.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month
  const mm = String(m).padStart(2, "0");
  return {
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** Inclusive enumeration of every YYYY-MM-DD between `from` and
 * `to`. Defensive on the date math (uses local-time Date arithmetic
 * via setDate) so DST transitions can't drop or duplicate days. */
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    out.push(toIsoLocal(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export default function TurnosPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });
  // Read `?scope=servicio` once on mount so the redirect from the
  // retired /me/servicio route lands the user in the right scope
  // without relying on whatever they had stored in localStorage.
  // Any value other than the three valid Scope keys is ignored.
  const searchParams = useSearchParams();
  const scopeFromUrl = searchParams?.get("scope") ?? null;

  // Members see published schedules only.
  const publishedSchedules = useMemo(() => {
    if (!schedules.data) return [];
    return schedules.data.filter((s) => s.status === "published");
  }, [schedules.data]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [swapTarget, setSwapTarget] = useState<Assignment | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Default Ámbito = "mine" and Vista = "list" — the personal
  // upcoming-shifts view is the right answer for ~95% of member
  // visits. The previous single toggle's "Equipo" option mapped
  // to (scope=team, view=grid), so users who liked that combo will
  // still find it via the two toggles. Hydrate both from
  // localStorage with a small effect so SSR can render before the
  // values are read.
  const [scope, setScope] = useState<Scope>("mine");
  const [view, setView] = useState<ViewMode>("list");
  const [range, setRange] = useState<Range>("month");
  const [hiddenSlotIds, setHiddenSlotIds] = useState<Set<number>>(
    () => new Set(),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    // ?scope=… (set by the /me/servicio→/me/turnos redirect) wins
    // over the stored preference for this one render — the user
    // explicitly asked for that scope by clicking the link.
    if (
      scopeFromUrl === "mine"
      || scopeFromUrl === "team"
      || scopeFromUrl === "servicio"
    ) {
      setScope(scopeFromUrl);
      // Persist so a refresh keeps the user on the same scope
      // they were just redirected into.
      window.localStorage.setItem(SCOPE_STORAGE_KEY, scopeFromUrl);
    } else {
      const storedScope = window.localStorage.getItem(SCOPE_STORAGE_KEY);
      if (
        storedScope === "mine"
        || storedScope === "team"
        || storedScope === "servicio"
      ) {
        setScope(storedScope);
      }
    }
    const storedView = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (storedView === "list" || storedView === "grid") {
      setView(storedView);
    } else if (storedView === "team") {
      // Migration: the old toggle stored "list" | "grid", but a
      // very early build briefly used "mine" | "team". Treat the
      // legacy value as scope=team + view=grid (the old "Equipo"
      // option) so returning users land where they expect.
      setView("grid");
      setScope("team");
    }
    const storedRange = window.localStorage.getItem(RANGE_STORAGE_KEY);
    if (
      storedRange === "3d"
      || storedRange === "week"
      || storedRange === "month"
    ) {
      setRange(storedRange);
    }
    // Hidden-slot ids are stored as JSON. Defensively parse — if the
    // stored value is corrupt we silently fall back to "show all"
    // instead of throwing during hydration.
    const storedHidden = window.localStorage.getItem(HIDDEN_SLOTS_STORAGE_KEY);
    if (storedHidden) {
      try {
        const arr = JSON.parse(storedHidden) as unknown;
        if (Array.isArray(arr)) {
          const ids = arr.filter((x): x is number => typeof x === "number");
          if (ids.length > 0) setHiddenSlotIds(new Set(ids));
        }
      } catch {
        // ignored — bad JSON just means "no preference".
      }
    }
    // Mount-only — re-running this on `scopeFromUrl` change would
    // clobber subsequent user toggles for view / range / hiddenSlots
    // by re-reading them from localStorage. The `?scope=…` redirect
    // is a one-shot landing-page handoff, so reading it once is
    // exactly what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setScopePersisted = (s: Scope) => {
    setScope(s);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, s);
    }
  };
  const setViewPersisted = (v: ViewMode) => {
    setView(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    }
  };
  const setRangePersisted = (r: Range) => {
    setRange(r);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RANGE_STORAGE_KEY, r);
    }
  };
  const setHiddenSlotIdsPersisted = (ids: Set<number>) => {
    setHiddenSlotIds(ids);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        HIDDEN_SLOTS_STORAGE_KEY,
        JSON.stringify(Array.from(ids)),
      );
    }
  };

  const downloadPdf = useMutation({
    mutationFn: (id: number) => api.downloadSchedulePdf(id),
  });
  useEffect(() => {
    if (selectedId !== null) return;
    if (publishedSchedules.length === 0) return;
    // Prefer the schedule that covers the CURRENT calendar month —
    // that's almost always what the member wants on first load.
    // Falls back to the most recent published schedule otherwise.
    const todayMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const currentMonth = publishedSchedules.find(
      (s) => s.period.slice(0, 7) === todayMonth,
    );
    setSelectedId((currentMonth ?? publishedSchedules[0]).id);
  }, [publishedSchedules, selectedId]);

  const detail = useQuery({
    queryKey: ["schedule", selectedId],
    queryFn: () => api.getSchedule(selectedId!),
    enabled: selectedId !== null,
  });

  // Per-tenant monthly swap quota — fetched for everyone, since
  // both main team and sub-equipo members can now request swaps.
  const swapQuota = useQuery({
    queryKey: ["my-swap-quota", detail.data?.period],
    queryFn: () => api.getMySwapQuota(detail.data!.period.slice(0, 7)),
    enabled: !!detail.data,
  });

  const holidays = useQuery({
    queryKey: ["holidays-detail", detail.data?.period],
    queryFn: () =>
      api.listHolidays(new Date(detail.data!.period).getFullYear()),
    enabled: !!detail.data,
  });
  const absences = useQuery({
    queryKey: ["team-absences", detail.data?.period],
    queryFn: () => {
      const period = detail.data!.period;
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const from = `${period.slice(0, 7)}-01`;
      const to = `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
      return api.listTeamAbsences({ from, to });
    },
    enabled: !!detail.data,
  });
  // Meeting occurrences for the selected month. The backend filters
  // to meetings the user is in the audience of, so the row only
  // shows reuniones relevant to them.
  const meetingInstances = useQuery({
    queryKey: ["meeting-instances", detail.data?.period],
    queryFn: () => {
      const period = detail.data!.period;
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const from = `${period.slice(0, 7)}-01`;
      const to = `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
      return api.listMeetingInstances(from, to);
    },
    enabled: !!detail.data,
  });
  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  // Cross-equipo Servicio timeline. Only fires when scope === "servicio"
  // AND the caller's tenant actually belongs to a Servicio (rare not
  // to in production, but we guard so single-tenant deployments don't
  // hit a useless 404). Date bounds mirror the active Rango — 3d /
  // Semana / Mes — so the sibling grids cover exactly the same window
  // the user's own grid is showing. When Rango = Mes there's no
  // today-anchored range, so we fall back to the schedule's month.
  const servicioId = me.data?.current_tenant.servicio_id ?? null;
  const servicioBounds = useMemo(() => {
    const r = computeDateRange(range, getTodayIso());
    if (r) return r;
    if (!detail.data) return null;
    const period = detail.data.period;
    const y = Number(period.slice(0, 4));
    const m = Number(period.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      from: `${period.slice(0, 7)}-01`,
      to: `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`,
    };
  }, [range, detail.data]);
  const servicioTimeline = useQuery({
    queryKey: [
      "servicio-timeline",
      servicioId,
      servicioBounds?.from,
      servicioBounds?.to,
    ],
    queryFn: () =>
      api.getServicioTimeline(
        servicioId as number,
        servicioBounds!.from,
        servicioBounds!.to,
      ),
    enabled:
      scope === "servicio"
      && servicioId !== null
      && servicioBounds !== null,
  });

  // ALL hooks must run on every render (Rules of Hooks), so the
  // derivations that depend on the user/schedule live here BEFORE
  // the loading/error early-returns below. Each one uses null-safe
  // accessors against me.data / detail.data so it works during
  // initial render when those queries haven't resolved yet.
  //
  // Rango is anchored on TODAY, not on the selected schedule's
  // period. That's what users intuitively want ("show me this week"
  // means the wall-clock week, regardless of which month they're
  // browsing). If today falls outside the selected schedule's month
  // the filtered range will be empty — the renderers show a
  // "nothing here" state, and the user can switch to Mes entero or
  // pick the schedule that covers today.
  const todayIsoStr = useMemo(() => getTodayIso(), []);
  const dateRange = useMemo(
    () => computeDateRange(range, todayIsoStr),
    [range, todayIsoStr],
  );
  // Pre-filter the assignments fed into the renderer based on the
  // Ámbito + Rango toggles. The list/table components handle "mine
  // vs team" identically — they just render whatever you give them.
  // Doing both filters here keeps each render branch declarative.
  const visibleAssignments = useMemo(() => {
    let rows = detail.data?.assignments ?? [];
    const myPid = me.data?.person.id ?? null;
    if (scope === "mine" && myPid !== null) {
      rows = rows.filter((a) => a.person_id === myPid);
    }
    if (dateRange) {
      rows = rows.filter(
        (a) => a.date >= dateRange.from && a.date <= dateRange.to,
      );
    }
    if (hiddenSlotIds.size > 0) {
      rows = rows.filter((a) => !hiddenSlotIds.has(a.slot_id));
    }
    return rows;
  }, [detail.data, me.data, scope, dateRange, hiddenSlotIds]);

  // Catalogue of slot types present in the currently loaded
  // schedule. Drives the chip row below the toolbar. We derive
  // from the *unfiltered* assignments so toggling a chip off
  // doesn't make it vanish from the chip strip itself. Sorted by
  // slot_position when available, then by name, so the chips read
  // in the same order as the planning grid's rows.
  const slotCatalogue = useMemo(() => {
    const rows = detail.data?.assignments ?? [];
    const byId = new Map<
      number,
      { id: number; name: string; position: number }
    >();
    for (const a of rows) {
      if (!byId.has(a.slot_id)) {
        byId.set(a.slot_id, {
          id: a.slot_id,
          name: a.slot_name,
          position: a.slot_position ?? 0,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return a.name.localeCompare(b.name);
    });
  }, [detail.data]);

  // Full enumerated date list for the Mis-scope "show all days"
  // requirement. For Mes we fall back to the selected schedule's
  // calendar month (computed from period); for 3d/Semana the
  // dateRange bounds already cover what we need. Drives both the
  // day-by-day list and the PlanningGrid forceDates override.
  const allDatesInRange = useMemo(() => {
    if (dateRange) {
      return enumerateDates(dateRange.from, dateRange.to);
    }
    const periodIso = detail.data?.period;
    if (!periodIso) return [];
    const m = computeMonthBounds(periodIso);
    return enumerateDates(m.from, m.to);
  }, [dateRange, detail.data]);

  // My approved absences for the displayed month, used to label
  // off days as "Libre · Vacaciones/Baja/…" instead of just
  // "Sin turno". Filter to the current user; the absences query
  // returns team-wide rows.
  const myAbsences = useMemo(() => {
    const myPid = me.data?.person.id ?? null;
    if (myPid === null) return [];
    return (absences.data ?? []).filter((b) => b.person_id === myPid);
  }, [absences.data, me.data]);

  if (me.isLoading || schedules.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (me.isError) {
    return (
      <p className="text-sm text-red-600">{(me.error as Error).message}</p>
    );
  }
  if (!me.data) return null;

  // me.data is non-null past here, so myPersonId narrows to number.
  // The hooks above received the nullable version via me.data?.person.id;
  // the JSX below uses this narrowed value.
  const myPersonId = me.data.person.id;
  const allSlotsHidden =
    slotCatalogue.length > 0
    && slotCatalogue.every((s) => hiddenSlotIds.has(s.id));

  // "Publicado el X a las Y" timestamp for the currently selected
  const selectedSchedule =
    publishedSchedules.find((s) => s.id === selectedId) ?? null;
  const publishedAtIso = selectedSchedule?.published_at ?? null;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Mis turnos</h1>
        {publishedSchedules.length > 0 && (
          <>
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
            <ScopeToggle
              value={scope}
              onChange={setScopePersisted}
              showServicio={servicioId !== null}
            />
            <ViewToggle value={view} onChange={setViewPersisted} />
            <RangeToggle value={range} onChange={setRangePersisted} />
          </>
        )}
      </div>
      {/* Export actions live on their own line so the toggles row
          stays tight and predictable across viewport widths. On
          mobile this also stops the PDF button from squeezing the
          Tabla/Lista toggle off the edge. */}
      {publishedSchedules.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setCalendarOpen(true)}
            disabled={selectedId === null}
          >
            <CalendarPlus className="h-3.5 w-3.5" />
            Añadir al calendario
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (selectedId !== null) downloadPdf.mutate(selectedId);
            }}
            disabled={selectedId === null || downloadPdf.isPending}
          >
            {downloadPdf.isPending ? "Generando PDF…" : "Descargar PDF"}
          </Button>
        </div>
      )}
      {downloadPdf.isError && (
        <div className="mb-3">
          <ErrorText>{(downloadPdf.error as Error).message}</ErrorText>
        </div>
      )}

      {/* Per-month swap quota pill — visible only when a tenant has
          a cap set AND the user can request swaps (main-team only).
          The number is fetched per displayed month so switching the
          selector above refreshes it. */}
      {swapQuota.data && swapQuota.data.limit !== null && (
        <div className="mb-3 text-xs">
          <span
            className={
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 "
              + (swapQuota.data.used >= swapQuota.data.limit
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-gray-200 bg-gray-50 text-gray-700")
            }
          >
            {swapQuota.data.used} / {swapQuota.data.limit} cambios este mes
            {swapQuota.data.used >= swapQuota.data.limit && (
              <span className="ml-1">· límite alcanzado</span>
            )}
          </span>
        </div>
      )}

      {publishedSchedules.length === 0 && (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title="Aún no hay planificación publicada"
          description="Cuando el responsable publique un mes, lo verás aquí."
        />
      )}

      {/* "Publicado el …" caption — provenance for the data shown
          below. Helps members tell at a glance whether they're
          looking at a fresh publication or an outdated one. */}
      {publishedAtIso && (
        <p className="mb-3 text-xs text-gray-500">
          Publicado el {formatPublishedAt(publishedAtIso)}
        </p>
      )}

      {/* Shift-type chips. Two or more activities = filter is
          useful; one or zero = no point in showing the strip.
          Toggling a chip off removes that slot from every view
          (list and table) and persists across sessions. */}
      {slotCatalogue.length >= 2 && (
        <ShiftTypeFilter
          slots={slotCatalogue}
          hiddenIds={hiddenSlotIds}
          onChange={setHiddenSlotIdsPersisted}
        />
      )}

      {selectedId !== null && detail.isLoading && (
        <p className="text-sm text-gray-500">Cargando planificación…</p>
      )}
      {selectedId !== null && detail.data && allSlotsHidden && (
        <div className="rounded-xl bg-white p-6 ring-1 ring-gray-200 shadow-soft text-sm text-gray-600">
          Has ocultado todas las actividades. Activa al menos una
          arriba para ver los turnos.
        </div>
      )}
      {selectedId !== null && detail.data && !allSlotsHidden && (
        <>
          {/* Servicio scope is inherently a multi-table cross-equipo
              read; the Lista mode (a personal upcoming-shifts feed)
              doesn't translate. Force the grid path when scope ===
              "servicio" regardless of the Lista/Tabla toggle. */}
          {view === "list" && scope !== "servicio" ? (
            scope === "mine" ? (
              // Mis turnos + Lista — one row per day in the active
              // Rango, including off days. Empty days get "Sin turno"
              // (or "Libre · Vacaciones/Baja/…" when an approved
              // absence covers them).
              <DayByDayList
                dates={allDatesInRange}
                myAssignments={visibleAssignments}
                myAbsences={myAbsences}
                todayIso={todayIsoStr}
                onClickShift={(a) => {
                  if (a.locked_at) return;
                  setSwapTarget(a);
                }}
                canRequestCoverage={true}
              />
            ) : (
              <ShiftListView
                assignments={visibleAssignments}
                myPersonId={myPersonId}
                scope={scope}
                range={range}
                onClickShift={(a) => {
                  if (a.locked_at) return;
                  // Coverage requests are only valid for your own
                  // shifts. In team-scope the list shows everyone's
                  // rows; the ShiftRow itself already gates clicks to
                  // your own, so this extra guard is belt-and-braces.
                  if (a.person_id !== myPersonId) return;
                  setSwapTarget(a);
                }}
                canRequestCoverage={true}
              />
            )
          ) : scope === "servicio" ? (
            // Servicio scope renders ONE big sectioned grid: the
            // user's own team's band first, then one band per
            // sibling Equipo that shares its planning. All bands
            // share a single set of date columns, so horizontal
            // scroll moves every team in lockstep and the eye can
            // compare days across teams.
            <ServicioSectionedGrid
              me={me.data!}
              visibleAssignments={visibleAssignments}
              myPersonId={myPersonId}
              absencesData={absences.data}
              meetingsData={meetingInstances.data}
              servicioCells={servicioTimeline.data?.cells ?? []}
              servicioLoading={servicioTimeline.isLoading}
              holidayDates={holidayDates}
              forceDates={allDatesInRange}
              onSwapTarget={setSwapTarget}
            />
          ) : (
            <>
              {visibleAssignments.length === 0 && (
                <div className="rounded-xl bg-white p-6 ring-1 ring-gray-200 shadow-soft text-sm text-gray-600">
                  {emptyCopyFor(scope, range)}
                </div>
              )}
              {visibleAssignments.length > 0 && (
                <PlanningGrid
                  assignments={visibleAssignments}
                  holidayDates={holidayDates}
                  highlightPersonId={myPersonId}
                  onCellClick={(a) => setSwapTarget(a)}
                  cellIsClickable={(a) =>
                    a.person_id === myPersonId
                    && !a.locked_at
                  }
                  // Libre + Reuniones rows are derived from team-wide
                  // data; they only make sense in Equipo scope.
                  // Scope=mine is a personal summary so we skip them
                  // to keep the focus on "what I'm doing".
                  absences={scope === "team" ? absences.data : undefined}
                  meetings={
                    scope === "team" ? meetingInstances.data : undefined
                  }
                  // Mis + Tabla: force every date in the active Rango
                  // as a column, so off days appear as empty cells
                  // next to working days. Equipo + Tabla keeps the
                  // legacy derivation (dates come from assignments).
                  forceDates={
                    scope === "mine" ? allDatesInRange : undefined
                  }
                />
              )}
            </>
          )}
        </>
      )}

      {swapTarget && (
        <RequestCoverageModal
          assignment={swapTarget}
          onClose={() => setSwapTarget(null)}
        />
      )}

      {calendarOpen && (
        <CalendarExportModal
          myAssignments={(detail.data?.assignments ?? []).filter(
            (a) => a.person_id === myPersonId,
          )}
          onClose={() => setCalendarOpen(false)}
        />
      )}
    </>
  );
}

function ScopeToggle({
  value,
  onChange,
  showServicio,
}: {
  value: Scope;
  onChange: (v: Scope) => void;
  /** Whether to render the third "Servicio" option. We hide it when
   * the tenant has no servicio_id (single-tenant deployment or a
   * pre-Phase-A legacy equipo) because clicking it would just yield
   * an empty section. */
  showServicio: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 shadow-sm">
      <button
        type="button"
        onClick={() => onChange("mine")}
        aria-pressed={value === "mine"}
        title="Ver sólo tus turnos"
        className={
          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
          + (value === "mine"
            ? "bg-brand-600 text-white"
            : "text-gray-700 hover:bg-gray-50")
        }
      >
        <User className="h-3.5 w-3.5" />
        Mis turnos
      </button>
      <button
        type="button"
        onClick={() => onChange("team")}
        aria-pressed={value === "team"}
        title="Ver los turnos de todo el equipo"
        className={
          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
          + (value === "team"
            ? "bg-brand-600 text-white"
            : "text-gray-700 hover:bg-gray-50")
        }
      >
        <Users className="h-3.5 w-3.5" />
        Equipo
      </button>
      {showServicio && (
        <button
          type="button"
          onClick={() => onChange("servicio")}
          aria-pressed={value === "servicio"}
          title="Tu equipo + los demás equipos del servicio que comparten su planificación"
          className={
            "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
            + (value === "servicio"
              ? "bg-brand-600 text-white"
              : "text-gray-700 hover:bg-gray-50")
          }
        >
          <Network className="h-3.5 w-3.5" />
          Servicio
        </button>
      )}
    </div>
  );
}

/** Upcasts a flat `ServicioTimelineCell` (cross-tenant wire shape)
 * to a full `Assignment` (per-tenant wire shape) with defaults for
 * the fields the cross-tenant endpoint doesn't carry. Lossy but
 * read-only — sibling grids never interact with the data, so the
 * synthesised id / locked_at / dismissed_at / swap_offer_id / notes /
 * team_role_* fields are fine as nulls. slot_position defaults to 0
 * because the cross-tenant view has no source-of-truth ordering across
 * tenants; PlanningGrid falls back to alphabetical-by-slot-name in
 * that case which is what the previous /me/servicio grid did too. */
function cellToAssignment(
  c: ServicioTimelineCell,
  scheduleId: number,
): Assignment {
  return {
    id: c.assignment_id,
    schedule_id: scheduleId,
    slot_id: c.slot_id,
    slot_name: c.slot_name,
    slot_color: c.slot_color,
    slot_position: 0,
    slot_start_time: c.slot_start_time,
    slot_end_time: c.slot_end_time,
    date: c.date,
    person_id: c.person_id,
    person_name: c.person_name,
    person_first_name: null,
    person_last_name: c.person_last_name,
    person_avatar_url: null,
    team_role_id: null,
    team_role_label: null,
    notes: null,
    locked_at: null,
    locked_by_membership_id: null,
    dismissed_at: null,
    swap_offer_id: null,
  };
}

/** Combines the user's own team's planning + every sibling team's
 * shared planning into ONE big sectioned PlanningGrid. Each team
 * becomes a section with its own band header; all sections share
 * the same date columns so horizontal scroll moves the whole grid
 * in lockstep and column widths line up across teams.
 *
 * Why one big grid instead of N separate tables (which is what we
 * had before): an HTML <table> sizes its columns to its own cell
 * content, so N tables with the same date axis still end up with
 * mismatched widths if one team has long names + another has short
 * names. One table eliminates that entirely. */
function ServicioSectionedGrid({
  me,
  visibleAssignments,
  myPersonId,
  absencesData,
  meetingsData,
  servicioCells,
  servicioLoading,
  holidayDates,
  forceDates,
  onSwapTarget,
}: {
  me: MeResponse;
  visibleAssignments: Assignment[];
  myPersonId: number;
  absencesData: TeamAbsence[] | undefined;
  meetingsData: MeetingInstance[] | undefined;
  servicioCells: ServicioTimelineCell[];
  servicioLoading: boolean;
  holidayDates: Set<string>;
  forceDates: string[];
  onSwapTarget: (a: Assignment) => void;
}) {
  const callerTenantId = me.current_tenant.id;
  const callerTenantName = me.current_tenant.name;

  // Build the section list: caller's own team first (with full
  // chrome — highlight, swap onClick, Libre + Reuniones), then one
  // section per sibling team that shares planning, alphabetised.
  // Sibling sections are read-only; PlanningGrid skips Libre +
  // Reuniones for those because absences/meetings are undefined.
  const sections = useMemo<PlanningGridSection[]>(() => {
    const out: PlanningGridSection[] = [];
    out.push({
      label: (
        <span className="inline-flex items-center gap-2">
          <span className="normal-case text-sm font-semibold text-gray-800 tracking-normal">
            {callerTenantName}
          </span>
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-800">
            Tu equipo
          </span>
        </span>
      ),
      assignments: visibleAssignments,
      absences: absencesData,
      meetings: meetingsData,
      highlightPersonId: myPersonId,
      onCellClick: onSwapTarget,
      cellIsClickable: (a: Assignment) =>
        a.person_id === myPersonId && !a.locked_at,
    });

    // Group sibling cells by tenant.
    const siblingMap = new Map<
      number,
      { tenant_name: string; assignments: Assignment[] }
    >();
    for (const c of servicioCells) {
      if (c.tenant_id === callerTenantId) continue;
      let g = siblingMap.get(c.tenant_id);
      if (!g) {
        g = { tenant_name: c.tenant_name, assignments: [] };
        siblingMap.set(c.tenant_id, g);
      }
      g.assignments.push(cellToAssignment(c, c.schedule_id));
    }
    const siblings = Array.from(siblingMap.entries()).sort((a, b) =>
      a[1].tenant_name.localeCompare(b[1].tenant_name, "es"),
    );
    for (const [, g] of siblings) {
      out.push({
        label: (
          <span className="normal-case text-sm font-semibold text-gray-800 tracking-normal">
            {g.tenant_name}
          </span>
        ),
        assignments: g.assignments,
        // No highlight / onCellClick / absences / meetings — caller
        // isn't a member of this team and the cross-tenant timeline
        // doesn't carry their Libre + Reuniones data.
      });
    }
    return out;
  }, [
    callerTenantId,
    callerTenantName,
    visibleAssignments,
    absencesData,
    meetingsData,
    servicioCells,
    myPersonId,
    onSwapTarget,
  ]);

  // Surface a non-blocking loading note above the grid while the
  // servicio timeline is in flight — the user's own band renders
  // immediately because it's already loaded.
  return (
    <>
      {servicioLoading && (
        <p className="mb-2 text-xs text-gray-500">
          Cargando otros equipos del servicio…
        </p>
      )}
      <PlanningGrid
        sections={sections}
        holidayDates={holidayDates}
        forceDates={forceDates}
      />
    </>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 shadow-sm">
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-pressed={value === "list"}
        title="Ver como lista por fechas"
        className={
          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
          + (value === "list"
            ? "bg-brand-600 text-white"
            : "text-gray-700 hover:bg-gray-50")
        }
      >
        <List className="h-3.5 w-3.5" />
        Lista
      </button>
      <button
        type="button"
        onClick={() => onChange("grid")}
        aria-pressed={value === "grid"}
        title="Ver como tabla mensual"
        className={
          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
          + (value === "grid"
            ? "bg-brand-600 text-white"
            : "text-gray-700 hover:bg-gray-50")
        }
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Tabla
      </button>
    </div>
  );
}

function RangeToggle({
  value,
  onChange,
}: {
  value: Range;
  onChange: (v: Range) => void;
}) {
  const opts: { v: Range; label: string; title: string }[] = [
    { v: "3d", label: "3 días", title: "Hoy y los próximos 2 días" },
    { v: "week", label: "Semana", title: "Esta semana (lunes a domingo)" },
    { v: "month", label: "Mes", title: "Todo el mes publicado" },
  ];
  return (
    <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 shadow-sm">
      <span
        className="inline-flex items-center pl-1.5 pr-1 text-gray-400"
        aria-hidden
      >
        <CalendarRange className="h-3.5 w-3.5" />
      </span>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          title={o.title}
          className={
            "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
            + (value === o.v
              ? "bg-brand-600 text-white"
              : "text-gray-700 hover:bg-gray-50")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ShiftTypeFilter({
  slots,
  hiddenIds,
  onChange,
}: {
  slots: { id: number; name: string }[];
  /** Set of slot ids the user has chosen to HIDE. We track hidden
   * (not visible) ids so the empty-set default = "show all" survives
   * the admin adding new slots later. */
  hiddenIds: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  function toggle(id: number) {
    const next = new Set(hiddenIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  function showAll() {
    onChange(new Set());
  }
  const anyHidden = hiddenIds.size > 0;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-gray-500 mr-1">Actividades:</span>
      {slots.map((s) => {
        const visible = !hiddenIds.has(s.id);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => toggle(s.id)}
            aria-pressed={visible}
            className={
              "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors "
              + (visible
                ? "border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100"
                : "border-gray-300 bg-white text-gray-500 hover:bg-gray-50")
            }
          >
            {s.name}
          </button>
        );
      })}
      {anyHidden && (
        <button
          type="button"
          onClick={showAll}
          className="text-[11px] text-gray-500 hover:text-gray-700 hover:underline ml-1"
        >
          Mostrar todas
        </button>
      )}
    </div>
  );
}

/** "lunes 18 mayo a las 14:32" — long Spanish date + 24h time in the
 * user's local timezone. Used by the "Publicado el …" caption.
 * Defensive: returns the raw iso back if the input can't be parsed. */
function formatPublishedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = formatLongDate(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`,
  );
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${datePart.toLowerCase()} a las ${hh}:${mm}`;
}

/** Empty-state copy in the grid view, parameterised by scope +
 * range so the user knows whether the gap is "you have nothing"
 * or "the team has nothing in this window". */
function emptyCopyFor(scope: Scope, range: Range): string {
  if (scope === "mine") {
    if (range === "3d") return "No tienes turnos en los próximos 3 días.";
    if (range === "week") return "No tienes turnos esta semana.";
    return "No tienes turnos asignados en este mes.";
  }
  if (range === "3d") return "Sin turnos en los próximos 3 días.";
  if (range === "week") return "Sin turnos esta semana.";
  return "No hay turnos publicados para este mes.";
}

function ShiftListView({
  assignments,
  myPersonId,
  scope,
  range,
  onClickShift,
  canRequestCoverage,
}: {
  assignments: Assignment[];
  myPersonId: number;
  /** Drives two things: (a) whether each row needs to show a person
   * avatar/name (Equipo only — in Mis-turnos every row is mine so
   * the name is redundant), and (b) the empty-state copy. */
  scope: Scope;
  /** The active Rango. Used purely for copy (empty-state strings)
   * — the actual date filtering happens upstream so the assignment
   * list arriving here already respects the selected window. */
  range: Range;
  onClickShift: (a: Assignment) => void;
  canRequestCoverage: boolean;
}) {
  const todayIso = useMemo(() => getTodayIso(), []);

  // Sort by date, then slot, then person name so the entries inside
  // each section read predictably regardless of insertion order.
  const sorted = useMemo(
    () =>
      [...assignments].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const bySlot = a.slot_name.localeCompare(b.slot_name);
        if (bySlot !== 0) return bySlot;
        return (a.person_name ?? "").localeCompare(b.person_name ?? "");
      }),
    [assignments],
  );

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl bg-white p-6 ring-1 ring-gray-200 shadow-soft text-sm text-gray-600">
        {emptyCopyFor(scope, range)}
      </div>
    );
  }

  // "Tomorrow" in local time, computed once. Same approach as
  // todayIso — we compare date-only ISO strings so the timezone
  // gotcha doesn't bite.
  const tomorrowIsoStr = (() => {
    const [yy, mm, dd] = todayIso.split("-").map(Number);
    const t = new Date(yy, mm - 1, dd);
    t.setDate(t.getDate() + 1);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  })();

  const today = sorted.filter((a) => a.date === todayIso);
  const tomorrow = sorted.filter((a) => a.date === tomorrowIsoStr);
  const upcoming = sorted.filter((a) => a.date > tomorrowIsoStr);
  const past = sorted.filter((a) => a.date < todayIso);

  // If today, tomorrow AND upcoming are all empty, surface a single
  // friendly note instead of three silent empties. The wording
  // tracks the active Rango so "no próximos" doesn't say "este
  // mes" when the user is looking at a 3-day window.
  const noUpcoming =
    today.length === 0 && tomorrow.length === 0 && upcoming.length === 0;
  const noUpcomingText = (() => {
    if (range === "3d") {
      return scope === "mine"
        ? "No tienes turnos en los próximos 2 días."
        : "Sin turnos en los próximos 2 días.";
    }
    if (range === "week") {
      return scope === "mine"
        ? "No tienes más turnos esta semana."
        : "Sin más turnos esta semana.";
    }
    return scope === "mine"
      ? "No tienes turnos próximos en este mes."
      : "No hay más turnos por venir este mes.";
  })();

  const showPerson = scope === "team";

  return (
    <div className="space-y-4">
      <ShiftSection
        title="Hoy"
        items={today}
        todayIso={todayIso}
        onClickShift={onClickShift}
        canRequestCoverage={canRequestCoverage}
        showPerson={showPerson}
        myPersonId={myPersonId}
      />
      <ShiftSection
        title="Mañana"
        items={tomorrow}
        todayIso={todayIso}
        onClickShift={onClickShift}
        canRequestCoverage={canRequestCoverage}
        showPerson={showPerson}
        myPersonId={myPersonId}
      />
      <ShiftSection
        title="Próximos"
        items={upcoming}
        emptyText={noUpcoming ? noUpcomingText : undefined}
        todayIso={todayIso}
        onClickShift={onClickShift}
        canRequestCoverage={canRequestCoverage}
        showPerson={showPerson}
        myPersonId={myPersonId}
      />
      {past.length > 0 && (
        <ShiftSection
          title="Pasados"
          items={past}
          todayIso={todayIso}
          dimmed
          onClickShift={onClickShift}
          canRequestCoverage={canRequestCoverage}
          showPerson={showPerson}
          myPersonId={myPersonId}
        />
      )}
    </div>
  );
}

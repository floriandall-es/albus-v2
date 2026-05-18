"use client";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";
import { PlanningGrid } from "@/components/schedule/planning-grid";
import { formatPeriod } from "@/components/admin/month-picker";
import { Button, EmptyState, ErrorText } from "@/components/admin/ui";
import { CalendarDays, List, LayoutGrid } from "lucide-react";
import { todayIso as getTodayIso } from "@/lib/dates";
import { ShiftSection } from "@/components/me/shift-list";
import { RequestCoverageModal } from "@/components/me/request-coverage-modal";

// Persisted user preference. localStorage key kept short + namespaced.
const VIEW_STORAGE_KEY = "trivu.me.turnos.view";
type ViewMode = "list" | "grid";

export default function TurnosPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });

  // Team members only see PUBLISHED schedules. Drafts are admin-only —
  // assignments can still change at that stage.
  const publishedSchedules = useMemo(() => {
    if (!schedules.data) return [];
    return schedules.data.filter((s) => s.status === "published");
  }, [schedules.data]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [swapTarget, setSwapTarget] = useState<Assignment | null>(null);
  // View toggle persisted across sessions. Defaults to "list" — the
  // personal upcoming-shifts view is the right answer for ~95% of
  // member visits. Grid stays one click away for the diehards who
  // want the team overview.
  const [view, setView] = useState<ViewMode>("list");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "list" || stored === "grid") setView(stored);
  }, []);
  const setViewPersisted = (v: ViewMode) => {
    setView(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
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
  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  if (me.isLoading || schedules.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (me.isError) {
    return (
      <p className="text-sm text-red-600">{(me.error as Error).message}</p>
    );
  }
  if (!me.data) return null;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
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
            <ViewToggle value={view} onChange={setViewPersisted} />
            <Button
              variant="secondary"
              onClick={() => {
                if (selectedId !== null) downloadPdf.mutate(selectedId);
              }}
              disabled={selectedId === null || downloadPdf.isPending}
            >
              {downloadPdf.isPending ? "Generando PDF…" : "Descargar PDF"}
            </Button>
          </>
        )}
      </div>
      {downloadPdf.isError && (
        <div className="mb-3">
          <ErrorText>{(downloadPdf.error as Error).message}</ErrorText>
        </div>
      )}

      {publishedSchedules.length === 0 && (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title="Aún no hay planificación publicada"
          description="Cuando el responsable publique un mes, lo verás aquí."
        />
      )}

      {selectedId !== null && detail.isLoading && (
        <p className="text-sm text-gray-500">Cargando planificación…</p>
      )}
      {selectedId !== null && detail.data && (
        <>
          {view === "list" ? (
            <PersonalShiftList
              assignments={detail.data.assignments}
              personId={me.data.person.id}
              onClickShift={(a) => {
                if (a.locked_at) return;
                setSwapTarget(a);
              }}
            />
          ) : (
            <>
              <p className="mb-4 text-xs text-gray-500">
                Tus turnos están resaltados en azul. Haz clic en uno
                para pedir cobertura.
              </p>
              <PlanningGrid
                assignments={detail.data.assignments}
                holidayDates={holidayDates}
                highlightPersonId={me.data.person.id}
                onCellClick={(a) => setSwapTarget(a)}
                cellIsClickable={(a) =>
                  a.person_id === me.data!.person.id && !a.locked_at
                }
                absences={absences.data}
              />
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
        title="Ver mis turnos"
        className={
          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
          + (value === "list"
            ? "bg-brand-600 text-white"
            : "text-gray-700 hover:bg-gray-50")
        }
      >
        <List className="h-3.5 w-3.5" />
        Mis turnos
      </button>
      <button
        type="button"
        onClick={() => onChange("grid")}
        aria-pressed={value === "grid"}
        title="Ver planificación completa del equipo"
        className={
          "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors "
          + (value === "grid"
            ? "bg-brand-600 text-white"
            : "text-gray-700 hover:bg-gray-50")
        }
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Equipo
      </button>
    </div>
  );
}

function PersonalShiftList({
  assignments,
  personId,
  onClickShift,
}: {
  assignments: Assignment[];
  personId: number;
  onClickShift: (a: Assignment) => void;
}) {
  // Today's ISO YYYY-MM-DD via shared helper so the personal banner
  // / dashboard / shift list all agree on "today".
  const todayIso = useMemo(() => getTodayIso(), []);

  // Filter to MINE, sort by date+slot for a stable read.
  const mine = useMemo(
    () =>
      assignments
        .filter((a) => a.person_id === personId)
        .sort((a, b) =>
          a.date === b.date
            ? a.slot_name.localeCompare(b.slot_name)
            : a.date.localeCompare(b.date),
        ),
    [assignments, personId],
  );

  if (mine.length === 0) {
    return (
      <div className="rounded-xl bg-white p-6 ring-1 ring-gray-200 shadow-soft text-sm text-gray-600">
        No tienes turnos asignados en este mes.
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

  const today = mine.filter((a) => a.date === todayIso);
  const tomorrow = mine.filter((a) => a.date === tomorrowIsoStr);
  const upcoming = mine.filter((a) => a.date > tomorrowIsoStr);
  const past = mine.filter((a) => a.date < todayIso);

  // If today, tomorrow AND upcoming are all empty, surface a single
  // friendly note instead of three silent empties.
  const noUpcoming =
    today.length === 0 && tomorrow.length === 0 && upcoming.length === 0;

  return (
    <div className="space-y-4">
      <ShiftSection
        title="Hoy"
        items={today}
        todayIso={todayIso}
        onClickShift={onClickShift}
      />
      <ShiftSection
        title="Mañana"
        items={tomorrow}
        todayIso={todayIso}
        onClickShift={onClickShift}
      />
      <ShiftSection
        title="Próximos"
        items={upcoming}
        emptyText={noUpcoming ? "No tienes turnos próximos en este mes." : undefined}
        todayIso={todayIso}
        onClickShift={onClickShift}
      />
      {past.length > 0 && (
        <ShiftSection
          title="Pasados"
          items={past}
          todayIso={todayIso}
          dimmed
          onClickShift={onClickShift}
        />
      )}
    </div>
  );
}

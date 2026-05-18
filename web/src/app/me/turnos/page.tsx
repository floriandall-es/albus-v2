"use client";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";
import { PlanningGrid } from "@/components/schedule/planning-grid";
import { NextShiftBanner } from "@/components/me/next-shift-banner";
import { formatPeriod } from "@/components/admin/month-picker";
import { Button, EmptyState, ErrorText } from "@/components/admin/ui";
import { CalendarDays, List, LayoutGrid, Lock } from "lucide-react";
import {
  MONTH_SHORT_ES,
  WEEKDAY_LONG_ES,
  formatHours,
  formatLongDate,
  todayIso as getTodayIso,
} from "@/lib/dates";

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

function RequestCoverageModal({
  assignment,
  onClose,
}: {
  assignment: Assignment;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      api.createSwapOffer({
        assignment_id: assignment.id,
        notes: notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swap-offers"] });
      onClose();
    },
  });

  const wd = new Date(assignment.date).getUTCDay();
  const dayLabel = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd];
  const dateLabel = `${dayLabel} ${assignment.date.slice(8, 10)}/${assignment.date.slice(5, 7)}/${assignment.date.slice(0, 4)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Pedir cobertura</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <div className="rounded-md bg-gray-50 p-3 text-sm">
            <div className="text-xs text-gray-500">Turno a cubrir</div>
            <div className="font-medium">
              {dateLabel} · {assignment.slot_name}
              {assignment.team_role_label && (
                <span className="text-gray-500">
                  {" "}· {assignment.team_role_label}
                </span>
              )}
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Nota (opcional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Por qué necesitas cobertura, preferencias de cambio, etc."
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          {submit.isError && (
            <p className="text-sm text-red-700">
              {(submit.error as Error).message}
            </p>
          )}

          <p className="text-xs text-gray-500 leading-relaxed">
            Los demás miembros del equipo recibirán un email y podrán
            responder de dos formas:
            <br />·{" "}
            <span className="font-medium text-gray-700">Cubrir</span>{" "}
            — hacen el turno y tú no les debes nada.
            <br />·{" "}
            <span className="font-medium text-gray-700">
              Proponer cambio
            </span>{" "}
            — intercambian este turno por uno suyo.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submit.isPending}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submit.isPending ? "Enviando…" : "Pedir cobertura"}
            </button>
          </div>
        </form>
      </div>
    </div>
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

// WEEKDAY_LONG_ES + MONTH_SHORT_ES live in @/lib/dates now — imported
// at the top of the file. Local copies removed to keep the strings
// in one place.

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

  const upcoming = mine.filter((a) => a.date >= todayIso);
  const past = mine.filter((a) => a.date < todayIso);
  const nextShift = upcoming[0] ?? null;

  return (
    <div className="space-y-4">
      {nextShift && <NextShiftBanner shift={nextShift} />}

      <ShiftSection
        title="Próximos"
        emptyText="No tienes más turnos en este mes."
        items={upcoming}
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

function ShiftSection({
  title,
  items,
  emptyText,
  todayIso,
  dimmed = false,
  onClickShift,
}: {
  title: string;
  items: Assignment[];
  emptyText?: string;
  todayIso: string;
  dimmed?: boolean;
  onClickShift: (a: Assignment) => void;
}) {
  if (items.length === 0) {
    if (!emptyText) return null;
    return (
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </h2>
        <div className="rounded-xl bg-white p-4 ring-1 ring-gray-200 text-sm text-gray-500">
          {emptyText}
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </h2>
      <ul className="divide-y divide-gray-100 rounded-xl bg-white ring-1 ring-gray-200 overflow-hidden">
        {items.map((a) => (
          <ShiftRow
            key={a.id}
            a={a}
            todayIso={todayIso}
            dimmed={dimmed}
            onClick={onClickShift}
          />
        ))}
      </ul>
    </div>
  );
}

function ShiftRow({
  a,
  todayIso,
  dimmed,
  onClick,
}: {
  a: Assignment;
  todayIso: string;
  dimmed: boolean;
  onClick: (a: Assignment) => void;
}) {
  const isToday = a.date === todayIso;
  const isLocked = !!a.locked_at;
  // The list item is a button when clickable (not locked); plain
  // div otherwise. Either way it sits 44px+ tall for touch targets.
  const body = (
    <div className="flex items-center gap-4 px-4 py-3">
      <DateBlock dateIso={a.date} highlight={isToday} dimmed={dimmed} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={
              "text-base font-semibold "
              + (dimmed ? "text-gray-500" : "text-gray-900")
            }
          >
            {a.slot_name}
          </span>
          {a.team_role_label && (
            <span className="text-sm text-gray-500">
              · {a.team_role_label}
            </span>
          )}
          {isLocked && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700"
              title="Turno bloqueado por el administrador"
            >
              <Lock className="h-3 w-3" />
              Bloqueado
            </span>
          )}
        </div>
        <ShiftTimeBadge a={a} inline />
      </div>
      {!isLocked && (
        <span className="hidden sm:inline text-xs text-brand-700 group-hover:underline">
          Pedir cobertura →
        </span>
      )}
    </div>
  );
  if (isLocked) {
    return <li className="bg-white">{body}</li>;
  }
  return (
    <li className="bg-white group hover:bg-brand-50/30 transition-colors">
      <button
        type="button"
        onClick={() => onClick(a)}
        className="block w-full text-left"
        aria-label={`Pedir cobertura para ${a.slot_name} el ${a.date}`}
      >
        {body}
      </button>
    </li>
  );
}

function DateBlock({
  dateIso,
  highlight,
  dimmed,
}: {
  dateIso: string;
  highlight: boolean;
  dimmed: boolean;
}) {
  // Parse local-date safely (avoid the JS Date timezone trap for
  // YYYY-MM-DD strings, which the engine treats as UTC midnight).
  const [yy, mm, dd] = dateIso.split("-").map(Number);
  const d = new Date(yy, mm - 1, dd);
  const weekday = WEEKDAY_LONG_ES[d.getDay()].slice(0, 3);
  const dayNum = String(d.getDate()).padStart(2, "0");
  const monthShort = MONTH_SHORT_ES[d.getMonth()];
  return (
    <div
      className={
        "shrink-0 w-14 text-center rounded-lg border px-1 py-1.5 "
        + (highlight
          ? "border-brand-300 bg-brand-50 text-brand-700"
          : dimmed
            ? "border-gray-200 bg-gray-50 text-gray-400"
            : "border-gray-200 bg-white text-gray-700")
      }
    >
      <div className="text-[10px] uppercase tracking-wide">{weekday}</div>
      <div
        className={
          "text-xl font-bold leading-none "
          + (highlight ? "text-brand-800" : dimmed ? "text-gray-500" : "text-gray-900")
        }
      >
        {dayNum}
      </div>
      <div className="text-[10px] uppercase">{monthShort}</div>
    </div>
  );
}

function ShiftTimeBadge({ a, inline = false }: { a: Assignment; inline?: boolean }) {
  const hours = formatHours(a.slot_start_time, a.slot_end_time);
  if (!hours) return null;
  return (
    <span
      className={
        (inline ? "mt-0.5 block " : "ml-2 inline ") + "text-xs text-gray-500"
      }
    >
      {hours}
    </span>
  );
}

// formatLongDate lives in @/lib/dates now.

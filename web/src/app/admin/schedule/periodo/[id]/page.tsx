"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, Play, Sun } from "lucide-react";
import {
  api,
  type Assignment,
  type Schedule,
  type ScheduleDetail,
} from "@/lib/api";
import { Button, EmptyState, ErrorText } from "@/components/admin/ui";
import { ScheduleSection } from "@/components/schedule/ScheduleSection";
import { BalanceStats } from "@/components/schedule/BalanceStats";
import { formatPeriod } from "@/components/admin/month-picker";

/**
 * "Ver período completo" — one page showing every month of a periodo
 * stacked top-to-bottom, plus ONE aggregated Reparto-por-persona table
 * at the bottom. The entry-point is the button on the periodo group
 * header in /admin/schedule's existing-planificaciones table.
 *
 * Each month is rendered by <ScheduleSection /> which owns the grid,
 * the violations banner, the periodo banner, and all the per-cell
 * editing modals. Cells are fully editable (same powers as the per-
 * month page) provided the underlying schedule is in draft. The
 * BalanceStats at the bottom aggregates assignments across every
 * loaded schedule in the period, keyed by person_id.
 *
 * Missing-month handling: a periodo defines a range that may span
 * months the admin hasn't generated yet. Each such month gets a
 * compact "Aún no generada" row instead of a section.
 */
export default function PeriodoSchedulePage() {
  const params = useParams<{ id: string }>();
  const periodoId = Number(params.id);
  const qc = useQueryClient();
  // Surfaced when the API returns 409 (published/archived month) or
  // any other regenerate error. Lives right under the header strip so
  // the user can see why the click didn't do anything.
  const [generateError, setGenerateError] = useState<string | null>(null);

  const periodo = useQuery({
    queryKey: ["periodo", periodoId],
    queryFn: () => api.getPeriodo(periodoId),
    enabled: !Number.isNaN(periodoId),
  });
  // Schedules list is shared with /admin/schedule (same query key),
  // so navigating in from there doesn't re-fetch. We filter client-
  // side to the touched months — at most a handful of rows per tenant.
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });
  // Team is needed for BalanceStats to sort columns by (categoría, name).
  // Same query key as everywhere else so the cache is shared.
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  // The set of touched months as YYYY-MM-01 strings, in chronological
  // order. Built from periodo.start_date..end_date inclusive.
  const touchedMonths = useMemo(() => {
    if (!periodo.data) return [] as string[];
    return monthsBetween(periodo.data.start_date, periodo.data.end_date);
  }, [periodo.data]);

  // Pair each touched month with its Schedule (if generated). Empty-state
  // rows render for months that have no schedule yet.
  const monthRows = useMemo(() => {
    if (!schedules.data) return [] as { period: string; schedule: Schedule | null }[];
    const byPeriod = new Map<string, Schedule>();
    for (const s of schedules.data) byPeriod.set(s.period, s);
    return touchedMonths.map((period) => ({
      period,
      schedule: byPeriod.get(period) ?? null,
    }));
  }, [schedules.data, touchedMonths]);

  // Year(s) touched by the periodo — used to load the holiday list once
  // per year (most periodos sit in a single year; New-Year spanning
  // periodos hit two). The BalanceStats `holidayDates` is the union.
  const touchedYears = useMemo(() => {
    const ys = new Set<number>();
    for (const period of touchedMonths) {
      ys.add(Number(period.slice(0, 4)));
    }
    return Array.from(ys).sort();
  }, [touchedMonths]);
  const holidayQueries = useQueries({
    queries: touchedYears.map((y) => ({
      queryKey: ["holidays-year", y],
      queryFn: () => api.listHolidays(y),
    })),
  });
  const holidayDates = useMemo(() => {
    const s = new Set<string>();
    for (const q of holidayQueries) {
      for (const h of q.data ?? []) s.add(h.date);
    }
    return s;
  }, [holidayQueries]);

  // One detail fetch per existing schedule so we can aggregate
  // assignments into the combined Reparto. The query key MATCHES
  // the one ScheduleSection uses internally, so we don't double-
  // fetch — both views share the cached ScheduleDetail.
  const existingSchedules = useMemo(
    () => monthRows.filter((r) => r.schedule !== null).map((r) => r.schedule!),
    [monthRows],
  );
  const detailQueries = useQueries({
    queries: existingSchedules.map((s) => ({
      queryKey: ["schedule", s.id],
      queryFn: () => api.getSchedule(s.id),
    })),
  });

  // Flatten every schedule's assignments into a single list for the
  // combined Reparto. BalanceStats is tolerant of multiple schedule_ids
  // in one feed — it aggregates by person_id.
  const allAssignments = useMemo(() => {
    const out: Assignment[] = [];
    for (const q of detailQueries) {
      const d = q.data as ScheduleDetail | undefined;
      if (d) out.push(...d.assignments);
    }
    return out;
  }, [detailQueries]);

  // touchedMonths drives the confirmation copy and the list of detail
  // caches to invalidate after a successful regenerate. Mirrors the
  // logic in PeriodoEditor — same Spanish month labels.
  // Computed BEFORE the early returns below so the hook count stays
  // constant across renders (react-hooks/rules-of-hooks).
  const touchedMonthLabels = useMemo(
    () =>
      touchedMonths.map((period) => {
        const d = new Date(period + "T00:00:00");
        return d.toLocaleDateString("es-ES", {
          month: "long",
          year: "numeric",
        });
      }),
    [touchedMonths],
  );

  // Regenerate every month the periodo touches in one solve. Same
  // contract as the PeriodoEditor's footer button: locked + dismissed
  // cells survive, plain manual edits get overwritten, published or
  // archived months abort with 409.
  // Defined BEFORE the early returns so the hook order is stable
  // across renders. Uses `periodoId` from the route (always defined)
  // rather than `periodo.data.id` so it doesn't depend on the fetch
  // having resolved.
  const regenerate = useMutation({
    mutationFn: () => api.generatePeriodo(periodoId),
    onSuccess: (results) => {
      setGenerateError(null);
      // Refresh the schedules list (new schedules may have been
      // created for previously-empty months) AND each affected
      // schedule's detail + violations cache so the in-page sections
      // re-render with the new assignments.
      qc.invalidateQueries({ queryKey: ["schedules"] });
      for (const r of results) {
        qc.invalidateQueries({ queryKey: ["schedule", r.schedule_id] });
        qc.invalidateQueries({
          queryKey: ["schedule-violations", r.schedule_id],
        });
      }
    },
    onError: (e) => {
      setGenerateError((e as Error).message);
    },
  });

  if (periodo.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (periodo.isError || !periodo.data) {
    return (
      <ErrorText>
        {(periodo.error as Error)?.message ?? "Periodo no encontrado"}
      </ErrorText>
    );
  }

  const p = periodo.data;
  const dateRange = { from: p.start_date, to: p.end_date };
  const balanceDataReady = detailQueries.every((q) => q.data !== undefined);

  return (
    <>
      {/* Page-level chrome. The amber tint matches the rest of the
          periodo UX (PeriodoRow header in /admin/schedule, the
          PeriodoBanner in ScheduleSection, etc.). */}
      <div className="mb-6 rounded-xl border-l-4 border-amber-400 bg-amber-50 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-amber-900">
              <Sun className="h-5 w-5 shrink-0" />
              <h1 className="text-xl font-semibold tracking-tight">
                Período: {p.name}
              </h1>
            </div>
            <p className="mt-1 text-sm text-amber-900/80">
              {formatPeriodoRangeLabel(p.start_date, p.end_date)}
            </p>
          </div>
          {/* Right-aligned button cluster: regenerate (primary) +
              Volver (secondary). The confirm copy spells out the
              preservation contract — locked cells AND "No aplica"
              survive, manual edits without a lock do not, and
              published/archived months will abort the operation. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                if (touchedMonthLabels.length === 0) return;
                const monthList = touchedMonthLabels.join(", ");
                if (
                  confirm(
                    `Esto regenerará ${touchedMonthLabels.length} planificación${touchedMonthLabels.length === 1 ? "" : "es"} (${monthList}). Se conservan las celdas bloqueadas y las marcadas como "No aplica"; los cambios manuales sin candado se sobrescribirán. Si algún mes está publicado o archivado, la operación se detiene. ¿Continuar?`,
                  )
                ) {
                  regenerate.mutate();
                }
              }}
              disabled={regenerate.isPending}
            >
              <Play className="h-4 w-4" />
              {regenerate.isPending ? "Regenerando…" : "Regenerar período"}
            </Button>
            <Link
              href="/admin/schedule"
              className="inline-flex items-center gap-1.5 rounded-lg ring-1 ring-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Link>
          </div>
        </div>
        {generateError && (
          <div className="mt-3">
            <ErrorText>{generateError}</ErrorText>
          </div>
        )}
      </div>

      {/* One block per touched month — either the editable ScheduleSection
          or a small "no generada" row if the admin hasn't generated that
          month yet. The H2 above each block is the month label so the
          admin can navigate by scrolling. */}
      {monthRows.length === 0 && (
        <p className="text-sm text-gray-500">
          Cargando meses del período…
        </p>
      )}
      {monthRows.map(({ period, schedule }) => (
        <section key={period} className="mb-10">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-900 capitalize">
              {formatPeriod(period)}
            </h2>
            {schedule && (
              <Link
                href={`/admin/schedule/${schedule.id}`}
                className="text-xs text-brand-700 underline-offset-2 hover:underline"
              >
                Abrir mes individual →
              </Link>
            )}
          </div>
          {schedule ? (
            // V.1: keep per-section violations banners so the admin
            // sees which month each conflict belongs to. (The period
            // view doesn't try to aggregate them.)
            <ScheduleSection scheduleId={schedule.id} />
          ) : (
            <EmptyState
              title="Aún no generada"
              description={
                "Genera la planificación desde la lista de planificaciones para que aparezca aquí."
              }
            />
          )}
        </section>
      ))}

      {/* Combined Reparto-por-persona — ONE table aggregating every
          loaded schedule's assignments across the periodo's date range.
          We wait for every detail fetch to land before rendering so
          partial counts don't briefly flash misleading numbers. */}
      {existingSchedules.length > 0 && (
        <div className="mt-2 border-t border-gray-200 pt-6">
          <p className="mb-2 text-xs text-gray-500">
            Reparto agregado de los {existingSchedules.length}{" "}
            {existingSchedules.length === 1 ? "mes generado" : "meses generados"} del período.
          </p>
          {balanceDataReady ? (
            <BalanceStats
              assignments={allAssignments}
              holidayDates={holidayDates}
              team={team.data ?? []}
              dateRange={dateRange}
              title={`Reparto por persona · ${p.name}`}
            />
          ) : (
            <p className="text-sm text-gray-500">Cargando reparto…</p>
          )}
        </div>
      )}
    </>
  );
}

// "1 jul – 31 ago 2026" / "20 dic 2026 – 6 ene 2027". Same shape the
// /admin/schedule list uses for the periodo group header so the two
// views read the same way.
function formatPeriodoRangeLabel(startISO: string, endISO: string): string {
  const start = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  const sameYear = start.getFullYear() === end.getFullYear();
  const startLabel = start.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
  const endLabel = end.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${startLabel} – ${endLabel}`;
}

// Inclusive month-step from startISO to endISO. Returns YYYY-MM-01
// strings in chronological order (e.g. ["2026-07-01", "2026-08-01"] for
// a periodo Jul 15 – Aug 31, 2026).
function monthsBetween(startISO: string, endISO: string): string[] {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end) return [];
  const out: string[] = [];
  // Walk in UTC to avoid DST surprises shifting the month boundary.
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}-01`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

function parseISODate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
}

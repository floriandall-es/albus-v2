"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import { NotifyConfirmModal } from "@/components/schedule/NotifyConfirmModal";
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
  const router = useRouter();
  const qc = useQueryClient();
  // Surfaced when the API returns 409 (published/archived month) or
  // any other regenerate / publish / delete error. Lives right under
  // the header strip so the user can see why the click didn't do
  // anything.
  const [actionError, setActionError] = useState<string | null>(null);
  // Which lifecycle action (if any) is in the notify-members modal.
  // Currently only "publish" — Eliminar uses a plain confirm() because
  // it's not a member-visible state change.
  const [confirmingAction, setConfirmingAction] = useState<
    "publish" | null
  >(null);

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

  // Split the flattened list into in-period vs out-of-period. We
  // render two Reparto tables — the first shows the period's
  // numbers, the second shows the leftover days that landed inside
  // the touched months but outside the period itself (e.g. for a
  // Jul 1 – Sept 20 period the second table covers Sept 21–30, all
  // generated as part of the September schedule but governed by the
  // normal config). Pre-filtering at this layer keeps BalanceStats
  // simple — it doesn't need to know about "complement of a range".
  const periodStart = periodo.data?.start_date ?? null;
  const periodEnd = periodo.data?.end_date ?? null;
  const inPeriodAssignments = useMemo(() => {
    if (!periodStart || !periodEnd) return [] as Assignment[];
    return allAssignments.filter(
      (a) => a.date >= periodStart && a.date <= periodEnd,
    );
  }, [allAssignments, periodStart, periodEnd]);
  const outOfPeriodAssignments = useMemo(() => {
    if (!periodStart || !periodEnd) return [] as Assignment[];
    return allAssignments.filter(
      (a) => a.date < periodStart || a.date > periodEnd,
    );
  }, [allAssignments, periodStart, periodEnd]);

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
      setActionError(null);
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
      setActionError((e as Error).message);
    },
  });

  // Drafts in the period are the only schedules Publicar / Eliminar
  // can act on. Published or archived months are left untouched — the
  // single-month page makes the same call (its Publicar/Eliminar
  // buttons only show when status === "draft"). Computed BEFORE the
  // early returns to keep hook order stable.
  const draftSchedules = useMemo(
    () => existingSchedules.filter((s) => s.status === "draft"),
    [existingSchedules],
  );

  // Publish every draft in the period sequentially. Sequential so a
  // mid-loop failure surfaces a coherent error (rather than half the
  // months silently emailing the team) and so we don't fan out N
  // parallel notification roundtrips. notifyMembers is forwarded to
  // each call — one email per published month, same as the single-
  // month flow.
  const publishMany = useMutation({
    mutationFn: async (notifyMembers: boolean) => {
      const ids: number[] = [];
      for (const sched of draftSchedules) {
        await api.publishSchedule(sched.id, notifyMembers);
        ids.push(sched.id);
      }
      return ids;
    },
    onSuccess: (ids) => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["schedules"] });
      for (const id of ids) {
        qc.invalidateQueries({ queryKey: ["schedule", id] });
      }
    },
    onError: (e) => {
      setActionError((e as Error).message);
    },
  });

  // Delete every draft in the period. Like publishMany, runs
  // sequentially so a mid-loop failure leaves the rest intact and
  // surfaces a sensible error. On full success, bounce back to
  // /admin/schedule — the page itself is no longer meaningful once
  // every month is gone, but the periodo config (name, dates,
  // snapshots) survives so the user can regenerate later.
  const removeMany = useMutation({
    mutationFn: async () => {
      for (const sched of draftSchedules) {
        await api.deleteSchedule(sched.id);
      }
    },
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace("/admin/schedule");
    },
    onError: (e) => {
      setActionError((e as Error).message);
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
  const balanceDataReady = detailQueries.every((q) => q.data !== undefined);
  // Label for the out-of-period section header — the union of the
  // gap before the period (touched-month-start..period.start-1) and
  // the gap after (period.end+1..touched-month-end). When the
  // period lines up with month boundaries the union is empty and
  // the section doesn't render at all.
  const outOfPeriodLabel = formatOutOfPeriodLabel(
    touchedMonths,
    p.start_date,
    p.end_date,
  );

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
          {/* Right-aligned button cluster: lifecycle actions on the
              left (Regenerar / Publicar / Eliminar — fan out across
              every draft month), Volver on the right.
              Publicar + Eliminar mirror the single-month page's
              buttons but they only show when the period has at
              least one draft to act on. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
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
            {draftSchedules.length > 0 && (
              <Button
                onClick={() => setConfirmingAction("publish")}
                disabled={publishMany.isPending}
              >
                {publishMany.isPending ? "Publicando…" : "Publicar período"}
              </Button>
            )}
            {draftSchedules.length > 0 && (
              <Button
                variant="danger"
                onClick={() => {
                  const labels = draftSchedules.map((s) => {
                    const d = new Date(s.period + "T00:00:00");
                    return d.toLocaleDateString("es-ES", {
                      month: "long",
                      year: "numeric",
                    });
                  });
                  if (
                    confirm(
                      `¿Eliminar el borrador de ${draftSchedules.length} planificación${draftSchedules.length === 1 ? "" : "es"} (${labels.join(", ")})? Esta acción no se puede deshacer.`,
                    )
                  ) {
                    removeMany.mutate();
                  }
                }}
                disabled={removeMany.isPending}
              >
                {removeMany.isPending ? "Eliminando…" : "Eliminar período"}
              </Button>
            )}
            <Link
              href="/admin/schedule"
              className="inline-flex items-center gap-1.5 rounded-lg ring-1 ring-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Link>
          </div>
        </div>
        {actionError && (
          <div className="mt-3">
            <ErrorText>{actionError}</ErrorText>
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
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-lg font-semibold text-gray-900 capitalize">
                {formatPeriod(period)}
              </h2>
              {/* Equilibrada / Simplificada pill — matches the single
                  month page's header so the admin can tell at a glance
                  which months fell back to the greedy solver. The
                  fallback signals an over-constrained config + means
                  the reparto for that month may be uneven. */}
              {schedule?.solver_used && (
                <span
                  className={
                    "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide "
                    + (schedule.solver_used === "cpsat"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-amber-50 text-amber-800 border border-amber-200")
                  }
                  title={
                    schedule.solver_used === "cpsat"
                      ? "Equilibrada: equidad, descansos y reglas cruzadas aplicadas."
                      : "Simplificada (respaldo): no se pudo equilibrar con todas las reglas activas — la planificación es válida pero el reparto puede ser desigual."
                  }
                >
                  {schedule.solver_used === "cpsat"
                    ? "Equilibrada"
                    : "Simplificada"}
                </span>
              )}
            </div>
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

      {/* Combined Reparto-por-persona — split into two tables.
          First: assignments inside the period. Second (only when
          the period doesn't line up with month boundaries): the
          leftover days of the touched months that fall OUTSIDE
          the period (e.g. for a Jul 1 – Sept 20 period, Sept 21–30
          gets its own table because those days are generated as
          part of the September schedule but governed by the normal
          config, not the period's snapshot).
          We wait for every detail fetch to land before rendering so
          partial counts don't briefly flash misleading numbers. */}
      {existingSchedules.length > 0 && (
        <div className="mt-2 space-y-8 border-t border-gray-200 pt-6">
          <div>
            <p className="mb-2 text-xs text-gray-500">
              Reparto del período (
              {formatPeriodoRangeLabel(p.start_date, p.end_date)}
              ). Las celdas marcadas como &quot;No aplica&quot; no cuentan.
            </p>
            {balanceDataReady ? (
              <BalanceStats
                assignments={inPeriodAssignments}
                holidayDates={holidayDates}
                team={team.data ?? []}
                title={`Reparto por persona · ${p.name}`}
              />
            ) : (
              <p className="text-sm text-gray-500">Cargando reparto…</p>
            )}
          </div>
          {balanceDataReady
            && outOfPeriodAssignments.length > 0
            && outOfPeriodLabel && (
              <div>
                <p className="mb-2 text-xs text-gray-500">
                  Fuera del período ({outOfPeriodLabel}). Estos días
                  se generaron como parte de los meses tocados pero
                  usan la configuración normal, no la del período.
                </p>
                <BalanceStats
                  assignments={outOfPeriodAssignments}
                  holidayDates={holidayDates}
                  team={team.data ?? []}
                  title={`Reparto por persona · fuera del período`}
                />
              </div>
            )}
        </div>
      )}

      {/* Publish-confirm modal — same dialog as the single-month
          page (extracted to NotifyConfirmModal). Talks in plural
          because the period publishes N months in one go. */}
      {confirmingAction === "publish" && (
        <NotifyConfirmModal
          title="Publicar período"
          description={
            draftSchedules.length === 1
              ? "La planificación quedará visible para todos los miembros del equipo en \"Mis turnos\"."
              : `Las ${draftSchedules.length} planificaciones del período quedarán visibles para todos los miembros del equipo en "Mis turnos".`
          }
          confirmLabel="Publicar"
          notifyLabel="Avisar por email a los miembros del equipo"
          onClose={() => setConfirmingAction(null)}
          onConfirm={(notify) => {
            publishMany.mutate(notify, {
              onSuccess: () => setConfirmingAction(null),
            });
          }}
          isPending={publishMany.isPending}
        />
      )}
    </>
  );
}

// Build a label for the out-of-period days inside the touched months.
// For a period 1 jul – 20 sept across [Jul, Aug, Sept], the touched
// window is Jul 1 – Sept 30 and the out-of-period span is Sept 21 –
// Sept 30 (one trailing segment). A period that starts mid-month
// would also have a leading segment (e.g. Jul 1 – Jul 14).
//
// Returns null when the period covers full months exactly, signalling
// the caller to skip rendering the second Reparto table altogether.
function formatOutOfPeriodLabel(
  touchedMonths: string[],
  periodStartISO: string,
  periodEndISO: string,
): string | null {
  if (touchedMonths.length === 0) return null;
  // Touched window = first day of first touched month → last day of
  // last touched month. Parsed in UTC to dodge DST surprises.
  const firstMonth = parseISODate(touchedMonths[0]);
  const lastMonthFirst = parseISODate(touchedMonths[touchedMonths.length - 1]);
  if (!firstMonth || !lastMonthFirst) return null;
  // Last day of last touched month: jump to next month, subtract one day.
  const nextMonth = new Date(lastMonthFirst);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCDate(0);
  const touchedStart = toISO(firstMonth);
  const touchedEnd = toISO(nextMonth);

  const segments: string[] = [];
  if (periodStartISO > touchedStart) {
    // Leading gap: touchedStart .. periodStart - 1 day.
    const ps = parseISODate(periodStartISO);
    if (ps) {
      const beforeEnd = new Date(ps);
      beforeEnd.setUTCDate(beforeEnd.getUTCDate() - 1);
      segments.push(
        formatPeriodoRangeLabel(touchedStart, toISO(beforeEnd)),
      );
    }
  }
  if (periodEndISO < touchedEnd) {
    // Trailing gap: periodEnd + 1 day .. touchedEnd.
    const pe = parseISODate(periodEndISO);
    if (pe) {
      const afterStart = new Date(pe);
      afterStart.setUTCDate(afterStart.getUTCDate() + 1);
      segments.push(
        formatPeriodoRangeLabel(toISO(afterStart), touchedEnd),
      );
    }
  }
  if (segments.length === 0) return null;
  return segments.join(" · ");
}

function toISO(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

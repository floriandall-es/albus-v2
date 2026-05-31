"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  personLastName,
  type CalendarEntry,
  type CalendarPersonOut,
  type StatsCalendarResponse,
  type StatsMonthlyRow,
  type StatsKpis,
  type StatsRow,
  type StatsWorkloadRow,
} from "@/lib/api";
import {
  Card,
  EmptyState,
  PageHeader,
} from "@/components/admin/ui";
import { PulseStats } from "@/components/admin/pulse-stats";
import {
  MonthPicker,
  isoFromMonthYear,
} from "@/components/admin/month-picker";
import { useAccentPalette } from "@/lib/use-accent";
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Printer,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";

// Slot palette fallback — slots without an admin-picked color rotate
// through this for chart legibility. The teal entry gets swapped at
// render time for the caller's accent (via useAccentPalette) so the
// fallback respects the user's preference.
const FALLBACK_PALETTE = [
  "#0d9488", // teal — replaced with the user's accent at render time
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f43f5e", // rose
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#64748b", // slate
];

function monthsBetween(fromIso: string, toIso: string): string[] {
  // Returns YYYY-MM strings between the two ISO month-firsts, inclusive.
  const out: string[] = [];
  const start = new Date(fromIso + "T00:00:00Z");
  const end = new Date(toIso + "T00:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    out.push(
      `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`,
    );
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

/** Gini coefficient of a list of non-negative values. Returns
 *  null when input is empty or the sum is zero — both mean
 *  "no carga to distribute", so no fairness number is meaningful.
 *
 *  0 = perfect equality (every value equal)
 *  1 = maximum inequality (one value carries the whole sum)
 *
 *  Standard formula via the sorted-cumulative shortcut:
 *      G = 2·Σ(i·x_i) / (n·Σx_i)  −  (n+1)/n
 *  with i ∈ [1..n] and x_i sorted ascending. Numerically stable
 *  for the team sizes we expect (≤ a few hundred). */
function computeGini(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum === 0) return null;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    weighted += (i + 1) * sorted[i];
  }
  const g = (2 * weighted) / (n * sum) - (n + 1) / n;
  // Clamp tiny negative rounding to 0 so the UI never shows -0.00.
  return Math.max(0, g);
}

function lastDayOfMonthIso(yyyyMm01: string): string {
  // yyyyMm01 is "YYYY-MM-01" — return YYYY-MM-(last day).
  const y = Number(yyyyMm01.slice(0, 4));
  const m = Number(yyyyMm01.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yyyyMm01.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

// Tabs reorganise the page around the three questions admins
// actually arrive with: ¿estamos cubriendo?, ¿es justo?, ¿quién hizo
// qué? Plus a Resumen landing for the at-a-glance read. The previous
// single-scroll layout interleaved answers to all three and made the
// page feel undifferentiated. Tab state syncs to ?tab=… so deep-links
// from emails / shared URLs land on the right view.
type TabKey =
  | "resumen"
  | "carga"
  | "equidad"
  | "cobertura"
  | "eficiencia"
  | "pulso"
  | "detalle";
const TABS: { key: TabKey; label: string }[] = [
  { key: "resumen", label: "Resumen" },
  { key: "carga", label: "Carga" },
  { key: "equidad", label: "Equidad" },
  { key: "cobertura", label: "Cobertura" },
  { key: "eficiencia", label: "Eficiencia" },
  { key: "pulso", label: "Pulso" },
  { key: "detalle", label: "Detalle" },
];
function isTabKey(s: string | null): s is TabKey {
  return (
    s === "resumen"
    || s === "carga"
    || s === "equidad"
    || s === "cobertura"
    || s === "eficiencia"
    || s === "pulso"
    || s === "detalle"
  );
}

export default function StatsPage() {
  const today = new Date();
  // Default: YTD — Jan 1 of the current year through the current month.
  const [fromPeriod, setFromPeriod] = useState<string>(
    isoFromMonthYear(0, today.getFullYear()),
  );
  const [toPeriod, setToPeriod] = useState<string>(
    isoFromMonthYear(today.getMonth(), today.getFullYear()),
  );
  const fromDate = fromPeriod; // YYYY-MM-01
  const toDate = lastDayOfMonthIso(toPeriod);

  // Tab state + URL sync. Reading ?tab= on mount lets us deep-link
  // straight into a specific view; writing back on change keeps the
  // URL honest as the user clicks around.
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialTab: TabKey = isTabKey(searchParams.get("tab"))
    ? (searchParams.get("tab") as TabKey)
    : "resumen";
  const [tab, setTabState] = useState<TabKey>(initialTab);
  const setTab = (next: TabKey) => {
    setTabState(next);
    const params = new URLSearchParams(
      Array.from(searchParams.entries()),
    );
    params.set("tab", next);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  // Print flow. Clicking the Imprimir button stages every tab's
  // content (the gate becomes `tab === "xxx" || printAll`), waits
  // a frame for React to render, then opens the browser's native
  // print/save-as-PDF dialog. The `afterprint` event flips
  // printAll back so the page returns to single-tab view. Print
  // CSS in admin/layout.tsx already hides the sidebar + mobile
  // top bar so the printed pages start with the page header.
  const [printAll, setPrintAll] = useState(false);
  useEffect(() => {
    const onAfter = () => setPrintAll(false);
    window.addEventListener("afterprint", onAfter);
    return () => window.removeEventListener("afterprint", onAfter);
  }, []);
  const onPrint = () => {
    setPrintAll(true);
    // Two RAFs + a small timeout so React commits the all-tabs
    // render before window.print() captures the layout. Without
    // this delay the print dialog opens with only the currently-
    // active tab.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => window.print(), 50);
      });
    });
  };

  const q = useQuery({
    queryKey: ["stats-assignments", fromDate, toDate],
    queryFn: () => api.statsAssignments({ from: fromDate, to: toDate }),
  });
  // Commit 1 of the stats overhaul. One round-trip payload for the
  // KPI strip + equity histogram + coverage trend + monthly mini-
  // charts. Cached separately from the per-slot detail so each
  // refetches on its own schedule.
  const ov = useQuery({
    queryKey: ["stats-overview", fromDate, toDate],
    queryFn: () => api.statsOverview({ from: fromDate, to: toDate }),
  });
  // Commit 3 — calendar heat map. Fetched lazily under its own
  // query so the dashboard top half paints first; the heat map
  // lives further down the page and an admin who only cares
  // about KPIs doesn't pay the cost of the sparse day-grid
  // payload while scrolling.
  const cal = useQuery({
    queryKey: ["stats-calendar", fromDate, toDate],
    queryFn: () => api.statsCalendar({ from: fromDate, to: toDate }),
  });
  // Per-user accent: swap the default teal slot in the fallback
  // palette for the caller's pick.
  const palette = useAccentPalette(FALLBACK_PALETTE);

  // Categoría filter. Drives the equity histogram + per-slot charts +
  // detail table. Does NOT scope the KPI strip / coverage trend /
  // monthly trends — those stay tenant-wide because a jefe filtering
  // to "Adjuntos" still cares about service-level coverage gaps and
  // operational tempo.
  const [activeCategoryIds, setActiveCategoryIds] = useState<
    Set<number | null> | null
  >(null);
  const categoryOptions = useMemo(() => {
    const m = new Map<number | null, string>();
    for (const w of ov.data?.workload ?? []) {
      m.set(w.category_id, w.category_name ?? "Sin categoría");
    }
    return Array.from(m.entries()).sort((a, b) =>
      String(a[1]).localeCompare(String(b[1]), "es"),
    );
  }, [ov.data]);
  // When the data loads, seed the filter to "all selected" so the
  // initial render shows everything. We use a Set<number | null> so
  // members with no categoría land in their own bucket.
  const effectiveActiveCategoryIds = useMemo(() => {
    if (activeCategoryIds !== null) return activeCategoryIds;
    return new Set(categoryOptions.map(([id]) => id));
  }, [activeCategoryIds, categoryOptions]);
  // Person IDs that pass the categoría filter. Used to scope the
  // per-slot rows (StatsResponse doesn't carry category, so we
  // resolve through the workload payload).
  const personIdsByCategoryFilter = useMemo(() => {
    if (!ov.data) return null;
    const ids = new Set<number>();
    for (const w of ov.data.workload) {
      if (effectiveActiveCategoryIds.has(w.category_id)) ids.add(w.person_id);
    }
    return ids;
  }, [ov.data, effectiveActiveCategoryIds]);

  const scopedRows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (personIdsByCategoryFilter === null) return all;
    return all.filter((r) => personIdsByCategoryFilter.has(r.person_id));
  }, [q.data, personIdsByCategoryFilter]);

  // Commit 2 — per-person drill-down. State for which person's side
  // panel is open. Null = panel closed. Set by clicking any per-person
  // bar in the page (per-slot chart, weekend chart, equity outlier
  // callouts) — see onPersonClick wiring below.
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(
    null,
  );
  const selectedPerson = useMemo(() => {
    if (selectedPersonId === null) return null;
    return (
      ov.data?.workload.find((w) => w.person_id === selectedPersonId) ?? null
    );
  }, [selectedPersonId, ov.data]);

  // Pivot rows by slot for chart legends + color mapping.
  const slotMeta = useMemo(() => {
    // Sprint 17: chart key is (slot_id, team_role_id) so team_composition
    // slots split into one chart per sub-role. The key string mirrors
    // what BalanceStats uses on the schedule detail.
    type ChartMeta = {
      key: string;
      slot_id: number;
      slot_name: string;
      team_role_id: number | null;
      team_role_label: string | null;
      color: string;
    };
    const m = new Map<string, ChartMeta>();
    let idx = 0;
    for (const r of scopedRows) {
      const key = `${r.slot_id}|${r.team_role_id ?? ""}`;
      if (m.has(key)) continue;
      m.set(key, {
        key,
        slot_id: r.slot_id,
        slot_name: r.slot_name,
        team_role_id: r.team_role_id,
        team_role_label: r.team_role_label,
        color:
          r.slot_color
          ?? palette[idx % palette.length],
      });
      idx += 1;
    }
    return Array.from(m.values()).sort((a, b) => {
      const byName = a.slot_name.localeCompare(b.slot_name);
      if (byName !== 0) return byName;
      if (a.team_role_label === null && b.team_role_label !== null) return -1;
      if (a.team_role_label !== null && b.team_role_label === null) return 1;
      return (a.team_role_label ?? "").localeCompare(b.team_role_label ?? "");
    });
  }, [scopedRows, palette]);

  // Chart: per (person, month) weekend/holiday counts. Stacked by month
  // the same way per-slot charts are.
  const weekendData = useMemo(() => {
    const months = monthsBetween(fromDate, toDate);
    const byPid = new Map<
      number,
      { person: string; total: number; cells: Record<string, number> }
    >();
    for (const r of scopedRows) {
      if (r.weekend_or_holiday_count === 0) continue;
      let row = byPid.get(r.person_id);
      if (!row) {
        row = { person: personLastName({ name: r.person_name }), total: 0, cells: {} };
        byPid.set(r.person_id, row);
      }
      row.cells[r.year_month] =
        (row.cells[r.year_month] ?? 0) + r.weekend_or_holiday_count;
      row.total += r.weekend_or_holiday_count;
    }
    const list = Array.from(byPid.values()).map((p) => {
      const out: Record<string, number | string> = {
        person: p.person,
        total: p.total,
      };
      for (const m of months) out[m] = p.cells[m] ?? 0;
      return out;
    });
    list.sort((a, b) => (b.total as number) - (a.total as number));
    return { list, months };
  }, [scopedRows, fromDate, toDate]);

  const weekendShades = useMemo(
    () => shadeStops("#f59e0b", weekendData.months.length),
    [weekendData.months.length],
  );
  // Same trailing-empty-month workaround as PerSlotChart — anchor the
  // total label to the last bar with actual data so Recharts doesn't
  // skip the LabelList on a zero-width segment.
  const weekendLastIdx = useMemo(() => {
    for (let i = weekendData.months.length - 1; i >= 0; i--) {
      const m = weekendData.months[i];
      if (weekendData.list.some((r) => (r[m] as number) > 0)) return i;
    }
    return -1;
  }, [weekendData]);

  const totalAssignments = useMemo(
    () => scopedRows.reduce((acc, r) => acc + r.count, 0),
    [scopedRows],
  );

  // Per-month per-categoría aggregate. q.rows is (person, slot,
  // month) so we resolve categoría by joining on workload and
  // then sum counts. Output is shaped for MonthlyLineChart:
  // one entry per categoría with a points map {YYYY-MM → count}.
  // Categorías sorted alphabetically so the legend is stable.
  const cargaPorCategoriaPorMes = useMemo(() => {
    if (!q.data || !ov.data) return null;
    const personCategory = new Map<number, string>();
    for (const w of ov.data.workload) {
      personCategory.set(w.person_id, w.category_name ?? "Sin categoría");
    }
    const seen = new Set<string>();
    const pointsByCategory: Record<string, Record<string, number>> = {};
    for (const r of q.data.rows) {
      const cat = personCategory.get(r.person_id) ?? "Sin categoría";
      seen.add(cat);
      if (!pointsByCategory[cat]) pointsByCategory[cat] = {};
      pointsByCategory[cat][r.year_month] =
        (pointsByCategory[cat][r.year_month] ?? 0) + r.count;
    }
    const categories = Array.from(seen).sort((a, b) =>
      a.localeCompare(b, "es"),
    );
    return { categories, pointsByCategory };
  }, [q.data, ov.data]);

  // "Lo que destaca" insights for the Resumen landing — a small
  // hard-coded rules engine that converts raw stats into 1-4
  // ranked headlines an admin can act on. Warnings rank above
  // neutrals which rank above positives; the slice(0,4) keeps the
  // panel scannable. Recomputed only when overview or per-row
  // data changes.
  const insights = useMemo(
    () => computeInsights(ov.data, q.data?.rows ?? []),
    [ov.data, q.data],
  );

  return (
    <>
      <PageHeader title="Estadísticas" />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-72">
          <MonthPicker label="Desde" value={fromPeriod} onChange={setFromPeriod} />
        </div>
        <div className="w-72">
          <MonthPicker label="Hasta" value={toPeriod} onChange={setToPeriod} />
        </div>
        {q.data && (
          <div className="text-xs text-gray-500 pb-2">
            {totalAssignments} asignaciones · {slotMeta.length} actividades
            · planificaciones publicadas y archivadas.
          </div>
        )}
        {/* Push the print button to the right of whatever else
            sits in the toolbar. Hidden in print itself so the
            output doesn't carry the button. */}
        <div className="ml-auto pb-1 print:hidden">
          <button
            type="button"
            onClick={onPrint}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            title="Abre el diálogo del navegador para imprimir o guardar como PDF"
          >
            <Printer className="h-4 w-4" />
            Imprimir / PDF
          </button>
        </div>
      </div>

      {/* Categoría filter — sits at the top so it reads as a
          page-wide scope, not a per-section thing. Applies to the
          equity histogram, the calendar heat map, the per-slot
          detail charts and the detail table. Does NOT scope the
          KPI strip / categoría rollup / coverage trend / monthly
          trends — those are service-level views by design (a jefe
          filtering to "Adjuntos" still wants to see whether the
          schedule has uncovered shifts overall). Hidden when the
          tenant has ≤1 categoría. */}
      {categoryOptions.length > 1 && (
        <div className="mb-4">
          <CategoryFilterChips
            options={categoryOptions}
            active={effectiveActiveCategoryIds}
            onToggle={(id) => {
              const next = new Set(effectiveActiveCategoryIds);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setActiveCategoryIds(next);
            }}
            onAll={() =>
              setActiveCategoryIds(
                new Set(categoryOptions.map(([id]) => id)),
              )
            }
          />
        </div>
      )}

      {/* Tab nav. Lives between the page-wide filters and the
          tab content so the date range + categoría chip read as
          global scope, and the tab nav reads as "pick which
          question I'm answering". Hidden in print — the printed
          output stacks every tab's content top to bottom so the
          nav is meaningless on paper. */}
      <div className="print:hidden">
        <StatsTabNav active={tab} onChange={setTab} />
      </div>

      {/* ----- RESUMEN ------------------------------------------ */}
      {/* Landing tab — three hero KPIs + "Lo que destaca"
          auto-curated highlights. The insights panel ranks
          warnings above neutrals above positives so the first
          thing an admin reads is whatever needs their attention. */}
      {(tab === "resumen" || printAll) && ov.data && (
        <div className="mb-8 space-y-6">
          <KpiStrip
            kpis={ov.data.kpis}
            monthsCount={monthsBetween(fromDate, toDate).length}
            workload={ov.data.workload}
          />
          <InsightsPanel insights={insights} onJumpTab={setTab} />
        </div>
      )}

      {/* ----- EQUIDAD ------------------------------------------ */}
      {/* "¿Es justo?" — everything that compares person-against-
          person. Categoría rollup, FTE-normalised equity panel,
          raw-count leaderboard, calendar heatmap, weekend
          distribution. Carga answers the team-level "how much"
          question; Equidad answers "is it distributed fairly". */}
      {(tab === "equidad" || printAll) && (
        <div className="space-y-6">
          {ov.data && (
            <>
              {/* Categoría rollup — donut + per-categoría comparison.
                  Hidden when the tenant has ≤1 categoría (the donut would
                  be a single 100% slice and the bars one row). For mixed-
                  composition services this is THE primary view at scale. */}
              {categoryOptions.length > 1 && (
                <CategoriaRollup
                  workload={ov.data.workload}
                  palette={palette}
                />
              )}
              <EquityPanel
                workload={ov.data.workload}
                activeCategoryIds={effectiveActiveCategoryIds}
                accent={palette[0]}
                onPersonClick={setSelectedPersonId}
              />
              <TurnosPorPersona
                workload={ov.data.workload}
                accent={palette[0]}
                onPersonClick={setSelectedPersonId}
              />
            </>
          )}
          {/* Calendar heat map. Scales naturally — each person is
              one ~16px row, so a 100-member team is a 1600px-tall
              scrollable panel. The page-level categoría filter
              scopes which persons appear here. */}
          {cal.data
            && (cal.data.entries.length > 0 || cal.data.persons.length > 0) && (
              <CalendarHeatmap
                data={cal.data}
                accent={palette[0]}
                personIdsFilter={personIdsByCategoryFilter}
                onPersonClick={setSelectedPersonId}
              />
            )}
          {/* Weekend / festivos burden per person — fairness lens
              on the weekend distribution. */}
          {q.data && scopedRows.length > 0 && (
            <WeekendChart
              data={weekendData}
              shades={weekendShades}
              lastIdx={weekendLastIdx}
            />
          )}
        </div>
      )}

      {/* ----- CARGA ------------------------------------------- */}
      {/* "¿Cuánta carga tiene el equipo a lo largo del tiempo?"
          — three full-size line charts, all month-by-month so
          admins can read tempo, peaks, and trends at a glance.
          Per-categoría breakdown surfaces whether one tier is
          carrying more than another over time. */}
      {(tab === "carga" || printAll) && (
        <div className="space-y-6">
          {ov.data && (
            <MonthlyLineChart
              title="Turnos del equipo por mes"
              subtitle="Total de asignaciones publicadas / archivadas en cada mes."
              months={monthsBetween(fromDate, toDate)}
              series={[
                {
                  key: "total",
                  label: "Turnos",
                  color: palette[0],
                  points: Object.fromEntries(
                    ov.data.monthly.map((m) => [
                      m.year_month,
                      m.total_assignments,
                    ]),
                  ),
                },
              ]}
            />
          )}
          {q.data && ov.data && cargaPorCategoriaPorMes && (
            <MonthlyLineChart
              title="Turnos por categoría profesional, por mes"
              subtitle="Una línea por categoría — quién carga con la actividad cada mes."
              months={monthsBetween(fromDate, toDate)}
              series={cargaPorCategoriaPorMes.categories.map((cat, i) => ({
                key: cat,
                label: cat,
                color: palette[i % palette.length],
                points: cargaPorCategoriaPorMes.pointsByCategory[cat],
              }))}
            />
          )}
          {ov.data && (
            <MonthlyLineChart
              title="Bloqueos del equipo por mes"
              subtitle="Días de libranza aprobados (vacaciones, baja, formación...) en cada mes."
              months={monthsBetween(fromDate, toDate)}
              series={[
                {
                  key: "bloqueos",
                  label: "Días bloqueados",
                  color: "#f59e0b",
                  points: Object.fromEntries(
                    ov.data.monthly.map((m) => [
                      m.year_month,
                      m.bloqueos_days,
                    ]),
                  ),
                },
              ]}
            />
          )}
          {!ov.data && (
            <p className="text-sm text-gray-500">Cargando…</p>
          )}
        </div>
      )}

      {/* ----- COBERTURA --------------------------------------- */}
      {/* "¿Estamos cubriendo?" — the coverage rate over time.
          Activity volume trends moved to Carga (they answer
          "how much" not "are we getting it done"). What's left
          here is the single most important coverage question:
          how is the % covered evolving. */}
      {(tab === "cobertura" || printAll) && (
        <div className="space-y-6">
          {ov.data && (
            <>
              <CoverageTrend monthly={ov.data.monthly} accent={palette[0]} />
            </>
          )}
          {!ov.data && (
            <p className="text-sm text-gray-500">Cargando…</p>
          )}
        </div>
      )}

      {/* ----- EFICIENCIA ------------------------------------- */}
      {/* "¿Funciona bien el proceso?" — process-health signals
          across the period. Reaperturas, incidencias, cambios de
          turno y tasa de cobertura entre compañeros. Admin manual
          edits to assignments aren't tracked yet (would need an
          audit table); when that lands it'll surface here. */}
      {(tab === "eficiencia" || printAll) && ov.data && (
        <div className="space-y-6">
          <EficienciaPanel kpis={ov.data.kpis} />
        </div>
      )}

      {/* ----- PULSO ------------------------------------------ */}
      {/* "¿Cómo se siente el equipo?" — weekly survey results.
          Lives here so admins find sentiment alongside the other
          team metrics; question catalogue + on/off toggle stays
          on /admin/pulso. The pulso route doesn't depend on the
          date-range picker — the survey has its own weekly
          cadence. */}
      {(tab === "pulso" || printAll) && (
        <div className="space-y-6">
          <PulseStats />
        </div>
      )}

      {/* ----- DETALLE ----------------------------------------- */}
      {/* "¿Quién hizo qué?" — per-slot charts + full detail
          table. Drives the per-person side panel when the admin
          clicks a person bar in any of the charts. */}
      {(tab === "detalle" || printAll) && (
        <div className="space-y-6">
          {q.isLoading && (
            <p className="text-sm text-gray-500">Cargando…</p>
          )}
          {q.data && scopedRows.length === 0 && (
            <EmptyState
              icon={<BarChart3 className="h-5 w-5" />}
              title="Sin datos en el rango seleccionado"
              description="Solo se contabilizan asignaciones de planificaciones publicadas o archivadas."
            />
          )}
          {q.data && scopedRows.length > 0 && (
            <>
              <h2 className="mt-2 text-base font-semibold text-gray-800">
                Detalle por actividad
              </h2>
              <p className="-mt-3 text-xs text-gray-500">
                Vista compacta de las actividades del periodo. Pulsa una fila
                para abrir su gráfico mensual por persona.
              </p>
              <SlotOverviewAccordion
                slotMeta={slotMeta}
                rows={scopedRows}
                months={monthsBetween(fromDate, toDate)}
                onPersonClick={setSelectedPersonId}
              />
              <DetailTable rows={scopedRows} slotMeta={slotMeta} />
            </>
          )}
        </div>
      )}

      {/* Per-person side panel — page-level overlay, opens from
          a click on any per-person bar regardless of which tab
          is active. Closes via X or backdrop. */}
      {selectedPerson && (
        <PersonDetailPanel
          person={selectedPerson}
          rows={q.data?.rows ?? []}
          months={monthsBetween(fromDate, toDate)}
          accent={palette[0]}
          onClose={() => setSelectedPersonId(null)}
        />
      )}
    </>
  );
}

// Tab nav at the top of /admin/stats. Same visual idiom as
// other in-page tab strips in the app (light border-bottom,
// brand accent on the active tab).
function StatsTabNav({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (next: TabKey) => void;
}) {
  return (
    <div className="mb-6 border-b border-gray-200">
      <nav className="-mb-px flex gap-6">
        {TABS.map((t) => {
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              className={
                "border-b-2 px-1 py-2.5 text-sm font-medium transition-colors "
                + (isActive
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300")
              }
            >
              {t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ===========================================================================
// "Lo que destaca" — auto-curated insights on the Resumen tab
// ===========================================================================
// Small rules engine that converts raw overview/per-row data into
// 1-4 ranked headlines an admin can act on. Each rule emits at most
// one insight; the panel renders the top 4 by priority.
//
// Priorities (lower = shown higher):
//   10  uncovered_count > 0           — warning
//   20  reopened_schedules_count > 0  — warning
//   30  workload outlier (top > 1.3× avg) — warning
//   40  weekend outlier (top > 1.4× avg)  — neutral
//   50  swap_offers_fulfilled > 0     — success
//   90  fallback "nothing remarkable" — neutral
//
// Adding a new rule = bump priorities to leave room and append.

type InsightTone = "warning" | "success" | "neutral";
type InsightIcon =
  | "AlertTriangle"
  | "RefreshCw"
  | "TrendingUp"
  | "Calendar"
  | "CheckCircle2"
  | "Sparkles";

type Insight = {
  priority: number;
  tone: InsightTone;
  icon: InsightIcon;
  headline: string;
  sub?: string;
  /** If set, the panel renders a "Ver →" link that switches to
   *  the named tab so admins can act on the insight in one click. */
  jumpTab?: TabKey;
};

function computeInsights(
  ov: { kpis: StatsKpis; workload: StatsWorkloadRow[] } | undefined,
  rows: StatsRow[],
): Insight[] {
  if (!ov) return [];
  const out: Insight[] = [];

  // Uncovered shifts — operational alarm.
  if (ov.kpis.uncovered_count > 0) {
    out.push({
      priority: 10,
      tone: "warning",
      icon: "AlertTriangle",
      headline: `${ov.kpis.uncovered_count} turnos sin cubrir en el periodo`,
      sub:
        ov.kpis.total_assignments > 0
          ? `${ov.kpis.uncovered_pct}% del total. Revisa en Cobertura qué actividades concentran los huecos.`
          : undefined,
      jumpTab: "cobertura",
    });
  }

  // Reopened schedules — process smell.
  if (ov.kpis.reopened_schedules_count > 0) {
    out.push({
      priority: 20,
      tone: "warning",
      icon: "RefreshCw",
      headline: `${ov.kpis.reopened_schedules_count} planificaciones reabiertas tras publicar`,
      sub: "Las reaperturas indican cambios reactivos. Mira el detalle por mes en Cobertura.",
      jumpTab: "cobertura",
    });
  }

  // Workload outlier — top loaded person > 1.3× equipo avg.
  // Compare on normalized_total (FTE-adjusted, what each person
  // WOULD do at 100% FTE) so a part-timer working their fair
  // share doesn't get flagged as overloaded against full-timers,
  // and a full-timer working part-time's load doesn't get a free
  // pass. Threshold is empirical: under 1.3× and the histogram
  // still looks balanced enough that calling someone out is noise.
  if (ov.workload.length >= 3) {
    const sorted = [...ov.workload].sort(
      (a, b) => b.normalized_total - a.normalized_total,
    );
    const top = sorted[0];
    const avg =
      ov.workload.reduce((s, w) => s + w.normalized_total, 0)
      / ov.workload.length;
    if (avg > 0 && top.normalized_total > avg * 1.3) {
      const pct = Math.round((top.normalized_total / avg - 1) * 100);
      out.push({
        priority: 30,
        tone: "warning",
        icon: "TrendingUp",
        headline: `${personLastName({ name: top.person_name })} tiene ${pct}% más carga que la media (ajustada por FTE)`,
        sub: `${top.total_shifts} turnos. Mira el histograma completo en Equidad.`,
        jumpTab: "equidad",
      });
    }
  }

  // Gini of FTE-normalised load. 0.30 is empirical — past that
  // the histogram on Equidad usually shows visible asymmetry
  // worth surfacing as a headline rather than waiting for the
  // admin to scroll there.
  if (ov.workload.length >= 4) {
    const gini = computeGini(
      ov.workload.map((w) => w.normalized_total).filter((v) => v > 0),
    );
    if (gini !== null && gini > 0.3) {
      out.push({
        priority: 35,
        tone: "warning",
        icon: "TrendingUp",
        headline: `Carga desigual entre el equipo (Gini ${gini.toFixed(2)})`,
        sub: "El equipo tiene un reparto desigual de turnos (ajustado por FTE). Mira el histograma en Equidad.",
        jumpTab: "equidad",
      });
    }
  }

  // Weekend / festivos outlier — same shape as workload but on the
  // weekend_or_holiday_count axis. Threshold a touch higher (1.4×)
  // because weekend distribution is naturally lumpier than total
  // workload (some people genuinely volunteer for more).
  if (rows.length > 0) {
    const weMap = new Map<number, { name: string; total: number }>();
    for (const r of rows) {
      if (r.weekend_or_holiday_count === 0) continue;
      const cur = weMap.get(r.person_id);
      if (cur) cur.total += r.weekend_or_holiday_count;
      else
        weMap.set(r.person_id, {
          name: r.person_name,
          total: r.weekend_or_holiday_count,
        });
    }
    const weList = Array.from(weMap.values()).sort(
      (a, b) => b.total - a.total,
    );
    if (weList.length >= 3) {
      const top = weList[0];
      const avg = weList.reduce((s, w) => s + w.total, 0) / weList.length;
      if (avg > 0 && top.total > avg * 1.4) {
        out.push({
          priority: 40,
          tone: "neutral",
          icon: "Calendar",
          headline: `${personLastName({ name: top.name })} concentra fines de semana y festivos`,
          sub: `${top.total} en el periodo · media: ${avg.toFixed(1)}.`,
          // Carga now owns the weekend chart (volume question);
          // Equidad keeps the fairness histogram + heatmap.
          jumpTab: "carga",
        });
      }
    }
  }

  // Positive: swap activity. Fulfilled swaps = team self-organising
  // without escalating to admin, which is a health signal worth
  // celebrating.
  if (ov.kpis.swap_offers_fulfilled > 0) {
    out.push({
      priority: 50,
      tone: "success",
      icon: "CheckCircle2",
      headline: `${ov.kpis.swap_offers_fulfilled} cambios de turno resueltos entre compañeros`,
      sub: "El equipo resolviendo cambios sin pasar por ti es señal de salud operativa.",
    });
  }

  // Fallback when no rule fires — keeps the panel from being empty
  // on a brand-new tenant or a quiet period.
  if (out.length === 0) {
    out.push({
      priority: 90,
      tone: "neutral",
      icon: "Sparkles",
      headline: "Sin nada destacable en este periodo",
      sub: "No hay huecos sin cubrir, reaperturas ni desequilibrios fuertes.",
    });
  }

  return out.sort((a, b) => a.priority - b.priority).slice(0, 4);
}

function InsightsPanel({
  insights,
  onJumpTab,
}: {
  insights: Insight[];
  onJumpTab: (tab: TabKey) => void;
}) {
  if (insights.length === 0) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-gray-800">
        Lo que destaca
      </h2>
      <div className="space-y-2">
        {insights.map((ins, i) => (
          <InsightRow key={i} insight={ins} onJumpTab={onJumpTab} />
        ))}
      </div>
    </div>
  );
}

function InsightRow({
  insight,
  onJumpTab,
}: {
  insight: Insight;
  onJumpTab: (tab: TabKey) => void;
}) {
  const tone = TONE_STYLES[insight.tone];
  const Icon = ICON_MAP[insight.icon];
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border ${tone.border} ${tone.bg} px-4 py-3`}
    >
      <div
        className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tone.iconBg} ${tone.iconFg}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium ${tone.headline}`}>
          {insight.headline}
        </div>
        {insight.sub && (
          <div className="mt-0.5 text-xs text-gray-600 leading-relaxed">
            {insight.sub}
          </div>
        )}
      </div>
      {insight.jumpTab && (
        <button
          type="button"
          onClick={() => onJumpTab(insight.jumpTab as TabKey)}
          className={`shrink-0 text-xs font-medium ${tone.link} hover:underline`}
        >
          Ver →
        </button>
      )}
    </div>
  );
}

const TONE_STYLES: Record<
  InsightTone,
  {
    border: string;
    bg: string;
    iconBg: string;
    iconFg: string;
    headline: string;
    link: string;
  }
> = {
  warning: {
    border: "border-amber-200",
    bg: "bg-amber-50/70",
    iconBg: "bg-amber-100",
    iconFg: "text-amber-700",
    headline: "text-amber-900",
    link: "text-amber-800",
  },
  success: {
    border: "border-emerald-200",
    bg: "bg-emerald-50/70",
    iconBg: "bg-emerald-100",
    iconFg: "text-emerald-700",
    headline: "text-emerald-900",
    link: "text-emerald-800",
  },
  neutral: {
    border: "border-gray-200",
    bg: "bg-gray-50",
    iconBg: "bg-gray-100",
    iconFg: "text-gray-600",
    headline: "text-gray-800",
    link: "text-brand-700",
  },
};

const ICON_MAP = {
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  Calendar,
  CheckCircle2,
  Sparkles,
} as const;

// ===========================================================================
// MonthlyLineChart — generic over-time chart used across Carga
// ===========================================================================
// Single or multi-line line chart over a fixed list of YYYY-MM
// months. Caller supplies one or more series (key/label/color
// plus a {month → value} map); component handles axis, tooltip,
// legend, and missing-month gaps (treated as 0).

type MonthlySeries = {
  key: string;
  label: string;
  color: string;
  /** Map of YYYY-MM → numeric value. Missing months render as 0. */
  points: Record<string, number>;
};

function MonthlyLineChart({
  title,
  subtitle,
  months,
  series,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  months: string[];
  series: MonthlySeries[];
}) {
  // Pivot to Recharts shape: one row per month, one column per
  // series. Months come pre-sorted from monthsBetween().
  const data = useMemo(
    () =>
      months.map((m) => {
        const row: Record<string, string | number> = { month: m };
        for (const s of series) row[s.key] = s.points[m] ?? 0;
        return row;
      }),
    [months, series],
  );
  // Hide legend for single-series charts — the title already
  // describes what's plotted, and the legend swatch is just noise.
  const showLegend = series.length > 1;
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart
          data={data}
          margin={{ top: 12, right: 20, left: 0, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fill: "#4b5563" }}
            tickFormatter={shortMonthLabel}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#4b5563" }}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              fontSize: 12,
              border: "1px solid #e5e7eb",
              borderRadius: 8,
            }}
            labelFormatter={(v) => longMonthLabel(String(v))}
          />
          {showLegend && (
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="line" />
          )}
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// Short axis label: "ene 26" — fits in a tight bottom axis.
function shortMonthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-");
  const months = [
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "sep",
    "oct",
    "nov",
    "dic",
  ];
  const idx = Number(m) - 1;
  return `${months[idx] ?? m} ${y.slice(2)}`;
}

// Longer label for tooltip: "enero 2026".
function longMonthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-");
  const months = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  const idx = Number(m) - 1;
  return `${months[idx] ?? m} ${y}`;
}

// ===========================================================================
// Carga tab — volume-focused (distinct from Equidad which is fairness)
// ===========================================================================

/** Aggregate team workload grouped by professional categoría
 *  (Adjuntos, Residentes, Enfermería...). Per-categoría TOTALS
 *  — no per-person breakdown. The point is "how much volume
 *  does each tier handle" at the service level, not who within
 *  the tier did what. */
function CargaPorCategoria({
  workload,
  palette,
}: {
  workload: StatsWorkloadRow[];
  palette: string[];
}) {
  const aggregated = useMemo(() => {
    const m = new Map<
      string,
      { label: string; shifts: number; people: number }
    >();
    for (const w of workload) {
      const key = w.category_name ?? "Sin categoría";
      const cur = m.get(key);
      if (cur) {
        cur.shifts += w.total_shifts;
        cur.people += 1;
      } else {
        m.set(key, {
          label: key,
          shifts: w.total_shifts,
          people: 1,
        });
      }
    }
    return Array.from(m.values()).sort((a, b) => b.shifts - a.shifts);
  }, [workload]);
  const max = Math.max(1, ...aggregated.map((c) => c.shifts));
  if (aggregated.length === 0) {
    return (
      <ChartCard
        title="Carga por categoría profesional"
        subtitle="Suma de turnos del equipo agrupada por categoría."
      >
        <p className="text-sm text-gray-500">
          Sin asignaciones en el periodo.
        </p>
      </ChartCard>
    );
  }
  return (
    <ChartCard
      title="Carga por categoría profesional"
      subtitle="Suma de turnos del equipo agrupada por categoría."
    >
      <div className="space-y-2">
        {aggregated.map((cat, i) => {
          const pct = (cat.shifts / max) * 100;
          const color = palette[i % palette.length];
          return (
            <div key={cat.label} className="flex items-center gap-3">
              <span className="w-44 shrink-0 truncate text-sm text-gray-800">
                {cat.label}
                <span className="ml-1 text-[11px] text-gray-500">
                  · {cat.people}{" "}
                  {cat.people === 1 ? "persona" : "personas"}
                </span>
              </span>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-gray-100">
                <div
                  className="h-full"
                  style={{ width: `${pct}%`, backgroundColor: color }}
                />
              </div>
              <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">
                {cat.shifts.toLocaleString("es-ES")}
              </span>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}

/** Horizontal-bar leaderboard of total shifts per person in the
 *  selected range. Raw counts (NOT FTE-normalised) — the point
 *  here is volume: "who did how much". Equidad answers the
 *  comparable fairness question with FTE normalisation. */
function TurnosPorPersona({
  workload,
  accent,
  onPersonClick,
}: {
  workload: StatsWorkloadRow[];
  accent: string;
  onPersonClick?: (id: number) => void;
}) {
  const sorted = useMemo(
    () =>
      [...workload].sort((a, b) => b.total_shifts - a.total_shifts),
    [workload],
  );
  const max = Math.max(1, ...sorted.map((w) => w.total_shifts));
  if (sorted.length === 0) {
    return (
      <ChartCard
        title="Turnos totales por persona"
        subtitle="Recuento absoluto en el rango seleccionado."
      >
        <p className="text-sm text-gray-500">
          Sin asignaciones en el periodo.
        </p>
      </ChartCard>
    );
  }
  return (
    <ChartCard
      title="Turnos totales por persona"
      subtitle="Recuento absoluto en el rango. Pulsa una fila para ver el detalle de la persona."
    >
      <div className="space-y-1">
        {sorted.map((w) => {
          const pct = (w.total_shifts / max) * 100;
          return (
            <button
              key={w.person_id}
              type="button"
              onClick={() => onPersonClick?.(w.person_id)}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-gray-50 transition-colors"
            >
              <span className="w-36 shrink-0 truncate text-sm text-gray-800">
                {personLastName({ name: w.person_name })}
                {w.category_name && (
                  <span className="ml-1 text-[11px] text-gray-500">
                    · {w.category_name}
                  </span>
                )}
              </span>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-gray-100">
                <div
                  className="h-full"
                  style={{ width: `${pct}%`, backgroundColor: accent }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">
                {w.total_shifts.toLocaleString("es-ES")}
              </span>
            </button>
          );
        })}
      </div>
    </ChartCard>
  );
}

/** Horizontal-bar breakdown of libranza days by type (vacaciones,
 *  baja, formación, personal, otros). Reads from the existing
 *  kpis.bloqueos_days_by_type — no new backend work. */
function BloqueosPorTipo({
  byType,
  total,
}: {
  byType: Record<string, number>;
  total: number;
}) {
  const entries = useMemo(
    () =>
      Object.entries(byType)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]),
    [byType],
  );
  const max = Math.max(1, ...entries.map(([, n]) => n));
  // Color per type so admins recognise them at a glance — matched
  // to the rest of the app's bloqueo treatments (sick=rose, etc.).
  const TYPE_COLOR: Record<string, string> = {
    vacation: "#0d9488", // teal
    sick: "#f43f5e", // rose
    training: "#3b82f6", // blue
    personal: "#8b5cf6", // violet
    other: "#64748b", // slate
  };
  return (
    <ChartCard
      title="Libranzas por tipo"
      subtitle={
        total > 0
          ? `${total} días en total en el rango.`
          : "Sin libranzas aprobadas en el periodo."
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500">
          No hay días de libranza registrados en el rango.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map(([type, days]) => {
            const pct = (days / max) * 100;
            const color = TYPE_COLOR[type] ?? "#64748b";
            const label = BLOQUEO_LABEL_BY_TYPE[type] ?? type;
            return (
              <div
                key={type}
                className="flex items-center gap-3"
              >
                <span className="w-32 shrink-0 text-sm capitalize text-gray-800">
                  {label}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded bg-gray-100">
                  <div
                    className="h-full"
                    style={{ width: `${pct}%`, backgroundColor: color }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">
                  {days} {days === 1 ? "día" : "días"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}

/** Weekend / festivos burden — extracted out of the old inline
 *  block in the page so it can render on Carga (volume) without
 *  duplicating ~80 lines of Recharts wiring. Data shape is the
 *  weekendData useMemo built at the top of the page. */
function WeekendChart({
  data,
  shades,
  lastIdx,
}: {
  data: { list: Record<string, string | number>[]; months: string[] };
  shades: string[];
  lastIdx: number;
}) {
  return (
    <ChartCard
      title={
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          Fines de semana y festivos
        </span>
      }
      subtitle="Sábado, domingo o festivo · barras apiladas por mes (más oscuro = mes más reciente)."
    >
      {data.list.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nadie ha trabajado fines de semana o festivos en este rango.
        </p>
      ) : (
        <ResponsiveContainer
          width="100%"
          height={Math.max(180, data.list.length * 36 + 60)}
        >
          <BarChart
            data={data.list}
            layout="vertical"
            margin={{ top: 8, right: 44, left: 60, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: "#4b5563" }}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="person"
              tick={{ fontSize: 11, fill: "#4b5563" }}
              width={120}
            />
            <Tooltip
              cursor={{ fill: "rgba(245,158,11,0.08)" }}
              contentStyle={{
                fontSize: 12,
                border: "1px solid #e5e7eb",
                borderRadius: 8,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {data.months.map((m, i) => (
              <Bar
                key={m}
                dataKey={m}
                stackId="we"
                fill={shades[i]}
                name={m}
              >
                <LabelList
                  dataKey={m}
                  position="center"
                  fill={textColorForBg(shades[i])}
                  formatter={labelFormatter}
                  style={{ fontSize: 11, fontWeight: 600 }}
                />
                {i === lastIdx && (
                  <LabelList
                    dataKey="total"
                    position="right"
                    fill="#1f2937"
                    formatter={labelFormatter}
                    style={{ fontSize: 11, fontWeight: 700 }}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// ===========================================================================
// Eficiencia tab — process-health signals
// ===========================================================================
// Four KPI tiles + a small swap-breakdown card. Everything comes
// from the existing /stats/overview payload — no new backend
// endpoints. Admin manual edits to assignments aren't tracked
// today (assignments table has no audit history); when that
// becomes a priority, add a `schedule_audit` table on the backend
// and surface a fifth tile here.
function EficienciaPanel({ kpis }: { kpis: StatsKpis }) {
  const swapTotal =
    kpis.swap_offers_open
    + kpis.swap_offers_fulfilled
    + kpis.swap_offers_cancelled;
  // Coverage rate: of the swap offers that closed (fulfilled or
  // cancelled), what % were covered by a colleague? Open offers
  // are excluded from the denominator because they haven't
  // resolved one way or the other yet.
  const swapResolved = kpis.swap_offers_fulfilled + kpis.swap_offers_cancelled;
  const coverageRate =
    swapResolved > 0
      ? Math.round((kpis.swap_offers_fulfilled / swapResolved) * 100)
      : null;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Reaperturas"
          value={kpis.reopened_schedules_count.toLocaleString("es-ES")}
          hint="Planificaciones reabiertas tras publicar. Cada reapertura suele indicar un cambio reactivo."
          tone={kpis.reopened_schedules_count > 0 ? "warning" : "neutral"}
        />
        <KpiTile
          label="Incidencias"
          value={kpis.incidents_count.toLocaleString("es-ES")}
          hint="Entradas registradas en el log de incidencias del servicio."
        />
        <KpiTile
          label="Cambios solicitados"
          value={swapTotal.toLocaleString("es-ES")}
          hint="Total de cambios de turno propuestos por el equipo en el periodo."
        />
        <KpiTile
          label="Cobertura entre compañeros"
          value={coverageRate !== null ? `${coverageRate}%` : "—"}
          hint={
            swapResolved > 0
              ? "% de cambios cerrados que cubrió otro miembro (cubiertos / cerrados). Alto = equipo se auto-organiza."
              : "Sin cambios cerrados en el periodo."
          }
          tone={
            coverageRate !== null && coverageRate < 60 ? "warning" : "neutral"
          }
        />
      </div>

      {/* Breakdown of swap-offer states. Useful even when the
          headline coverage rate is fine — admins can spot a high
          "abiertos" count (backlog forming) before it shows up
          as a coverage problem. */}
      {swapTotal > 0 && (
        <ChartCard
          title="Estado de los cambios de turno"
          subtitle="Desglose de los cambios propuestos en el periodo."
        >
          <div className="space-y-2">
            <SwapStateRow
              label="Cubiertos"
              value={kpis.swap_offers_fulfilled}
              total={swapTotal}
              color="#10b981"
            />
            <SwapStateRow
              label="Abiertos"
              value={kpis.swap_offers_open}
              total={swapTotal}
              color="#f59e0b"
            />
            <SwapStateRow
              label="Cancelados"
              value={kpis.swap_offers_cancelled}
              total={swapTotal}
              color="#9ca3af"
            />
          </div>
        </ChartCard>
      )}

      {swapTotal === 0
        && kpis.incidents_count === 0
        && kpis.reopened_schedules_count === 0 && (
          <Card>
            <div className="p-5 text-sm text-gray-600">
              Sin incidencias, reaperturas ni cambios de turno en el periodo.
              El proceso ha ido limpio.
            </div>
          </Card>
        )}
    </>
  );
}

function SwapStateRow({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-sm text-gray-800">{label}</span>
      <div className="relative h-5 flex-1 overflow-hidden rounded bg-gray-100">
        <div
          className="h-full"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-800">
        {value.toLocaleString("es-ES")}
        <span className="ml-1 text-[11px] font-normal text-gray-500">
          {Math.round(pct)}%
        </span>
      </span>
    </div>
  );
}

// ===========================================================================
// SlotOverviewAccordion — per-slot overview + click-to-expand
// ===========================================================================
// Replaces the previous "stack every PerSlotChart vertically" layout
// on the Detalle tab. With 10+ slots that was a 4000px scroll. Now
// each slot is a single compact row (color dot + name + bar + total)
// that the admin can click to expand the existing PerSlotChart
// inline. Multiple rows can be open at once so admins can compare.

type SlotMeta = {
  key: string;
  slot_id: number;
  slot_name: string;
  team_role_id: number | null;
  team_role_label: string | null;
  color: string;
};

function SlotOverviewAccordion({
  slotMeta,
  rows,
  months,
  onPersonClick,
}: {
  slotMeta: SlotMeta[];
  rows: StatsRow[];
  months: string[];
  onPersonClick?: (personId: number) => void;
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());

  // Per-slot totals across all rows in the period — drives the mini
  // bar widths (scaled to the busiest slot) and the right-aligned
  // count.
  const slotTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.slot_id}|${r.team_role_id ?? ""}`;
      m.set(k, (m.get(k) ?? 0) + r.count);
    }
    return m;
  }, [rows]);
  const maxTotal = useMemo(
    () => Math.max(1, ...Array.from(slotTotals.values())),
    [slotTotals],
  );

  const toggle = (k: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {slotMeta.map((slot, i) => {
        const total = slotTotals.get(slot.key) ?? 0;
        const isOpen = openKeys.has(slot.key);
        const pct = (total / maxTotal) * 100;
        return (
          <div
            key={slot.key}
            className={i > 0 ? "border-t border-gray-100" : ""}
          >
            <button
              type="button"
              onClick={() => toggle(slot.key)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50"
            >
              <ChevronRight
                className={
                  "h-4 w-4 shrink-0 text-gray-400 transition-transform "
                  + (isOpen ? "rotate-90" : "")
                }
              />
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: slot.color }}
              />
              <span className="min-w-0 flex-1 text-sm font-medium text-gray-800">
                <span className="truncate">{slot.slot_name}</span>
                {slot.team_role_label && (
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    · {slot.team_role_label}
                  </span>
                )}
              </span>
              <div className="hidden h-2 w-32 overflow-hidden rounded-full bg-gray-100 sm:block">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: slot.color,
                  }}
                />
              </div>
              <span className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-700">
                {total.toLocaleString("es-ES")}
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-gray-100 bg-gray-50/40 p-4">
                <PerSlotChart
                  slot={slot}
                  rows={rows}
                  months={months}
                  onPersonClick={onPersonClick}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
        )}
        <div className="mt-3">{children}</div>
      </div>
    </Card>
  );
}

// Generate N color stops from white-ish to the slot's base color, used
// Pick a contrasting text color (white or dark gray) for a given
// hex background, so in-bar labels stay readable across the full
// shadeStops range — pale shades get dark text, dark shades white.
// Uses the WCAG relative-luminance formula with a 0.55 cutoff,
// which empirically gives good contrast against the teal /
// amber / etc. palettes we use here.
function textColorForBg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#1f2937" : "#ffffff";
}

// Hide zero / very small segment labels — the bar is too thin to
// fit a digit and the "0" just clutters the chart.
const labelFormatter = (value: unknown) => {
  const n = Number(value);
  return n > 0 ? String(n) : "";
};

// to shade per-month stacks within a single slot's chart. Older months
// are paler, the most recent month is the slot's full color.
function shadeStops(baseHex: string, count: number): string[] {
  if (count <= 1) return [baseHex];
  // Parse #rrggbb
  const r = parseInt(baseHex.slice(1, 3), 16);
  const g = parseInt(baseHex.slice(3, 5), 16);
  const b = parseInt(baseHex.slice(5, 7), 16);
  // From 80% lightness toward the base color.
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    // t=0 → very light tint of base; t=1 → base.
    const t = count === 1 ? 1 : 0.35 + (0.65 * i) / (count - 1);
    const rr = Math.round(255 - (255 - r) * t);
    const gg = Math.round(255 - (255 - g) * t);
    const bb = Math.round(255 - (255 - b) * t);
    out.push(
      `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`,
    );
  }
  return out;
}

function PerSlotChart({
  slot,
  rows,
  months,
  onPersonClick,
}: {
  slot: {
    slot_id: number;
    slot_name: string;
    team_role_id: number | null;
    team_role_label: string | null;
    color: string;
  };
  rows: StatsRow[];
  months: string[];
  /** Commit 2 drill-down. Fires with the person_id of whichever
   * stacked bar segment the user clicks. Lifted up to the page so
   * the side panel can read from existing data. */
  onPersonClick?: (personId: number) => void;
}) {
  // Pivot: one row per person, columns are months (count for THIS
  // slot/role). Skip persons with zero count for this slot to keep
  // the chart tight.
  const data = useMemo(() => {
    const byPid = new Map<
      number,
      { person_id: number; person: string; total: number; cells: Record<string, number> }
    >();
    for (const r of rows) {
      if (r.slot_id !== slot.slot_id) continue;
      if ((r.team_role_id ?? null) !== slot.team_role_id) continue;
      let row = byPid.get(r.person_id);
      if (!row) {
        row = {
          person_id: r.person_id,
          person: personLastName({ name: r.person_name }),
          total: 0,
          cells: {},
        };
        byPid.set(r.person_id, row);
      }
      row.cells[r.year_month] = (row.cells[r.year_month] ?? 0) + r.count;
      row.total += r.count;
    }
    const list = Array.from(byPid.values()).map((p) => {
      const out: Record<string, number | string> = {
        person_id: p.person_id,
        person: p.person,
        total: p.total,
      };
      for (const m of months) out[m] = p.cells[m] ?? 0;
      return out;
    });
    // Sort by total descending — heaviest contributor at top.
    list.sort((a, b) => (b.total as number) - (a.total as number));
    return list;
  }, [rows, slot.slot_id, slot.team_role_id, months]);

  const shades = useMemo(
    () => shadeStops(slot.color, months.length),
    [slot.color, months.length],
  );

  // Index of the last month with at least one non-zero cell across
  // the chart. We anchor the per-row total label to THAT bar instead
  // of always to months[length-1] — otherwise selecting a range with
  // a trailing empty month (e.g. Aug when no data exists yet) makes
  // Recharts skip the label entirely because the host <Bar> has
  // zero-width segments for every row.
  const lastIdxWithData = useMemo(() => {
    for (let i = months.length - 1; i >= 0; i--) {
      const m = months[i];
      if (data.some((r) => (r[m] as number) > 0)) return i;
    }
    return -1;
  }, [data, months]);

  if (data.length === 0) {
    return null;
  }

  const total = data.reduce((acc, r) => acc + (r.total as number), 0);

  return (
    <ChartCard
      title={
        <span className="inline-flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: slot.color }}
          />
          <span>
            {slot.slot_name}
            {slot.team_role_label && (
              <span className="ml-1 text-xs font-normal text-gray-500">
                · {slot.team_role_label}
              </span>
            )}
          </span>
        </span>
      }
      subtitle={`${total} asignaciones · barras apiladas por mes (más oscuro = mes más reciente).`}
    >
      <ResponsiveContainer
        width="100%"
        height={Math.max(180, data.length * 36 + 60)}
      >
        <BarChart
          data={data}
          layout="vertical"
          // Right margin bumped from 20 to 44 to leave room for the
          // bold per-row TOTAL label rendered just past the bar end.
          margin={{ top: 8, right: 44, left: 60, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: "#4b5563" }}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="person"
            tick={{ fontSize: 11, fill: "#4b5563" }}
            width={120}
          />
          <Tooltip
            cursor={{ fill: "rgba(0,0,0,0.04)" }}
            contentStyle={{
              fontSize: 12,
              border: "1px solid #e5e7eb",
              borderRadius: 8,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {months.map((m, i) => (
            <Bar
              key={m}
              dataKey={m}
              stackId="s"
              fill={shades[i]}
              name={m}
              cursor={onPersonClick ? "pointer" : undefined}
              onClick={(d) => {
                // Recharts passes the row datum as the click arg.
                // person_id is stamped on each row in the `data`
                // pivot above; click any bar segment to open the
                // per-person side panel.
                const pid = (d as { person_id?: number })?.person_id;
                if (pid && onPersonClick) onPersonClick(pid);
              }}
            >
              <LabelList
                dataKey={m}
                position="center"
                fill={textColorForBg(shades[i])}
                formatter={labelFormatter}
                style={{ fontSize: 11, fontWeight: 600 }}
              />
              {/* Row total — anchored to the last bar that has data
                  across the chart, not blindly to months[length-1].
                  Recharts skips LabelList rendering for bars whose
                  segment is zero-width, so attaching to a trailing
                  empty month would make the total disappear. */}
              {i === lastIdxWithData && (
                <LabelList
                  dataKey="total"
                  position="right"
                  fill="#1f2937"
                  formatter={labelFormatter}
                  style={{ fontSize: 11, fontWeight: 700 }}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function DetailTable({
  rows,
  slotMeta,
}: {
  rows: StatsRow[];
  slotMeta: {
    key: string;
    slot_id: number;
    slot_name: string;
    team_role_id: number | null;
    team_role_label: string | null;
    color: string;
  }[];
}) {
  // Pivot to person × (slot, role) totals for a precise readout
  // under the charts. Mirrors the BalanceStats panel idea but spans
  // the whole range instead of one schedule.
  const persons = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) {
      m.set(r.person_id, personLastName({ name: r.person_name }));
    }
    return Array.from(m.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
  }, [rows]);

  const totalBy = useMemo(() => {
    const t = new Map<string, number>(); // `${pid}|${chart_key}`
    for (const r of rows) {
      const chartKey = `${r.slot_id}|${r.team_role_id ?? ""}`;
      const k = `${r.person_id}|${chartKey}`;
      t.set(k, (t.get(k) ?? 0) + r.count);
    }
    return t;
  }, [rows]);

  const totalPerPerson = useMemo(() => {
    const t = new Map<number, number>();
    for (const r of rows) {
      t.set(r.person_id, (t.get(r.person_id) ?? 0) + r.count);
    }
    return t;
  }, [rows]);

  return (
    <Card>
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-800">Detalle</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-200 bg-gray-50 text-left">
              <tr className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2">Persona</th>
                {slotMeta.map((s) => (
                  <th
                    key={s.key}
                    className="px-3 py-2 text-right whitespace-nowrap"
                  >
                    <span className="inline-flex items-start gap-1 normal-case font-medium text-gray-700 text-xs tracking-normal">
                      <span
                        className="h-2 w-2 mt-1.5 rounded-full"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="flex flex-col leading-tight">
                        <span>{s.slot_name}</span>
                        {s.team_role_label && (
                          <span className="text-[10px] font-normal text-gray-500">
                            {s.team_role_label}
                          </span>
                        )}
                      </span>
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {persons.map(([pid, name]) => (
                <tr key={pid} className="hover:bg-gray-50/60">
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {name}
                  </td>
                  {slotMeta.map((s) => {
                    const v = totalBy.get(`${pid}|${s.key}`) ?? 0;
                    return (
                      <td
                        key={s.key}
                        className={
                          "px-3 py-2 text-right "
                          + (v ? "text-gray-800" : "text-gray-300")
                        }
                      >
                        {v || "—"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-semibold text-gray-900">
                    {totalPerPerson.get(pid) ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}


// ---------------------------------------------------------------------------
// Commit 1 dashboard components — KPI strip, equity panel, coverage
// trend, monthly trend mini-charts, categoría filter chips.
// All scale-agnostic: same UX at 6 members or 100.
// ---------------------------------------------------------------------------

/** Eight-tile KPI strip. Wraps to two rows under sm.
 *
 * Layout decisions:
 * - Total turnos + Sin cubrir get the most visual weight (they answer
 *   "is my service running smoothly?" first).
 * - "Equipo" tile is RIGHT NOW (snapshot), not range-scoped — matches
 *   the question a jefe actually asks ("how big is my team?").
 * - Tiles render even when their value is 0 — absence of swap traffic
 *   is information.
 */
function KpiStrip({
  kpis,
  monthsCount,
  workload,
}: {
  kpis: StatsKpis;
  /** Number of calendar months in the selected date range. Used
   *  to express the load metric as a per-month rate so a Jan-Jun
   *  selection and a YTD-Dec selection give comparable numbers. */
  monthsCount: number;
  /** Per-person workload rows — feed the Gini fairness number on
   *  the hero strip. We use normalized_total (FTE-adjusted) so
   *  part-timers doing their fair share don't drag the score. */
  workload: StatsWorkloadRow[];
}) {
  // Eight tiles was too many to scan — eyes glazed by the sixth.
  // Hero strip surfaces the four numbers admins care about
  // operationally: "is anything broken" (sin cubrir), "how
  // turbulent is this" (cambios de turno), "what's the load
  // per person" (turnos / FTE / mes), and "is it fair" (Gini de
  // carga). Everything else goes behind "Más métricas".
  const [expanded, setExpanded] = useState(false);
  const totalSwaps =
    kpis.swap_offers_open
    + kpis.swap_offers_fulfilled
    + kpis.swap_offers_cancelled;
  const shiftsPerFtePerMonth =
    kpis.total_fte > 0 && monthsCount > 0
      ? (kpis.total_assignments / kpis.total_fte / monthsCount).toFixed(1)
      : "—";
  const giniDeCarga = useMemo(
    () =>
      computeGini(
        workload.map((w) => w.normalized_total).filter((v) => v > 0),
      ),
    [workload],
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HeroKpiTile
          label="Sin cubrir"
          value={kpis.uncovered_count.toLocaleString("es-ES")}
          hint={
            kpis.total_assignments > 0
              ? `${kpis.uncovered_pct}% de los turnos del periodo.`
              : "Sin actividad en el periodo."
          }
          tone={kpis.uncovered_count > 0 ? "warning" : "neutral"}
        />
        <HeroKpiTile
          label="Cambios de turno"
          value={totalSwaps.toLocaleString("es-ES")}
          hint={`${kpis.swap_offers_fulfilled} cubiertos · ${kpis.swap_offers_open} abiertos · ${kpis.swap_offers_cancelled} cancelados`}
        />
        <HeroKpiTile
          label="Turnos / FTE / mes"
          value={shiftsPerFtePerMonth}
          hint="Turnos medios por miembro a tiempo completo cada mes."
        />
        <HeroKpiTile
          label="Gini de carga"
          value={giniDeCarga !== null ? giniDeCarga.toFixed(2) : "—"}
          hint="0 = todos igual · 1 = uno lo hace todo. Sobre carga ajustada por FTE."
          tone={
            giniDeCarga !== null && giniDeCarga > 0.25 ? "warning" : "neutral"
          }
        />
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-900"
      >
        {expanded ? "Menos métricas" : "Más métricas"}
        <ChevronDown
          className={
            "h-3.5 w-3.5 transition-transform "
            + (expanded ? "rotate-180" : "")
          }
        />
      </button>

      {expanded && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <KpiTile
            label="Total turnos"
            value={kpis.total_assignments.toLocaleString("es-ES")}
            hint="En planificaciones publicadas y archivadas."
          />
          <KpiTile
            label="Bloqueos"
            value={`${kpis.bloqueos_days_total} días`}
            hint={formatBloqueoBreakdown(kpis.bloqueos_days_by_type)}
          />
          <KpiTile
            label="Equipo"
            value={`${kpis.active_members} activos`}
            hint={`${kpis.total_fte.toLocaleString("es-ES")} FTE total`}
          />
          <KpiTile
            label="Incidencias"
            value={kpis.incidents_count.toLocaleString("es-ES")}
            hint="Registradas en el periodo."
          />
          <KpiTile
            label="Reabiertas"
            value={kpis.reopened_schedules_count.toLocaleString("es-ES")}
            hint="Planificaciones reabiertas tras publicar."
            tone={kpis.reopened_schedules_count > 0 ? "warning" : "neutral"}
          />
        </div>
      )}
    </div>
  );
}

// Bigger sibling of KpiTile for the hero strip on Resumen.
// Same shape, larger padding + value text, so the three weekly-
// scan metrics get visual weight against the collapsible row of
// secondary tiles below.
function HeroKpiTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "warning";
}) {
  const valueColour =
    tone === "warning" ? "text-amber-700" : "text-gray-900";
  return (
    <div className="rounded-xl bg-white p-5 shadow-soft ring-1 ring-gray-200">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div className={`mt-1.5 text-3xl font-semibold tabular-nums ${valueColour}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-1.5 text-xs leading-snug text-gray-500">
          {hint}
        </div>
      )}
    </div>
  );
}

function KpiTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "warning";
}) {
  const valueColour =
    tone === "warning" ? "text-amber-700" : "text-gray-900";
  return (
    <div className="rounded-xl bg-white p-4 shadow-soft ring-1 ring-gray-200">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueColour}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[11px] leading-snug text-gray-500">
          {hint}
        </div>
      )}
    </div>
  );
}

const BLOQUEO_LABEL_BY_TYPE: Record<string, string> = {
  vacation: "vacaciones",
  sick: "enfermedad",
  training: "formación",
  personal: "personal",
  other: "otros",
};

function formatBloqueoBreakdown(by: Record<string, number>): string {
  const entries = Object.entries(by)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, n]) => `${BLOQUEO_LABEL_BY_TYPE[k] ?? k} ${n}`,
    );
  if (entries.length === 0) return "Sin bloqueos en el periodo.";
  return entries.slice(0, 3).join(" · ");
}

/** Equity panel — FTE-normalized workload histogram + outlier callout.
 *
 * Two visualizations side-by-side:
 *  - left: histogram of "shifts per 100% FTE" — bin count by N people.
 *    Same chart works at N=6 (sparse) or N=100 (gaussian-ish).
 *  - right: outlier callout — top + bottom person by load, with the
 *    fairness ratio (max / min) as a single number.
 *
 * Respects categoría filter: histogram + outliers are computed against
 * the filtered population.
 */
function EquityPanel({
  workload,
  activeCategoryIds,
  accent,
  onPersonClick,
}: {
  workload: StatsWorkloadRow[];
  activeCategoryIds: Set<number | null>;
  accent: string;
  /** Click the top / bottom outlier name → open the per-person side
   * panel. Same drill-down channel as the per-slot chart click. */
  onPersonClick?: (personId: number) => void;
}) {
  const filtered = useMemo(
    () =>
      workload.filter(
        (w) => activeCategoryIds.has(w.category_id) && w.total_shifts > 0,
      ),
    [workload, activeCategoryIds],
  );

  // Bin the normalized_total values for the histogram. Use 8 bins
  // spanning min → max. At N<3 the histogram is meaningless, so skip
  // and render a placeholder.
  const hist = useMemo(() => {
    if (filtered.length < 3) return null;
    const values = filtered.map((w) => w.normalized_total);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    if (range === 0) {
      return [
        { label: `${min.toFixed(0)}`, count: filtered.length },
      ];
    }
    const binCount = Math.min(8, Math.max(4, Math.ceil(filtered.length / 4)));
    const binWidth = range / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => {
      const lo = min + i * binWidth;
      const hi = i === binCount - 1 ? max : lo + binWidth;
      return {
        label: `${Math.round(lo)}–${Math.round(hi)}`,
        count: 0,
      };
    });
    for (const v of values) {
      const idx = Math.min(
        binCount - 1,
        Math.floor((v - min) / binWidth),
      );
      bins[idx].count += 1;
    }
    return bins;
  }, [filtered]);

  // Outlier callouts: top + bottom by normalized_total.
  const top = useMemo(
    () =>
      [...filtered].sort(
        (a, b) => b.normalized_total - a.normalized_total,
      )[0],
    [filtered],
  );
  const bottom = useMemo(
    () =>
      [...filtered].sort(
        (a, b) => a.normalized_total - b.normalized_total,
      )[0],
    [filtered],
  );
  const ratio = useMemo(() => {
    if (!top || !bottom || bottom.normalized_total === 0) return null;
    return top.normalized_total / bottom.normalized_total;
  }, [top, bottom]);

  return (
    <Card>
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-800">
          Equidad de carga
        </h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Turnos por miembro, normalizados a una jornada del 100%.
          {filtered.length < 3
            ? " Aún no hay datos suficientes para comparar."
            : ""}
        </p>
        {hist === null || filtered.length === 0 ? (
          <div className="mt-3 rounded-md bg-gray-50 px-3 py-6 text-center text-xs text-gray-500">
            Necesitamos al menos 3 personas con turnos en el periodo
            para construir la distribución.
          </div>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart
                data={hist}
                margin={{ top: 8, right: 16, left: 8, bottom: 24 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "#4b5563" }}
                  // Axis label sits below the tick row. Without it
                  // the X values "103–108" etc. are mysterious; with
                  // it they read as "turnos normalizados a 100% FTE."
                  label={{
                    value: "Turnos / FTE 100%",
                    position: "insideBottom",
                    offset: -16,
                    style: {
                      fontSize: 10,
                      fill: "#6b7280",
                      fontWeight: 500,
                    },
                  }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: "#4b5563" }}
                  // Rotated label on the Y axis — same idea, makes
                  // "8" on the gridline read as "8 personas" without
                  // needing the tooltip.
                  label={{
                    value: "Personas",
                    angle: -90,
                    position: "insideLeft",
                    offset: 14,
                    style: {
                      fontSize: 10,
                      fill: "#6b7280",
                      fontWeight: 500,
                      textAnchor: "middle",
                    },
                  }}
                />
                <Tooltip
                  cursor={{ fill: "rgba(0,0,0,0.04)" }}
                  contentStyle={{
                    fontSize: 12,
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                  }}
                  formatter={(v) => [`${Number(v)} personas`, "Carga"]}
                />
                <Bar dataKey="count" fill={accent} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex flex-col justify-center gap-3 text-sm">
              {top && bottom && (
                <>
                  <button
                    type="button"
                    className="text-left transition-colors hover:text-brand-700"
                    onClick={() => onPersonClick?.(top.person_id)}
                    disabled={!onPersonClick}
                  >
                    <div className="text-[11px] uppercase tracking-wider text-gray-500">
                      Más cargado
                    </div>
                    <div className="font-semibold text-gray-900 underline-offset-2 hover:underline">
                      {personLastName({ name: top.person_name })}
                    </div>
                    <div className="text-xs text-gray-600">
                      {top.total_shifts} turnos · {top.normalized_total.toFixed(1)}/FTE
                    </div>
                  </button>
                  <button
                    type="button"
                    className="text-left transition-colors hover:text-brand-700"
                    onClick={() => onPersonClick?.(bottom.person_id)}
                    disabled={!onPersonClick}
                  >
                    <div className="text-[11px] uppercase tracking-wider text-gray-500">
                      Menos cargado
                    </div>
                    <div className="font-semibold text-gray-900 underline-offset-2 hover:underline">
                      {personLastName({ name: bottom.person_name })}
                    </div>
                    <div className="text-xs text-gray-600">
                      {bottom.total_shifts} turnos · {bottom.normalized_total.toFixed(1)}/FTE
                    </div>
                  </button>
                  {ratio !== null && (
                    <div className="rounded-md bg-gray-50 px-3 py-2 text-xs">
                      <span className="text-gray-500">
                        Ratio max/min:
                      </span>{" "}
                      <span
                        className={
                          "font-semibold "
                          + (ratio < 1.5
                            ? "text-emerald-700"
                            : ratio < 2.5
                              ? "text-amber-700"
                              : "text-rose-700")
                        }
                      >
                        {ratio.toFixed(1)}×
                      </span>
                      <span className="ml-1 text-gray-500">
                        {ratio < 1.5
                          ? "(equitativo)"
                          : ratio < 2.5
                            ? "(diferencias notables)"
                            : "(desequilibrio significativo)"}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Coverage trend — line chart of monthly total vs uncovered.
 *
 * Two lines: total assignments (accent color) + uncovered (amber).
 * Single chart, low height (~180px) so it sits next to the equity
 * panel in a 3-column grid on desktop. */
function CoverageTrend({
  monthly,
  accent,
}: {
  monthly: StatsMonthlyRow[];
  accent: string;
}) {
  const data = monthly.map((m) => ({
    month: m.year_month,
    total: m.total_assignments,
    uncovered: m.uncovered_count,
  }));
  const anyData = data.some((d) => d.total > 0);
  return (
    <Card>
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-800">Cobertura</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Turnos totales vs sin cubrir, por mes.
        </p>
        {!anyData ? (
          <div className="mt-3 rounded-md bg-gray-50 px-3 py-6 text-center text-xs text-gray-500">
            Sin actividad en el periodo.
          </div>
        ) : (
          <div className="mt-3">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart
                data={data}
                margin={{ top: 8, right: 16, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 10, fill: "#4b5563" }}
                  tickFormatter={miniMonthLabel}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: "#4b5563" }}
                  label={{
                    value: "Turnos",
                    angle: -90,
                    position: "insideLeft",
                    offset: 14,
                    style: {
                      fontSize: 10,
                      fill: "#6b7280",
                      fontWeight: 500,
                      textAnchor: "middle",
                    },
                  }}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                  }}
                  labelFormatter={(ym) => miniMonthLabelFull(String(ym ?? ""))}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="total"
                  name="Total"
                  stroke={accent}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="uncovered"
                  name="Sin cubrir"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Monthly trends panel — four mini-charts side-by-side.
 *
 * Each mini-chart is one metric over time. Lets a jefe scan
 * operational tempo at a glance: "March had double the bloqueos."
 * Each chart is intentionally low (~110px) so all four fit on one
 * row at md+ widths. */
function MonthlyTrendsPanel({
  monthly,
  accent,
}: {
  monthly: StatsMonthlyRow[];
  accent: string;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <MiniTrend
        title="Turnos por mes"
        data={monthly.map((m) => ({ x: m.year_month, y: m.total_assignments }))}
        color={accent}
      />
      <MiniTrend
        title="Cambios de turno"
        data={monthly.map((m) => ({ x: m.year_month, y: m.swap_offers_created }))}
        color="#6366f1"
        // Secondary line: how many of the requested swaps actually
        // got covered. Visualising both side-by-side surfaces the
        // cubrir rate — a gap between the lines is "lots of
        // requests, nobody covering."
        secondary={{
          label: "Cubiertos",
          data: monthly.map((m) => ({
            x: m.year_month,
            y: m.swap_offers_fulfilled,
          })),
          color: "#10b981",
        }}
        primaryLabel="Solicitados"
      />
      <MiniTrend
        title="Bloqueos (días)"
        data={monthly.map((m) => ({ x: m.year_month, y: m.bloqueos_days }))}
        color="#f59e0b"
      />
      <MiniTrend
        title="Incidencias"
        data={monthly.map((m) => ({ x: m.year_month, y: m.incidents_count }))}
        color="#f43f5e"
      />
    </div>
  );
}

function MiniTrend({
  title,
  data,
  color,
  primaryLabel,
  secondary,
}: {
  title: string;
  data: { x: string; y: number }[];
  color: string;
  /** When `secondary` is set, this short label disambiguates the
   * primary headline number ("Solicitados" vs "Cubiertos"). */
  primaryLabel?: string;
  /** Optional second line on the same chart. Used by the Cambios
   * card to overlay "cubiertos" on top of "solicitados" so the
   * gap between the two lines reads as the cubrir rate. */
  secondary?: {
    label: string;
    data: { x: string; y: number }[];
    color: string;
  };
}) {
  const total = data.reduce((acc, d) => acc + d.y, 0);
  const secondaryTotal = secondary
    ? secondary.data.reduce((acc, d) => acc + d.y, 0)
    : 0;
  // Merge primary + secondary by x so a single Recharts dataset
  // can host both lines. Recharts plots each Line by its own
  // dataKey ("y" for primary, "y2" for secondary).
  const merged = useMemo(() => {
    if (!secondary) return data.map((d) => ({ x: d.x, y: d.y }));
    const map = new Map<string, number>();
    for (const d of secondary.data) map.set(d.x, d.y);
    return data.map((d) => ({ x: d.x, y: d.y, y2: map.get(d.x) ?? 0 }));
  }, [data, secondary]);
  return (
    <div className="rounded-xl bg-white p-3 shadow-soft ring-1 ring-gray-200">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            {title}
          </div>
        </div>
        {/* Headline: total across the selected period. When
            `secondary` is present we show two totals stacked (primary
            on top, secondary smaller below) so the cubrir rate is
            instantly readable. */}
        <div className="text-right leading-tight">
          <div className="text-sm font-semibold tabular-nums text-gray-900">
            {total.toLocaleString("es-ES")}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-gray-400">
            {primaryLabel ?? "total"}
          </div>
          {secondary && (
            <div className="mt-0.5">
              <span
                className="text-xs font-semibold tabular-nums"
                style={{ color: secondary.color }}
              >
                {secondaryTotal.toLocaleString("es-ES")}
              </span>
              <span className="ml-1 text-[9px] uppercase tracking-wider text-gray-400">
                {secondary.label}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-1">
        <ResponsiveContainer width="100%" height={96}>
          <LineChart
            data={merged}
            margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
          >
            {/* Month tick labels along the bottom — formatted as
                three-letter Spanish month abbreviations ("may",
                "jun", …) so they fit even on a 4-card row. Y axis
                shows narrow ticks so the line's amplitude can be
                read in absolute terms (the corner total alone
                doesn't tell you whether "may" was 200 or 400). */}
            <XAxis
              dataKey="x"
              tick={{ fontSize: 9, fill: "#9ca3af" }}
              tickFormatter={miniMonthLabel}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={12}
            />
            <YAxis
              tick={{ fontSize: 9, fill: "#9ca3af" }}
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              width={24}
              // 3 ticks total: 0, ~mid, max. Keeps the gridline
              // density low enough that the chart still reads as a
              // sparkline rather than a "real" chart.
              tickCount={3}
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: "4px 8px",
              }}
              labelStyle={{ color: "#6b7280" }}
              labelFormatter={(ym) => miniMonthLabelFull(String(ym ?? ""))}
              formatter={(v, name) => {
                // When a secondary line is present, Recharts calls
                // the formatter once per series. We surface a real
                // label so the tooltip reads "Solicitados: 12" vs
                // "Cubiertos: 9" instead of two unlabeled lines.
                const label = name === "secondary"
                  ? secondary?.label ?? ""
                  : primaryLabel ?? "";
                return [Number(v), label];
              }}
            />
            <Line
              type="monotone"
              dataKey="y"
              name="primary"
              stroke={color}
              strokeWidth={2}
              dot={false}
            />
            {secondary && (
              <Line
                type="monotone"
                dataKey="y2"
                name="secondary"
                stroke={secondary.color}
                strokeWidth={2}
                dot={false}
                // Dashed so even at a glance the eye can tell which
                // line is which without reading the colors.
                strokeDasharray="4 2"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Three-letter Spanish month abbreviations for the mini-trend axes
// and the calendar heat map. Shared so the two surfaces don't drift.
const ES_MONTHS_3 = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

function miniMonthLabel(ym: string): string {
  // ym like "2026-05" → "may"
  const m = Number(ym.slice(5, 7));
  return ES_MONTHS_3[m - 1] ?? ym;
}

function miniMonthLabelFull(ym: string): string {
  // Tooltip uses the full month + year ("mayo 2026") so the
  // hover detail is unambiguous even when the axis ticks elide.
  const months = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  const m = Number(ym.slice(5, 7));
  return `${months[m - 1] ?? ym} ${ym.slice(0, 4)}`;
}

/** Categoría filter chips. Pure visual; state lives in the page.
 *
 * Hidden when there's only one categoría (or none) — useful only
 * for tenants with mixed-category teams (adjuntos + residentes + ...). */
function CategoryFilterChips({
  options,
  active,
  onToggle,
  onAll,
}: {
  options: [number | null, string][];
  active: Set<number | null>;
  onToggle: (id: number | null) => void;
  onAll: () => void;
}) {
  const allSelected = options.every(([id]) => active.has(id));
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        Categoría:
      </span>
      <button
        type="button"
        onClick={onAll}
        className={
          "rounded-full border px-3 py-1 text-xs font-medium transition-colors "
          + (allSelected
            ? "border-brand-600 bg-brand-50 text-brand-700"
            : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50")
        }
      >
        Todas
      </button>
      {options.map(([id, name]) => {
        const on = active.has(id);
        return (
          <button
            key={id ?? "null"}
            type="button"
            onClick={() => onToggle(id)}
            aria-pressed={on}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors "
              + (on
                ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-700"
                : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50")
            }
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Commit 2 — categoría rollup + per-person side panel.
// ---------------------------------------------------------------------------

/** Categoría rollup: donut of total shifts by categoría + a compact
 * per-categoría comparison table. Designed as the primary at-scale
 * view: a 100-adjunto + 30-residente service collapses into a
 * 4-row table, which is way more readable than 130 individual bars.
 *
 * Hidden by the parent when the tenant has ≤1 categoría (caller
 * checks categoryOptions.length > 1). At N=2+ categorías this is the
 * jefe's "what's the work split between adjuntos and residentes?"
 * answer in one glance. */
function CategoriaRollup({
  workload,
  palette,
}: {
  workload: StatsWorkloadRow[];
  palette: string[];
}) {
  // Bucket per categoría. Use category_id (or null) as the key.
  const buckets = useMemo(() => {
    const m = new Map<
      string,
      {
        key: string;
        category_id: number | null;
        category_name: string;
        total_shifts: number;
        weekend_shifts: number;
        head_count: number;
        fte: number;
      }
    >();
    for (const w of workload) {
      const key = w.category_id === null ? "null" : String(w.category_id);
      let b = m.get(key);
      if (!b) {
        b = {
          key,
          category_id: w.category_id,
          category_name: w.category_name ?? "Sin categoría",
          total_shifts: 0,
          weekend_shifts: 0,
          head_count: 0,
          fte: 0,
        };
        m.set(key, b);
      }
      b.total_shifts += w.total_shifts;
      b.weekend_shifts += w.weekend_or_holiday_shifts;
      b.head_count += 1;
      b.fte += w.fte_pct / 100;
    }
    return Array.from(m.values()).sort(
      (a, b) => b.total_shifts - a.total_shifts,
    );
  }, [workload]);

  // Drop categorías that had zero shifts in the period — they
  // clutter the donut as 0-degree slices and waste a row in the
  // comparison table. The KPI strip already shows total team size.
  const active = buckets.filter((b) => b.total_shifts > 0);
  const totalShifts = active.reduce((acc, b) => acc + b.total_shifts, 0);

  if (active.length === 0) {
    return null;
  }

  // Assign a stable color per categoría from the page palette.
  const colored = active.map((b, i) => ({
    ...b,
    color: palette[i % palette.length],
  }));

  return (
    <Card>
      <div className="p-4">
        <h2 className="text-sm font-semibold text-gray-800">
          Reparto por categoría
        </h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Turnos totales agrupados por categoría profesional. Útil
          cuando el equipo es grande y la vista por persona se vuelve
          ilegible.
        </p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={colored}
                dataKey="total_shifts"
                nameKey="category_name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                innerRadius={48}
                paddingAngle={1}
              >
                {colored.map((entry) => (
                  <Cell key={entry.key} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                }}
                formatter={(v, n) => [`${Number(v)} turnos`, n]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="pb-2">Categoría</th>
                  <th className="pb-2 text-right">Turnos</th>
                  <th className="pb-2 text-right">Personas</th>
                  <th className="pb-2 text-right">FTE</th>
                  <th className="pb-2 text-right">T/FTE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {colored.map((b) => {
                  const pct = totalShifts > 0
                    ? Math.round((b.total_shifts / totalShifts) * 100)
                    : 0;
                  const tPerFte =
                    b.fte > 0 ? (b.total_shifts / b.fte).toFixed(1) : "—";
                  return (
                    <tr key={b.key}>
                      <td className="py-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: b.color }}
                          />
                          <div className="leading-tight">
                            <div className="font-medium text-gray-900">
                              {b.category_name}
                            </div>
                            <div className="text-[10px] text-gray-500">
                              {pct}% del total
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-gray-900">
                        {b.total_shifts}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-gray-700">
                        {b.head_count}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-gray-700">
                        {b.fte.toFixed(1)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-gray-900">
                        {tPerFte}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] leading-snug text-gray-500">
              T/FTE = turnos por jornada del 100%. Compara categorías
              con composiciones de tiempo parcial distintas en igualdad
              de condiciones.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Per-person side panel — drill-down from any chart click.
 *
 * Renders as a right-anchored sheet (fixed) so it works regardless
 * of page scroll position. Closed by clicking the backdrop or the X.
 * Reads from data the page already has (workload row + the per-slot
 * StatsRow list) — no extra fetch.
 *
 * Content priority for a jefe:
 *  1. Identity (name, categoría, FTE)
 *  2. Headline: total shifts + weekend share + FTE-normalized rate
 *  3. Per-slot breakdown (table)
 *  4. Per-month sparkline of the person's total (trend over the range)
 */
function PersonDetailPanel({
  person,
  rows,
  months,
  accent,
  onClose,
}: {
  person: StatsWorkloadRow;
  rows: StatsRow[];
  months: string[];
  accent: string;
  onClose: () => void;
}) {
  // Per-slot breakdown for this person, summed across months.
  const perSlot = useMemo(() => {
    type Row = {
      key: string;
      slot_name: string;
      team_role_label: string | null;
      slot_color: string | null;
      total: number;
    };
    const m = new Map<string, Row>();
    for (const r of rows) {
      if (r.person_id !== person.person_id) continue;
      const key = `${r.slot_id}|${r.team_role_id ?? ""}`;
      let entry = m.get(key);
      if (!entry) {
        entry = {
          key,
          slot_name: r.slot_name,
          team_role_label: r.team_role_label,
          slot_color: r.slot_color,
          total: 0,
        };
        m.set(key, entry);
      }
      entry.total += r.count;
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total);
  }, [rows, person.person_id]);

  // Per-month total for the sparkline. Pre-zero each month so the
  // line is continuous.
  const trend = useMemo(() => {
    const by: Record<string, number> = {};
    for (const ym of months) by[ym] = 0;
    for (const r of rows) {
      if (r.person_id !== person.person_id) continue;
      by[r.year_month] = (by[r.year_month] ?? 0) + r.count;
    }
    return months.map((m) => ({ x: m, y: by[m] ?? 0 }));
  }, [rows, months, person.person_id]);

  const weekendPct =
    person.total_shifts > 0
      ? Math.round(
          (person.weekend_or_holiday_shifts / person.total_shifts) * 100,
        )
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sticky header — name + categoría + close. */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-gray-900">
              {person.person_name}
            </div>
            <div className="mt-0.5 truncate text-xs text-gray-500">
              {person.category_name ?? "Sin categoría"} · FTE {person.fte_pct}%
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <span aria-hidden className="text-xl leading-none">×</span>
          </button>
        </div>

        {/* Headline tiles. */}
        <div className="grid grid-cols-3 gap-2 px-5 py-4">
          <PanelStat
            label="Turnos"
            value={person.total_shifts.toLocaleString("es-ES")}
          />
          <PanelStat
            label="Fines de semana"
            value={`${person.weekend_or_holiday_shifts}`}
            hint={`${weekendPct}% del total`}
          />
          <PanelStat
            label="Por FTE"
            value={person.normalized_total.toFixed(1)}
            hint="Normalizado a 100%"
          />
        </div>

        {/* Per-slot breakdown. */}
        <div className="border-t border-gray-100 px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Reparto por actividad
          </div>
          {perSlot.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500">
              Sin turnos en el periodo.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {perSlot.map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-xs">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: s.slot_color ?? "#94a3b8" }}
                  />
                  <span className="flex-1 truncate text-gray-700">
                    {s.slot_name}
                    {s.team_role_label && (
                      <span className="ml-1 text-gray-400">
                        · {s.team_role_label}
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums font-semibold text-gray-900">
                    {s.total}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Per-month trend sparkline. */}
        <div className="border-t border-gray-100 px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Tendencia por mes
          </div>
          <div className="mt-2">
            <ResponsiveContainer width="100%" height={100}>
              <LineChart
                data={trend}
                margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
              >
                <XAxis dataKey="x" tick={{ fontSize: 9, fill: "#9ca3af" }} />
                <YAxis hide allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    fontSize: 11,
                    border: "1px solid #e5e7eb",
                    borderRadius: 6,
                    padding: "4px 8px",
                  }}
                  formatter={(v) => [Number(v), "turnos"]}
                />
                <Line
                  type="monotone"
                  dataKey="y"
                  stroke={accent}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md bg-gray-50 px-3 py-2 ring-1 ring-gray-200">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-gray-500">{hint}</div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Commit 3 — calendar heat map (GitHub-style per-person row of day cells).
// ---------------------------------------------------------------------------

type HeatmapMode = "shifts" | "weekends" | "bloqueos";

/** Color for a single cell given the active mode + the day's data.
 *
 * Returns a Tailwind-friendly hex (so we can interpolate intensities)
 * plus an a11y label for the tooltip. Empty cells (no shifts, no
 * bloqueo) get a neutral gray so the grid still has structure.
 */
function cellColor(
  mode: HeatmapMode,
  entry: CalendarEntry | undefined,
  isWeekendOrHoliday: boolean,
  accent: string,
): { fill: string; ring?: string } {
  // Empty fallback.
  const empty = { fill: "#f3f4f6" };

  if (mode === "shifts") {
    if (!entry || entry.shifts === 0) return empty;
    // Intensity scale: 1 shift = 35%, 2 = 65%, 3+ = 100%.
    const t = Math.min(1, 0.35 + (entry.shifts - 1) * 0.3);
    return { fill: tintAccent(accent, t) };
  }

  if (mode === "weekends") {
    if (!entry || entry.shifts === 0 || !isWeekendOrHoliday) return empty;
    const t = Math.min(1, 0.5 + (entry.shifts - 1) * 0.25);
    return { fill: tintAccent("#f59e0b", t) };
  }

  // mode === "bloqueos"
  if (!entry || !entry.bloqueo_type) return empty;
  const palette: Record<string, string> = {
    vacation: "#f59e0b",   // amber — peak summer reading
    sick: "#f43f5e",       // rose — read as concerning
    training: "#6366f1",   // indigo — neutral planned
    personal: "#94a3b8",   // slate — discreet
    other: "#cbd5e1",      // lighter slate — fallback
  };
  return { fill: palette[entry.bloqueo_type] ?? palette.other };
}

/** Lighten the accent color toward white by (1 - t). t=1 returns
 * the unmodified accent; t=0 returns near-white. Same formula as
 * the shadeStops helper used for per-slot bars. */
function tintAccent(hex: string, t: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const rr = Math.round(255 - (255 - r) * t);
  const gg = Math.round(255 - (255 - g) * t);
  const bb = Math.round(255 - (255 - b) * t);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

const ES_MONTHS_SHORT = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

function daysBetween(from: string, to: string): Date[] {
  const out: Date[] = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    out.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function isoFromDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Calendar heat map. One row per person, one column per day in the
 * selected range. Color encodes the active mode (shifts / weekends /
 * bloqueos). Horizontally scrollable so a full-year × 100-person view
 * stays usable; person column is sticky so the Y-axis labels don't
 * scroll out of view. */
function CalendarHeatmap({
  data,
  accent,
  personIdsFilter,
  onPersonClick,
}: {
  data: StatsCalendarResponse;
  accent: string;
  /** When set, restricts the rendered persons to this set. The
   * page-level categoría filter feeds this — `null` means no
   * filter (show everyone), an empty set means "hide everyone"
   * which is a valid state (user unchecked every chip). */
  personIdsFilter?: Set<number> | null;
  onPersonClick?: (personId: number) => void;
}) {
  const [mode, setMode] = useState<HeatmapMode>("shifts");

  const days = useMemo(
    () => daysBetween(data.from_date, data.to_date),
    [data.from_date, data.to_date],
  );

  // Visible persons after the categoría filter is applied. Computed
  // here rather than at the call site so the totals + lookup map
  // below all stay scoped consistently.
  const visiblePersons = useMemo(() => {
    if (!personIdsFilter) return data.persons;
    return data.persons.filter((p) => personIdsFilter.has(p.id));
  }, [data.persons, personIdsFilter]);

  const holidayDates = useMemo(
    () => new Set(data.holidays),
    [data.holidays],
  );

  // Lookup map keyed on `${person_id}|${YYYY-MM-DD}` so the row
  // render is O(days) per person. At 100 people × 365 days = 36k
  // lookups, all cheap.
  const lookup = useMemo(() => {
    const m = new Map<string, CalendarEntry>();
    for (const e of data.entries) {
      m.set(`${e.person_id}|${e.date}`, e);
    }
    return m;
  }, [data.entries]);

  // Pre-compute month labels for the top axis. Each month gets one
  // sticky pill above its first cell; the cells span the rest of
  // the row. Day-1 is the cleanest anchor and keeps spacing even.
  const monthLabels = useMemo(() => {
    const out: { iso: string; label: string }[] = [];
    for (const d of days) {
      if (d.getUTCDate() === 1) {
        out.push({
          iso: isoFromDate(d),
          label: `${ES_MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        });
      }
    }
    return out;
  }, [days]);

  // Per-person totals for the right-hand annotation. Computed in
  // the mode dimension so the column header makes sense.
  const totals = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of data.entries) {
      const day = e.date;
      const d = new Date(day + "T00:00:00Z");
      const isHoliday = holidayDates.has(day);
      const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      let value = 0;
      if (mode === "shifts") {
        value = e.shifts;
      } else if (mode === "weekends") {
        value = e.shifts > 0 && (isWeekend || isHoliday) ? e.shifts : 0;
      } else {
        value = e.bloqueo_type ? 1 : 0;
      }
      if (value > 0) {
        m.set(e.person_id, (m.get(e.person_id) ?? 0) + value);
      }
    }
    return m;
  }, [data.entries, mode, holidayDates]);

  const CELL_W = 12;
  const CELL_H = 14;
  const CELL_GAP = 2;

  return (
    <Card>
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">
              Mapa de actividad
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Cada celda es un día. Color = intensidad. Pasa el ratón
              por cualquier celda para ver el detalle. Haz clic en
              un nombre para abrir su panel.
            </p>
          </div>
          {/* Mode toggle — three pills. Pill style copied from the
              categoría filter chips for visual consistency. */}
          <div className="flex flex-wrap gap-1.5">
            <HeatmapModeChip active={mode === "shifts"} onClick={() => setMode("shifts")}>
              Turnos
            </HeatmapModeChip>
            <HeatmapModeChip active={mode === "weekends"} onClick={() => setMode("weekends")}>
              Fines y festivos
            </HeatmapModeChip>
            <HeatmapModeChip active={mode === "bloqueos"} onClick={() => setMode("bloqueos")}>
              Bloqueos
            </HeatmapModeChip>
          </div>
        </div>

        {visiblePersons.length === 0 ? (
          <p className="mt-4 text-xs text-gray-500">
            {data.persons.length === 0
              ? "No hay miembros activos en el equipo."
              : "Ninguna persona coincide con los filtros."}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <div
              className="relative"
              style={{
                minWidth: 220 + days.length * (CELL_W + CELL_GAP),
              }}
            >
              {/* Top axis — month labels. Positioned absolutely so
                  they line up with their first cell. */}
              <div
                className="relative h-5"
                style={{
                  marginLeft: 220,
                  width: days.length * (CELL_W + CELL_GAP),
                }}
              >
                {monthLabels.map((m) => {
                  const idx = days.findIndex((d) => isoFromDate(d) === m.iso);
                  if (idx < 0) return null;
                  return (
                    <div
                      key={m.iso}
                      className="absolute top-0 text-[10px] font-medium uppercase tracking-wider text-gray-500"
                      style={{ left: idx * (CELL_W + CELL_GAP) }}
                    >
                      {m.label}
                    </div>
                  );
                })}
              </div>

              {/* Rows */}
              {visiblePersons.map((p) => {
                const rowTotal = totals.get(p.id) ?? 0;
                return (
                  <div key={p.id} className="flex items-center">
                    {/* Sticky person column */}
                    <button
                      type="button"
                      onClick={() => onPersonClick?.(p.id)}
                      className="sticky left-0 z-10 flex w-[220px] shrink-0 items-center justify-between gap-2 bg-white pr-3 text-left text-xs hover:text-brand-700"
                      style={{ height: CELL_H + CELL_GAP }}
                      title={p.category_name ?? ""}
                    >
                      <span className="truncate font-medium text-gray-800 hover:underline">
                        {personLastName({ name: p.name })}
                      </span>
                      <span className="tabular-nums text-[10px] text-gray-500">
                        {rowTotal || ""}
                      </span>
                    </button>
                    {/* Day cells */}
                    <div className="flex" style={{ gap: CELL_GAP }}>
                      {days.map((d) => {
                        const iso = isoFromDate(d);
                        const entry = lookup.get(`${p.id}|${iso}`);
                        const isHoliday = holidayDates.has(iso);
                        const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
                        const wOrH = isWeekend || isHoliday;
                        const color = cellColor(mode, entry, wOrH, accent);
                        const tooltip = makeTooltip(p, iso, entry, isHoliday, isWeekend);
                        return (
                          <div
                            key={iso}
                            title={tooltip}
                            className={
                              wOrH
                                ? "ring-1 ring-inset ring-gray-200"
                                : ""
                            }
                            style={{
                              width: CELL_W,
                              height: CELL_H,
                              backgroundColor: color.fill,
                              borderRadius: 2,
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Legend strip — varies by mode. */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-gray-500">
          {mode === "shifts" && (
            <>
              <LegendSwatch color={tintAccent(accent, 0.35)} label="1 turno" />
              <LegendSwatch color={tintAccent(accent, 0.65)} label="2 turnos" />
              <LegendSwatch color={tintAccent(accent, 1.0)} label="3+ turnos" />
              <span>· Borde gris = fin de semana o festivo</span>
            </>
          )}
          {mode === "weekends" && (
            <>
              <LegendSwatch color={tintAccent("#f59e0b", 0.5)} label="Fin/festivo trabajado" />
              <LegendSwatch color={tintAccent("#f59e0b", 1.0)} label="Múltiples turnos" />
            </>
          )}
          {mode === "bloqueos" && (
            <>
              <LegendSwatch color="#f59e0b" label="Vacaciones" />
              <LegendSwatch color="#f43f5e" label="Enfermedad" />
              <LegendSwatch color="#6366f1" label="Formación" />
              <LegendSwatch color="#94a3b8" label="Personal" />
              <LegendSwatch color="#cbd5e1" label="Otros" />
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function HeatmapModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors "
        + (active
          ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-700"
          : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50")
      }
    >
      {children}
    </button>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-3 rounded-sm ring-1 ring-inset ring-gray-300/40"
        style={{ backgroundColor: color }}
      />
      <span>{label}</span>
    </span>
  );
}

const BLOQUEO_LABEL: Record<string, string> = {
  vacation: "vacaciones",
  sick: "enfermedad",
  training: "formación",
  personal: "personal",
  other: "otros",
};

function makeTooltip(
  p: CalendarPersonOut,
  iso: string,
  entry: CalendarEntry | undefined,
  isHoliday: boolean,
  isWeekend: boolean,
): string {
  const lines: string[] = [
    `${personLastName({ name: p.name })} · ${iso}`,
  ];
  if (entry?.shifts) {
    lines.push(`${entry.shifts} turno${entry.shifts === 1 ? "" : "s"}`);
  }
  if (entry?.bloqueo_type) {
    lines.push(`Bloqueo: ${BLOQUEO_LABEL[entry.bloqueo_type] ?? entry.bloqueo_type}`);
  }
  if (isHoliday) lines.push("Festivo");
  else if (isWeekend) lines.push("Fin de semana");
  if (!entry?.shifts && !entry?.bloqueo_type && !isHoliday && !isWeekend) {
    lines.push("Sin actividad");
  }
  return lines.join("\n");
}

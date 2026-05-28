"use client";
import { useMemo, useState } from "react";
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
import {
  MonthPicker,
  isoFromMonthYear,
} from "@/components/admin/month-picker";
import { useAccentPalette } from "@/lib/use-accent";
import { BarChart3 } from "lucide-react";

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

function lastDayOfMonthIso(yyyyMm01: string): string {
  // yyyyMm01 is "YYYY-MM-01" — return YYYY-MM-(last day).
  const y = Number(yyyyMm01.slice(0, 4));
  const m = Number(yyyyMm01.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yyyyMm01.slice(0, 7)}-${String(last).padStart(2, "0")}`;
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

  return (
    <>
      <PageHeader title="Estadísticas" />

      <div className="mb-6 flex flex-wrap items-end gap-3">
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
      </div>

      {/* Top-of-page dashboard: KPI strip + equity panel + coverage
          trend + monthly mini-charts. Always renders (independent of
          the per-slot detail below) so the jefe gets a useful read
          even when no shifts have been published in the range. */}
      {ov.data && (
        <div className="mb-8 space-y-6">
          <KpiStrip kpis={ov.data.kpis} />
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
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <EquityPanel
                workload={ov.data.workload}
                activeCategoryIds={effectiveActiveCategoryIds}
                accent={palette[0]}
                onPersonClick={setSelectedPersonId}
              />
            </div>
            <CoverageTrend monthly={ov.data.monthly} accent={palette[0]} />
          </div>
          <MonthlyTrendsPanel monthly={ov.data.monthly} accent={palette[0]} />
        </div>
      )}

      {/* Calendar heat map (Commit 3). Sits between the dashboard
          and the per-slot detail. Scales naturally — each person
          is one ~16px row, so a 100-member team is a 1600px-tall
          scrollable panel. Hidden when there's literally nothing
          to plot in the range. */}
      {cal.data
        && (cal.data.entries.length > 0 || cal.data.persons.length > 0) && (
          <CalendarHeatmap
            data={cal.data}
            accent={palette[0]}
            onPersonClick={setSelectedPersonId}
          />
        )}

      {/* Per-person side panel (Commit 2 drill-down). Renders when
          selectedPersonId is set; otherwise nothing. Reads the
          person's per-slot detail from the existing scopedRows so
          there's no extra fetch. */}
      {selectedPerson && (
        <PersonDetailPanel
          person={selectedPerson}
          rows={q.data?.rows ?? []}
          months={monthsBetween(fromDate, toDate)}
          accent={palette[0]}
          onClose={() => setSelectedPersonId(null)}
        />
      )}

      {/* Categoría filter chips. Apply to per-slot detail + equity
          histogram only — the dashboard panels above stay
          unfiltered. Hidden when there's only one categoría (or
          none) since the toggle would do nothing. */}
      {categoryOptions.length > 1 && (
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
      )}

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
        <div className="space-y-6">
          <h2 className="mt-2 text-base font-semibold text-gray-800">
            Detalle por actividad
          </h2>
          {slotMeta.map((slot) => (
            <PerSlotChart
              key={slot.key}
              slot={slot}
              rows={scopedRows}
              months={monthsBetween(fromDate, toDate)}
              onPersonClick={setSelectedPersonId}
            />
          ))}

          <ChartCard
            title={
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                Fines de semana y festivos
              </span>
            }
            subtitle="Sábado, domingo o festivo · barras apiladas por mes (más oscuro = mes más reciente)."
          >
            {weekendData.list.length === 0 ? (
              <p className="text-sm text-gray-500">
                Nadie ha trabajado fines de semana o festivos en este rango.
              </p>
            ) : (
              <ResponsiveContainer
                width="100%"
                height={Math.max(180, weekendData.list.length * 36 + 60)}
              >
                <BarChart
                  data={weekendData.list}
                  layout="vertical"
                  // Right margin bumped to leave room for the per-row
                  // total label past the bar end.
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
                  {weekendData.months.map((m, i) => (
                    <Bar
                      key={m}
                      dataKey={m}
                      stackId="we"
                      fill={weekendShades[i]}
                      name={m}
                    >
                      <LabelList
                        dataKey={m}
                        position="center"
                        fill={textColorForBg(weekendShades[i])}
                        formatter={labelFormatter}
                        style={{ fontSize: 11, fontWeight: 600 }}
                      />
                      {i === weekendLastIdx && (
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

          <DetailTable rows={scopedRows} slotMeta={slotMeta} />
        </div>
      )}
    </>
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
function KpiStrip({ kpis }: { kpis: StatsKpis }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiTile
        label="Total turnos"
        value={kpis.total_assignments.toLocaleString("es-ES")}
        hint="En planificaciones publicadas y archivadas."
      />
      <KpiTile
        label="Sin cubrir"
        value={kpis.uncovered_count.toLocaleString("es-ES")}
        hint={
          kpis.total_assignments > 0
            ? `${kpis.uncovered_pct}% de los turnos del periodo.`
            : "Sin actividad en el periodo."
        }
        tone={kpis.uncovered_count > 0 ? "warning" : "neutral"}
      />
      <KpiTile
        label="Cambios de turno"
        value={(
          kpis.swap_offers_open
          + kpis.swap_offers_fulfilled
          + kpis.swap_offers_cancelled
        ).toLocaleString("es-ES")}
        hint={`${kpis.swap_offers_fulfilled} cubiertos · ${kpis.swap_offers_open} abiertos · ${kpis.swap_offers_cancelled} cancelados`}
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
      <KpiTile
        label="Asignación / FTE"
        value={
          kpis.total_fte > 0
            ? (kpis.total_assignments / kpis.total_fte).toFixed(1)
            : "—"
        }
        hint="Turnos medios por miembro a tiempo completo."
      />
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
  onPersonClick,
}: {
  data: StatsCalendarResponse;
  accent: string;
  onPersonClick?: (personId: number) => void;
}) {
  const [mode, setMode] = useState<HeatmapMode>("shifts");

  const days = useMemo(
    () => daysBetween(data.from_date, data.to_date),
    [data.from_date, data.to_date],
  );

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

        {data.persons.length === 0 ? (
          <p className="mt-4 text-xs text-gray-500">
            No hay miembros activos en el equipo.
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
              {data.persons.map((p) => {
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

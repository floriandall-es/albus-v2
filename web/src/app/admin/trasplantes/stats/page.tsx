"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft } from "lucide-react";
import {
  api,
  personLastName,
  type TransplantStats,
  type TransplantStatsSurgeon,
} from "@/lib/api";
import {
  Card,
  Empty,
  ErrorText,
  PageHeader,
} from "@/components/admin/ui";
import { useAccentHex, useAccentPalette } from "@/lib/use-accent";

/**
 * Stats dashboard for the transplant case log.
 *
 *   - Hero card: headline total + the secondary numbers
 *     organised as a dashboard summary, no longer four sparse
 *     tiles spread across the page.
 *   - Per-month chart: stacked explante + implante, muted
 *     teal/amber palette. Cross-hospital was a near-invisible
 *     overlay and is surfaced in the hero instead.
 *   - Surgeon participation: horizontal stacked bars (primary +
 *     secondary), one row per surgeon, sorted by primary desc.
 *     Reads as a leaderboard at a glance — the previous bare
 *     numeric table was correct but visually dead.
 */
export default function TrasplantesStatsPage() {
  // Period filter: a year + an optional single month ("Todos" = the
  // whole year). Everything re-fetches when either changes.
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(currentYear);
  const [month, setMonth] = useState<number | "all">("all");
  // Per-user accent (migration 0065) — used by the kept monthly
  // trend charts. The per-surgeon event charts use the fixed mockup
  // palette.
  const brandHex600 = useAccentHex(600);

  // The API filters by case date; derive the [from, to] range from the
  // year + month selection.
  const { from, to } = useMemo(() => {
    if (month === "all") {
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    const mm = String(month).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    return {
      from: `${year}-${mm}-01`,
      to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
    };
  }, [year, month]);

  const stats = useQuery({
    queryKey: ["transplants-stats", from, to],
    queryFn: () => api.transplantStats({ from, to }),
  });

  // Unfiltered fetch — drives the year dropdown options AND the stable
  // surgeon roster, so every event chart shows the same surgeons in the
  // same order (including those with zero activity in the period).
  const allStats = useQuery({
    queryKey: ["transplants-stats", "all"],
    queryFn: () => api.transplantStats({}),
  });

  const data = stats.data;

  const yearOptions = useMemo(() => {
    const set = new Set<number>();
    for (const m of allStats.data?.months ?? []) {
      set.add(Number(m.period.slice(0, 4)));
    }
    set.add(currentYear);
    return Array.from(set).sort((a, b) => b - a);
  }, [allStats.data, currentYear]);

  // Stable, alphabetical surgeon roster from the all-time data.
  const roster = useMemo(() => {
    const src = allStats.data?.surgeons ?? data?.surgeons ?? [];
    const seen = new Map<number, string>();
    for (const s of src) {
      if (!seen.has(s.person_id)) {
        seen.set(s.person_id, personLastName({ name: s.person_name }));
      }
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [allStats.data, data]);

  // Per-surgeon stats for the selected period, indexed by person.
  const byId = useMemo(() => {
    const m = new Map<number, TransplantStatsSurgeon>();
    for (const s of data?.surgeons ?? []) m.set(s.person_id, s);
    return m;
  }, [data]);

  // One row per roster surgeon carrying every metric the six event
  // charts need. Surgeons with no activity in the period stay in the
  // list at zero (matches the mockup — e.g. Pastor showing 0).
  const eventRows = useMemo(() => {
    return roster.map((r) => {
      const s = byId.get(r.id);
      const explantes =
        (s?.explante_primary ?? 0) + (s?.explante_secondary ?? 0);
      const implantes1 = s?.implante_primary ?? 0;
      const implantes2 = s?.implante_secondary ?? 0;
      const noValidos = s?.no_valido_count ?? 0;
      return {
        id: r.id,
        name: r.name,
        totales: explantes + implantes1 + implantes2,
        explantes,
        implantes1,
        implantes2,
        noValidos,
        // % of this surgeon's explantes that turned out non-valid.
        noValidosPct:
          explantes > 0 ? Math.round((noValidos / explantes) * 100) : 0,
      };
    });
  }, [roster, byId]);

  // Surgeon colour-order for the per-month-per-surgeon chart (kept from
  // the previous design): grand total desc, zeros dropped.
  const totalRows = useMemo(() => {
    if (!data) return [] as SurgeonTotalRow[];
    return data.surgeons
      .map((s) => {
        const explantes = s.explante_primary + s.explante_secondary;
        const implantes = s.implante_primary + s.implante_secondary;
        return {
          person_id: s.person_id,
          display_name: personLastName({ name: s.person_name }),
          explantes,
          implantes,
          total: explantes + implantes,
        };
      })
      .filter((r) => r.total > 0)
      .sort(
        (a, b) =>
          b.total - a.total
          || b.explantes - a.explantes
          || a.display_name.localeCompare(b.display_name),
      );
  }, [data]);

  return (
    <>
      <PageHeader
        title="Estadísticas de trasplantes"
        action={
          <Link
            href="/admin/trasplantes"
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeft className="h-4 w-4 text-gray-500" />
            Volver
          </Link>
        }
      />

      {/* Compact filter bar — month + year selectors. "Todos" = the
          whole year. Matches the list page toolbar style. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-soft">
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
          Periodo
        </span>
        <select
          value={month}
          onChange={(e) =>
            setMonth(e.target.value === "all" ? "all" : Number(e.target.value))
          }
          aria-label="Mes"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="all">Todos los meses</option>
          {MONTH_NAMES.map((mn, i) => (
            <option key={mn} value={i + 1}>
              {mn}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          aria-label="Año"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-gray-500">
          Por fecha del caso
        </span>
      </div>

      {stats.isLoading && (
        <div className="text-sm text-gray-500">Cargando…</div>
      )}
      {stats.isError && (
        <ErrorText>{(stats.error as Error).message}</ErrorText>
      )}

      {data && data.total_cases === 0 && (
        <Empty>
          Aún no hay trasplantes registrados en este rango.
        </Empty>
      )}

      {data && data.total_cases > 0 && (
        <div className="space-y-4">
          {/* HERO — single tall card. Headline left, secondary
              numbers in a 2x2 grid on the right. Replaces the
              four bare KPI tiles. */}
          <Card>
            <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-[auto_1fr] md:items-center">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  Trasplantes
                </div>
                <div className="mt-1 text-5xl font-bold text-gray-900 tabular-nums leading-none">
                  {data.total_cases}
                </div>
                <div className="mt-2 text-sm text-gray-500">
                  {monthSpanLabel(data.months)}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 border-l border-gray-100 md:pl-6">
                <SummaryStat
                  label="Procedimientos"
                  value={data.total_procedures}
                  detail={
                    data.total_procedures > 0
                      ? `${data.explante_total} explantes · ${data.implante_total} implantes`
                      : undefined
                  }
                />
                <SummaryStat
                  label="Cross-hospital"
                  value={data.cross_hospital_cases}
                  detail={`${pct(data.cross_hospital_cases, data.total_cases)} del total`}
                  accent="violet"
                />
                <SummaryStat
                  label="Cirujanos"
                  value={data.surgeons.length}
                  detail="con casos en el rango"
                />
              </div>
            </div>
          </Card>

          {/* EVENTOS DE TRASPLANTE — six per-surgeon vertical-bar
              charts. Same roster + order across all six so the bars
              line up column-to-column. */}
          <div>
            <h2 className="mb-3 text-base font-semibold text-gray-800">
              Eventos de trasplante
            </h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <SurgeonBars
                title="Trasplantes totales"
                color="#10b981"
                rows={eventRows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  value: r.totales,
                  label: String(r.totales),
                }))}
              />
              <SurgeonBars
                title="Explantes"
                color="#0ea5e9"
                rows={eventRows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  value: r.explantes,
                  label: String(r.explantes),
                }))}
              />
              <SurgeonBars
                title="No válidos"
                subtitle="Órganos explantados no trasplantados"
                color="#64748b"
                rows={eventRows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  value: r.noValidos,
                  label: String(r.noValidos),
                }))}
              />
              <SurgeonBars
                title="No válidos %"
                subtitle="Sobre los explantes de cada cirujano"
                color="#94a3b8"
                rows={eventRows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  value: r.noValidosPct,
                  label: `${r.noValidosPct}%`,
                }))}
              />
              <SurgeonBars
                title="Implantes 1"
                subtitle="Como cirujano principal"
                color="#8b5cf6"
                rows={eventRows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  value: r.implantes1,
                  label: String(r.implantes1),
                }))}
              />
              <SurgeonBars
                title="Implantes 2"
                subtitle="Como segundo cirujano"
                color="#f59e0b"
                rows={eventRows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  value: r.implantes2,
                  label: String(r.implantes2),
                }))}
              />
            </div>
          </div>

          {/* PER-MONTH CHART — muted teal/amber palette, no
              cross-hospital overlay (visible in the hero). */}
          <Card>
            <div className="p-5">
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-gray-800">
                  Trasplantes por mes
                </h3>
                <div className="flex items-center gap-3 text-[11px] text-gray-500">
                  <LegendDot color="#f59e0b" label="Explantes" />
                  <LegendDot color={brandHex600} label="Implantes" />
                </div>
              </div>
              <p className="mb-3 text-xs text-gray-500">
                Stacked por procedimiento. {data.total_procedures} eventos en
                {" "}
                {data.months.length} mes
                {data.months.length === 1 ? "" : "es"}.
              </p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.months.map((m) => ({
                      month: monthLabel(m.period),
                      Explantes: m.explante_count,
                      Implantes: m.implante_count,
                    }))}
                    margin={{ top: 10, right: 16, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: "#64748b", fontSize: 11 }}
                      axisLine={{ stroke: "#e5e7eb" }}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: "#64748b", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(13,148,136,0.06)" }}
                      contentStyle={{
                        background: "white",
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar
                      dataKey="Explantes"
                      stackId="proc"
                      fill="#f59e0b"
                      radius={[0, 0, 0, 0]}
                    />
                    <Bar
                      dataKey="Implantes"
                      stackId="proc"
                      fill={brandHex600}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </Card>

          {/* PROCEDIMIENTOS POR MES Y CIRUJANO — same x-axis as
              "Trasplantes por mes" but stacked by surgeon
              instead of by procedure type. Lets admins read
              "who carried Q3" at a glance. Palette is assigned
              client-side from the global surgeon order so
              colors stay stable across months. */}
          <MonthPerSurgeonChart data={data} surgeonOrder={totalRows} />
        </div>
      )}
    </>
  );
}

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

type SurgeonBarsRow = {
  id: number;
  name: string;
  value: number;
  label: string;
};

/** One of the six per-surgeon "Eventos de trasplante" charts. Simple
 * vertical bars in a light track — bar height is the value scaled to
 * the chart's own max, the label (count or %) sits below each bar.
 * Every chart receives the same roster in the same order so columns
 * line up across charts. */
function SurgeonBars({
  title,
  subtitle,
  rows,
  color,
}: {
  title: string;
  subtitle?: string;
  rows: SurgeonBarsRow[];
  color: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card>
      <div className="p-5">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
        )}
        {rows.length === 0 ? (
          <p className="mt-4 text-xs text-gray-400">
            Sin datos en este periodo.
          </p>
        ) : (
          <div className="mt-4 flex items-end gap-1.5 sm:gap-2">
            {rows.map((r) => {
              // Give any non-zero value a visible sliver; zero stays flat.
              const h = r.value > 0 ? Math.max(6, (r.value / max) * 100) : 0;
              return (
                <div
                  key={r.id}
                  className="flex min-w-0 flex-1 flex-col items-center"
                >
                  <div
                    className="flex h-28 w-full items-end overflow-hidden rounded-md bg-gray-100/80"
                    title={`${r.name}: ${r.label}`}
                  >
                    <div
                      className="w-full rounded-md transition-[height]"
                      style={{ height: `${h}%`, backgroundColor: color }}
                    />
                  </div>
                  <div className="mt-1.5 w-full truncate text-center text-[11px] text-gray-600">
                    {r.name}
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-gray-900">
                    {r.label}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

type SurgeonTotalRow = {
  person_id: number;
  display_name: string;
  explantes: number;
  implantes: number;
  total: number;
};

// Stable palette for the per-month stacked-by-surgeon chart. Tuned
// to look distinct against each other AND not collide with the
// brand teal / amber used by the other charts on the page. Cycles
// when there are more surgeons than colours (very rare).
const SURGEON_PALETTE = [
  "#0d9488", // teal-600 (brand)
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#0ea5e9", // sky-500
  "#ef4444", // red-500
  "#84cc16", // lime-500
  "#d946ef", // fuchsia-500
  "#64748b", // slate-500
  "#f97316", // orange-500
  "#10b981", // emerald-500
];

/** Vertical stacked bar chart: one bar per month, each bar stacked
 * by surgeon attribution. Answers "who carried which months".
 *
 * The palette is assigned client-side from the totals-leaderboard
 * order (surgeonOrder prop) so colours stay stable across months
 * and the top performer always gets the first palette entry. */
function MonthPerSurgeonChart({
  data,
  surgeonOrder,
}: {
  data: TransplantStats;
  surgeonOrder: SurgeonTotalRow[];
}) {
  // Swap the legacy teal slot in SURGEON_PALETTE for the caller's
  // accent so the top performer's bar segment matches the rest of
  // the page's accent treatment.
  const palette = useAccentPalette(SURGEON_PALETTE);
  // Build a deterministic palette: surgeons by descending grand
  // total → first SURGEON_PALETTE entry first. Keys keyed by
  // person_id so chart segments + legend match.
  const colorById = useMemo(() => {
    const map = new Map<number, string>();
    surgeonOrder.forEach((s, i) => {
      map.set(s.person_id, palette[i % palette.length]);
    });
    return map;
  }, [surgeonOrder, palette]);

  const nameById = useMemo(() => {
    const map = new Map<number, string>();
    surgeonOrder.forEach((s) => {
      map.set(s.person_id, s.display_name);
    });
    // Also catch any surgeon who appears in per_surgeon but had 0
    // primary+secondary in surgeons list (defensive — shouldn't
    // happen since they wouldn't show up in surgeons at all then).
    for (const s of data.surgeons) {
      if (!map.has(s.person_id)) {
        map.set(s.person_id, personLastName({ name: s.person_name }));
      }
    }
    return map;
  }, [surgeonOrder, data.surgeons]);

  // Chart data: one row per month, one numeric key per surgeon
  // (the count for that surgeon that month, or 0 if absent).
  const orderedIds = surgeonOrder.map((s) => s.person_id);
  const chartData = data.months.map((m) => {
    const row: Record<string, string | number> = { month: monthLabel(m.period) };
    const ps = m.per_surgeon ?? [];
    const seen = new Set(ps.map((s) => s.person_id));
    for (const id of orderedIds) {
      const hit = ps.find((s) => s.person_id === id);
      row[String(id)] = hit ? hit.count : 0;
    }
    // Surgeons not in orderedIds (defensive) — drop into a
    // catch-all so the totals don't lie.
    let other = 0;
    for (const s of ps) {
      if (!seen.has(s.person_id)) continue;
      if (!orderedIds.includes(s.person_id)) other += s.count;
    }
    if (other > 0) row.__other__ = other;
    return row;
  });

  // Highest stack across months — used by the user-facing
  // total-procedimientos line under the title.
  const grandTotal = useMemo(
    () => surgeonOrder.reduce((acc, s) => acc + s.total, 0),
    [surgeonOrder],
  );

  // Server backend may be older and omit per_surgeon. Hide the
  // chart entirely when no month carries the new field (the
  // chart would otherwise render as a flat empty axis).
  const hasData = data.months.some(
    (m) => (m.per_surgeon ?? []).length > 0,
  );
  if (!hasData) return null;

  return (
    <Card>
      <div className="p-5">
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-800">
            Procedimientos por mes y cirujano
          </h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
            {surgeonOrder.map((s) => (
              <LegendDot
                key={s.person_id}
                color={colorById.get(s.person_id) ?? "#64748b"}
                label={s.display_name}
              />
            ))}
          </div>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Stacked por cirujano. Cada procedimiento cuenta una vez por
          principal y una vez por segundo. {grandTotal} eventos en{" "}
          {data.months.length} mes
          {data.months.length === 1 ? "" : "es"}.
        </p>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 10, right: 16, left: 0, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis
                dataKey="month"
                tick={{ fill: "#64748b", fontSize: 11 }}
                axisLine={{ stroke: "#e5e7eb" }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: "#64748b", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: "rgba(13,148,136,0.06)" }}
                contentStyle={{
                  background: "white",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value, key) => [
                  value,
                  nameById.get(Number(key)) ?? String(key),
                ]}
              />
              {orderedIds.map((id, i) => (
                <Bar
                  key={id}
                  dataKey={String(id)}
                  stackId="surgeon"
                  fill={colorById.get(id) ?? "#64748b"}
                  radius={i === orderedIds.length - 1 ? [4, 4, 0, 0] : 0}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}

/** Secondary number inside the hero card. Restrained, two-line,
 * with an optional accent colour for "Cross-hospital" so the
 * cross-hospital share stays visually separable from local
 * counts. */
function SummaryStat({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string | number;
  detail?: string;
  accent?: "violet";
}) {
  const valueClass =
    accent === "violet" ? "text-violet-700" : "text-gray-900";
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}
      >
        {value}
      </div>
      {detail && (
        <div className="mt-0.5 text-[11px] text-gray-500">{detail}</div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-sm"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

function pct(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((100 * part) / total)}%`;
}

function monthLabel(periodIso: string): string {
  const [y, m] = periodIso.split("-").map(Number);
  const months = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  return `${months[m - 1]} ${String(y).slice(-2)}`;
}

/** "feb 24 → may 26 · 28 meses" — period summary for the hero. */
function monthSpanLabel(
  months: { period: string }[],
): string {
  if (months.length === 0) return "";
  if (months.length === 1) {
    return monthLabel(months[0].period);
  }
  const first = monthLabel(months[0].period);
  const last = monthLabel(months[months.length - 1].period);
  return `${first} → ${last} · ${months.length} mes${months.length === 1 ? "" : "es"}`;
}

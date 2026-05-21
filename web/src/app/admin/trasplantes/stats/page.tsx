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
import { api, personLastName } from "@/lib/api";
import {
  Card,
  Empty,
  ErrorText,
  PageHeader,
} from "@/components/admin/ui";

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
  // Optional date range filter — the chart + table re-fetch when
  // either bound changes.
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const stats = useQuery({
    queryKey: ["transplants-stats", from || null, to || null],
    queryFn: () =>
      api.transplantStats({
        from: from || undefined,
        to: to || undefined,
      }),
  });

  const data = stats.data;

  // Max primary+secondary across all surgeons, used as the
  // domain for the participation bars so widths stay comparable.
  const maxSurgeonBarValue = useMemo(() => {
    if (!data) return 1;
    return Math.max(
      1,
      ...data.surgeons.map((s) => s.primary_count + s.secondary_count),
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

      {/* Compact filter bar — match the toolbar style of the list
          page so the two views feel like the same product. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-soft">
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
          Periodo
        </span>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Desde"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <span className="text-xs text-gray-400">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Hasta"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <span className="ml-auto text-xs text-gray-500">
          {from || to ? "Filtrado por fecha del caso" : "Histórico completo"}
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
                  <LegendDot color="#0d9488" label="Implantes" />
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
                      fill="#0d9488"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </Card>

          {/* SURGEON PARTICIPATION — horizontal stacked bars.
              Reads like a leaderboard. Width is normalised to
              the busiest surgeon so smaller bars stay comparable
              instead of all running to the edge. */}
          <Card>
            <div className="p-5">
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-gray-800">
                  Participación por cirujano
                </h3>
                <div className="flex items-center gap-3 text-[11px] text-gray-500">
                  <LegendDot color="#0d9488" label="Cirujano principal" />
                  <LegendDot color="#5eead4" label="Segundo cirujano" />
                </div>
              </div>
              <p className="mb-4 text-xs text-gray-500">
                Procedimientos en los que cada cirujano aparece como
                principal o segundo. Ordenado por principal.
              </p>
              <ul className="space-y-3">
                {data.surgeons.map((s) => {
                  const total = s.primary_count + s.secondary_count;
                  const primaryPct =
                    (s.primary_count / maxSurgeonBarValue) * 100;
                  const secondaryPct =
                    (s.secondary_count / maxSurgeonBarValue) * 100;
                  return (
                    <li key={s.person_id} className="grid grid-cols-[140px_1fr_auto] items-center gap-3">
                      <div className="truncate text-sm font-medium text-gray-800">
                        {personLastName({ name: s.person_name })}
                      </div>
                      <div className="relative h-6 rounded-md bg-gray-100">
                        <div
                          className="absolute inset-y-0 left-0 flex items-center rounded-l-md bg-brand-600 px-2 text-[11px] font-semibold text-white"
                          style={{ width: `${primaryPct}%` }}
                          title={`Principal: ${s.primary_count}`}
                        >
                          {s.primary_count > 0
                          && primaryPct > 6
                          && s.primary_count}
                        </div>
                        <div
                          className="absolute inset-y-0 flex items-center bg-brand-300 px-2 text-[11px] font-medium text-brand-900"
                          style={{
                            left: `${primaryPct}%`,
                            width: `${secondaryPct}%`,
                            borderTopRightRadius:
                              primaryPct + secondaryPct >= 99 ? 6 : 0,
                            borderBottomRightRadius:
                              primaryPct + secondaryPct >= 99 ? 6 : 0,
                          }}
                          title={`Segundo: ${s.secondary_count}`}
                        >
                          {s.secondary_count > 0
                          && secondaryPct > 6
                          && s.secondary_count}
                        </div>
                      </div>
                      <div className="text-right text-xs tabular-nums">
                        <span className="font-semibold text-gray-900">
                          {total}
                        </span>
                        <span className="ml-1 text-gray-400">
                          ({s.explante_count}E / {s.implante_count}I)
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Card>
        </div>
      )}
    </>
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

"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import {
  Card,
  Empty,
  ErrorText,
  PageHeader,
  TextField,
} from "@/components/admin/ui";

/**
 * Stats dashboard for the transplant case log.
 *
 *   - Header: total cases, total procedures, cross-hospital
 *     count (the three numbers the customer asks about first).
 *   - Per-month bar chart: stacked explante + implante counts.
 *     Stacking matches /admin/stats convention; the customer
 *     cares about monthly throughput more than the explante /
 *     implante split, but seeing them side by side surfaces
 *     "donor-only month" patterns.
 *   - Surgeon participation table: each surgeon's primary +
 *     secondary count, plus a per-type split. Sorted by
 *     primary_count desc (driving metric).
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

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            label="Desde"
            type="date"
            value={from}
            onChange={setFrom}
          />
          <TextField label="Hasta" type="date" value={to} onChange={setTo} />
          <p className="text-xs text-gray-500 pl-1 pb-1.5">
            Filtra por fecha del caso. Sin fechas = histórico completo.
          </p>
        </div>
      </Card>

      {stats.isLoading && (
        <div className="mt-4 text-sm text-gray-500">Cargando…</div>
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
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Trasplantes" value={data.total_cases} />
            <Kpi label="Procedimientos" value={data.total_procedures} />
            <Kpi
              label="Cross-hospital"
              value={data.cross_hospital_cases}
              hint={`${pct(data.cross_hospital_cases, data.total_cases)} del total`}
            />
            <Kpi
              label="Explantes / Implantes"
              value={`${data.explante_total} / ${data.implante_total}`}
            />
          </div>

          <div className="mt-4">
            <Card>
              <h3 className="mb-3 text-sm font-semibold text-gray-700">
                Trasplantes por mes
              </h3>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.months.map((m) => ({
                      month: monthLabel(m.period),
                      Explantes: m.explante_count,
                      Implantes: m.implante_count,
                      "Cross-hospital": m.cross_hospital_count,
                    }))}
                    margin={{ top: 10, right: 16, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis
                      dataKey="month"
                      tick={{ fill: "#475569", fontSize: 11 }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: "#475569", fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "white",
                        border: "1px solid #e5e7eb",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {/* Explante + Implante stacked on one bar
                        (procedure throughput); cross-hospital is
                        a separate transparent bar so the customer
                        can eyeball the share without losing the
                        per-type counts to a sub-stack. */}
                    <Bar
                      dataKey="Explantes"
                      stackId="proc"
                      fill="#f59e0b"
                    />
                    <Bar
                      dataKey="Implantes"
                      stackId="proc"
                      fill="#10b981"
                    />
                    <Bar
                      dataKey="Cross-hospital"
                      fill="#7c3aed"
                      fillOpacity={0.6}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="mt-4">
            <Card>
              <h3 className="mb-3 text-sm font-semibold text-gray-700">
                Participación por cirujano
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b border-gray-100">
                      <th className="py-2 pr-3 font-medium">Cirujano</th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Principal
                      </th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Segundo
                      </th>
                      <th className="py-2 pr-3 font-medium text-right">
                        Explantes
                      </th>
                      <th className="py-2 pr-0 font-medium text-right">
                        Implantes
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.surgeons.map((s) => (
                      <tr key={s.person_id}>
                        <td className="py-2 pr-3 text-gray-900">
                          {s.person_name}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums font-medium text-gray-900">
                          {s.primary_count}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-gray-700">
                          {s.secondary_count}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-gray-700">
                          {s.explante_count}
                        </td>
                        <td className="py-2 pr-0 text-right tabular-nums text-gray-700">
                          {s.implante_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-soft">
      <div className="text-xs uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-xs text-gray-500">{hint}</div>
      )}
    </div>
  );
}

function pct(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((100 * part) / total)}%`;
}

function monthLabel(periodIso: string): string {
  // periodIso is YYYY-MM-01. Show "ene 26" for the chart axis
  // (compact: most months render fine, the customer will get a
  // dense bar count from 28 months of data).
  const [y, m] = periodIso.split("-").map(Number);
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
  return `${months[m - 1]} ${String(y).slice(-2)}`;
}

"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { api } from "@/lib/api";
import { Card, EmptyState, PageHeader } from "@/components/admin/ui";
import {
  MonthPicker,
  isoFromMonthYear,
} from "@/components/admin/month-picker";
import { useAccentHex, useAccentPalette } from "@/lib/use-accent";

/**
 * Member-facing personal stats (sprint 30 / migration N/A).
 *
 * Shows the caller's own performed shifts in a configurable date
 * range. Slimmer than /admin/stats — no per-person leaderboard
 * (there's only one person), no scope toggle (the API filters
 * server-side). Three panels:
 *
 *   1. KPI row: total turnos + weekend/holiday subset
 *   2. Per-actividad bar chart (horizontal): which slot types
 *      and how many of each
 *   3. Per-month stacked chart: same totals but split per month
 *      so trends are visible
 *
 * Source = PUBLISHED + ARCHIVED schedules (the admin endpoint
 * convention). Draft assignments don't count — they may still
 * change.
 */

const FALLBACK_PALETTE = [
  "#0d9488", // teal — swapped for the user's accent at render time
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
  const y = Number(yyyyMm01.slice(0, 4));
  const m = Number(yyyyMm01.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yyyyMm01.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  // "2026-05" → "may 26"
  const months = [
    "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
  ];
  const m = Number(ym.slice(5, 7));
  const y = ym.slice(2, 4);
  return `${months[m - 1]} ${y}`;
}

export default function MyStatsPage() {
  const today = new Date();
  // Default range: year-to-date. Members usually want "what have I
  // done this year"; year boundaries also align with how guardias
  // are summarised in Spanish hospital agendas.
  const [fromPeriod, setFromPeriod] = useState<string>(
    isoFromMonthYear(0, today.getFullYear()),
  );
  const [toPeriod, setToPeriod] = useState<string>(
    isoFromMonthYear(today.getMonth(), today.getFullYear()),
  );

  const fromDate = fromPeriod;
  const toDate = lastDayOfMonthIso(toPeriod);

  const q = useQuery({
    queryKey: ["my-stats", fromDate, toDate],
    queryFn: () =>
      api.myStatsAssignments({ from: fromDate, to: toDate }),
  });

  const palette = useAccentPalette(FALLBACK_PALETTE);
  const accentHex = useAccentHex(600);

  // Slot meta: stable id → color/name mapping derived from the
  // rows. Slot.color (if set) wins; otherwise we draw from the
  // accent-aware fallback palette. Includes team_role disambiguation
  // so "Trasplante / Implante 1" and "Trasplante / Implante 2"
  // become two distinct bars.
  type SlotMeta = {
    key: string;
    label: string;
    color: string;
  };
  const slotMeta = useMemo(() => {
    const m = new Map<string, SlotMeta>();
    let idx = 0;
    for (const r of q.data?.rows ?? []) {
      const key = `${r.slot_id}|${r.team_role_id ?? ""}`;
      if (m.has(key)) continue;
      const label = r.team_role_label
        ? `${r.slot_name} · ${r.team_role_label}`
        : r.slot_name;
      m.set(key, {
        key,
        label,
        color: r.slot_color ?? palette[idx % palette.length],
      });
      idx += 1;
    }
    return Array.from(m.values()).sort((a, b) =>
      a.label.localeCompare(b.label, "es"),
    );
  }, [q.data, palette]);

  // Per-actividad totals across the whole range (horizontal bar
  // chart). One row per slot/role; sorted by count descending so
  // the heaviest activity sits on top.
  type ActividadRow = { key: string; label: string; count: number; color: string };
  const perActividad = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of q.data?.rows ?? []) {
      const k = `${r.slot_id}|${r.team_role_id ?? ""}`;
      totals.set(k, (totals.get(k) ?? 0) + r.count);
    }
    const rows: ActividadRow[] = [];
    for (const s of slotMeta) {
      const n = totals.get(s.key) ?? 0;
      if (n === 0) continue;
      rows.push({ key: s.key, label: s.label, count: n, color: s.color });
    }
    rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"));
    return rows;
  }, [q.data, slotMeta]);

  // Per-month stacked chart. One row per month in the range; each
  // numeric key on the row is a slot label → count.
  const months = useMemo(
    () => monthsBetween(fromDate, toDate),
    [fromDate, toDate],
  );
  const perMonth = useMemo(() => {
    const totalsByMonthSlot = new Map<string, Map<string, number>>();
    for (const r of q.data?.rows ?? []) {
      const k = `${r.slot_id}|${r.team_role_id ?? ""}`;
      let perSlot = totalsByMonthSlot.get(r.year_month);
      if (!perSlot) {
        perSlot = new Map<string, number>();
        totalsByMonthSlot.set(r.year_month, perSlot);
      }
      perSlot.set(k, (perSlot.get(k) ?? 0) + r.count);
    }
    return months.map((m) => {
      const row: Record<string, string | number> = { month: monthLabel(m) };
      const perSlot = totalsByMonthSlot.get(m) ?? new Map<string, number>();
      for (const s of slotMeta) {
        row[s.label] = perSlot.get(s.key) ?? 0;
      }
      return row;
    });
  }, [q.data, slotMeta, months]);

  const totalTurnos = useMemo(
    () => (q.data?.rows ?? []).reduce((acc, r) => acc + r.count, 0),
    [q.data],
  );
  const totalWeekendOrHoliday = useMemo(
    () =>
      (q.data?.rows ?? []).reduce(
        (acc, r) => acc + r.weekend_or_holiday_count,
        0,
      ),
    [q.data],
  );

  return (
    <>
      <PageHeader title="Mis estadísticas" />

      {/* Range picker + quick-pick presets. Same widget the admin
          page uses for parity. */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="w-60">
          <MonthPicker
            label="Desde"
            value={fromPeriod}
            onChange={setFromPeriod}
          />
        </div>
        <div className="w-60">
          <MonthPicker
            label="Hasta"
            value={toPeriod}
            onChange={setToPeriod}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 pb-2">
          <PresetButton
            label="Este año"
            onClick={() => {
              setFromPeriod(isoFromMonthYear(0, today.getFullYear()));
              setToPeriod(
                isoFromMonthYear(today.getMonth(), today.getFullYear()),
              );
            }}
          />
          <PresetButton
            label="Últimos 12 meses"
            onClick={() => {
              const fromY = today.getFullYear() - (today.getMonth() === 0 ? 0 : 0);
              const fromM = today.getMonth();
              const start = new Date(fromY, fromM, 1);
              start.setMonth(start.getMonth() - 11);
              setFromPeriod(
                isoFromMonthYear(start.getMonth(), start.getFullYear()),
              );
              setToPeriod(
                isoFromMonthYear(today.getMonth(), today.getFullYear()),
              );
            }}
          />
          <PresetButton
            label="Año pasado"
            onClick={() => {
              setFromPeriod(isoFromMonthYear(0, today.getFullYear() - 1));
              setToPeriod(isoFromMonthYear(11, today.getFullYear() - 1));
            }}
          />
        </div>
      </div>

      <p className="mb-6 -mt-2 text-xs text-gray-500">
        Cuenta turnos de planificaciones publicadas y archivadas.
        Los borradores no se incluyen.
      </p>

      {q.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}

      {q.data && totalTurnos === 0 && (
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Sin turnos en este rango"
          description="No has cubierto turnos publicados en las fechas seleccionadas. Cambia el rango o vuelve cuando se publique una planificación."
        />
      )}

      {q.data && totalTurnos > 0 && (
        <div className="space-y-6">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiCard
              label="Turnos cubiertos"
              value={totalTurnos}
              accent={accentHex}
              sublabel={`En ${perActividad.length} actividad${perActividad.length === 1 ? "" : "es"}`}
            />
            <KpiCard
              label="En fin de semana o festivo"
              value={totalWeekendOrHoliday}
              accent="#f59e0b"
              sublabel={
                totalTurnos > 0
                  ? `${Math.round((totalWeekendOrHoliday / totalTurnos) * 100)}% del total`
                  : undefined
              }
            />
          </div>

          {/* Per-actividad horizontal bars */}
          <Card>
            <div className="p-5">
              <h3 className="mb-1 text-sm font-semibold text-gray-800">
                Por actividad
              </h3>
              <p className="mb-3 text-xs text-gray-500">
                Total de turnos por tipo de actividad en el rango.
              </p>
              <ResponsiveContainer
                width="100%"
                height={Math.max(160, perActividad.length * 36 + 60)}
              >
                <BarChart
                  data={perActividad}
                  layout="vertical"
                  margin={{ top: 8, right: 32, left: 16, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "#4b5563" }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "#4b5563" }}
                    width={140}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(15,118,110,0.06)" }}
                    contentStyle={{
                      fontSize: 12,
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                    }}
                  />
                  <Bar dataKey="count" name="Turnos" radius={[0, 4, 4, 0]}>
                    {perActividad.map((row) => (
                      <Cell key={row.key} fill={row.color} />
                    ))}
                    <LabelList
                      dataKey="count"
                      position="right"
                      fill="#1f2937"
                      style={{ fontSize: 11, fontWeight: 600 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Per-month stacked bars */}
          <Card>
            <div className="p-5">
              <h3 className="mb-1 text-sm font-semibold text-gray-800">
                Por mes
              </h3>
              <p className="mb-3 text-xs text-gray-500">
                Turnos por mes, apilados por actividad.
              </p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={perMonth}
                  margin={{ top: 8, right: 16, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: "#4b5563" }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#4b5563" }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 12,
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                    }}
                  />
                  {slotMeta.map((s) => (
                    <Bar
                      key={s.key}
                      dataKey={s.label}
                      stackId="mes"
                      fill={s.color}
                      radius={[2, 2, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
              {/* Inline legend below the chart — Recharts' built-in
                  Legend gets cramped when there are many activity
                  bars; a simple wrapped row reads better. */}
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
                {slotMeta.map((s) => (
                  <li key={s.key} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.label}
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function KpiCard({
  label,
  value,
  sublabel,
  accent,
}: {
  label: string;
  value: number;
  sublabel?: string;
  accent: string;
}) {
  return (
    <Card>
      <div className="p-4">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          {label}
        </div>
        <div
          className="mt-1 text-3xl font-bold leading-tight"
          style={{ color: accent }}
        >
          {value}
        </div>
        {sublabel && (
          <div className="mt-0.5 text-xs text-gray-500">{sublabel}</div>
        )}
      </div>
    </Card>
  );
}

function PresetButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
    >
      {label}
    </button>
  );
}


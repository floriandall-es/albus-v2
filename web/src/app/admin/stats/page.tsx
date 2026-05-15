"use client";
import { useMemo, useState } from "react";
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
import { api, type StatsRow } from "@/lib/api";
import {
  Card,
  EmptyState,
  PageHeader,
} from "@/components/admin/ui";
import {
  MonthPicker,
  isoFromMonthYear,
} from "@/components/admin/month-picker";
import { BarChart3 } from "lucide-react";

// Slot palette fallback — slots without an admin-picked color rotate
// through this for chart legibility.
const FALLBACK_PALETTE = [
  "#0d9488", // teal
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

  // Pivot rows by slot for chart legends + color mapping.
  const slotMeta = useMemo(() => {
    const m = new Map<
      string,
      { slot_id: number; slot_name: string; color: string }
    >();
    let idx = 0;
    for (const r of q.data?.rows ?? []) {
      if (m.has(r.slot_name)) continue;
      m.set(r.slot_name, {
        slot_id: r.slot_id,
        slot_name: r.slot_name,
        color:
          r.slot_color
          ?? FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length],
      });
      idx += 1;
    }
    return Array.from(m.values()).sort((a, b) =>
      a.slot_name.localeCompare(b.slot_name),
    );
  }, [q.data]);

  // Chart: per person, weekend/holiday counts only.
  const weekendData = useMemo(() => {
    const persons = new Map<number, number>();
    for (const r of q.data?.rows ?? []) {
      persons.set(
        r.person_id,
        (persons.get(r.person_id) ?? 0) + r.weekend_or_holiday_count,
      );
    }
    return Array.from(persons.entries())
      .map(([pid, n]) => ({
        person:
          q.data?.rows.find((r) => r.person_id === pid)?.person_name
          ?? `#${pid}`,
        count: n,
      }))
      .sort((a, b) => a.person.localeCompare(b.person));
  }, [q.data]);

  const totalAssignments = useMemo(
    () =>
      (q.data?.rows ?? []).reduce((acc, r) => acc + r.count, 0),
    [q.data],
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
            {totalAssignments} asignaciones · {slotMeta.length} tipos de turno
            · planificaciones publicadas y archivadas.
          </div>
        )}
      </div>

      {q.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}
      {q.data && q.data.rows.length === 0 && (
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Sin datos en el rango seleccionado"
          description="Solo se contabilizan asignaciones de planificaciones publicadas o archivadas."
        />
      )}

      {q.data && q.data.rows.length > 0 && (
        <div className="space-y-6">
          {slotMeta.map((slot) => (
            <PerSlotChart
              key={slot.slot_name}
              slot={slot}
              rows={q.data!.rows}
              months={monthsBetween(fromDate, toDate)}
            />
          ))}

          <ChartCard
            title="Fines de semana y festivos por persona"
            subtitle="Solo cuenta las asignaciones en sábado, domingo o festivo."
          >
            <ResponsiveContainer
              width="100%"
              height={Math.max(220, weekendData.length * 36)}
            >
              <BarChart
                data={weekendData}
                layout="vertical"
                margin={{ top: 12, right: 16, left: 60, bottom: 4 }}
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
                <Bar dataKey="count" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <DetailTable rows={q.data.rows} slotMeta={slotMeta} />
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
}: {
  slot: { slot_id: number; slot_name: string; color: string };
  rows: StatsRow[];
  months: string[];
}) {
  // Pivot: one row per person, columns are months (count for THIS slot).
  // Skip persons with zero count for this slot — keeps the chart tight.
  const data = useMemo(() => {
    const byPid = new Map<number, { person: string; total: number; cells: Record<string, number> }>();
    for (const r of rows) {
      if (r.slot_name !== slot.slot_name) continue;
      let row = byPid.get(r.person_id);
      if (!row) {
        row = { person: r.person_name, total: 0, cells: {} };
        byPid.set(r.person_id, row);
      }
      row.cells[r.year_month] = (row.cells[r.year_month] ?? 0) + r.count;
      row.total += r.count;
    }
    const list = Array.from(byPid.values()).map((p) => {
      const out: Record<string, number | string> = {
        person: p.person,
        total: p.total,
      };
      for (const m of months) out[m] = p.cells[m] ?? 0;
      return out;
    });
    // Sort by total descending — heaviest contributor at top.
    list.sort((a, b) => (b.total as number) - (a.total as number));
    return list;
  }, [rows, slot.slot_name, months]);

  const shades = useMemo(
    () => shadeStops(slot.color, months.length),
    [slot.color, months.length],
  );

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
          {slot.slot_name}
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
          margin={{ top: 8, right: 20, left: 60, bottom: 4 }}
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
            />
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
  slotMeta: { slot_id: number; slot_name: string; color: string }[];
}) {
  // Pivot to person × slot totals for a precise readout under the
  // charts. Mirrors the BalanceStats panel idea but spans the whole
  // range instead of one schedule.
  const persons = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows) m.set(r.person_id, r.person_name);
    return Array.from(m.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
  }, [rows]);

  const totalBy = useMemo(() => {
    const t = new Map<string, number>(); // `${pid}|${slot_name}`
    for (const r of rows) {
      const k = `${r.person_id}|${r.slot_name}`;
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
                    key={s.slot_name}
                    className="px-3 py-2 text-right whitespace-nowrap"
                  >
                    <span className="inline-flex items-center gap-1 normal-case font-medium text-gray-700 text-xs tracking-normal">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: s.color }}
                      />
                      {s.slot_name}
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
                    const v = totalBy.get(`${pid}|${s.slot_name}`) ?? 0;
                    return (
                      <td
                        key={s.slot_name}
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

"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, personLastName, type StatsRow } from "@/lib/api";
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
  // Scope toggle. `null` means main team (Slot.group_id IS NULL);
  // a number means that group's sub-equipo. Defaults to main team
  // — the most common admin view. Pill only renders when at least
  // one sub-equipo exists, so single-team tenants see no clutter.
  const [scopeGroupId, setScopeGroupId] = useState<number | null>(null);

  const fromDate = fromPeriod; // YYYY-MM-01
  const toDate = lastDayOfMonthIso(toPeriod);

  const q = useQuery({
    queryKey: ["stats-assignments", fromDate, toDate],
    queryFn: () => api.statsAssignments({ from: fromDate, to: toDate }),
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: api.listGroups,
  });
  // Per-user accent: swap the default teal slot in the fallback
  // palette for the caller's pick.
  const palette = useAccentPalette(FALLBACK_PALETTE);

  // Filter raw rows once by the active scope. Everything
  // downstream (per-slot charts, weekend chart, detail table)
  // reads from `scopedRows` rather than q.data.rows directly so
  // a single source of truth drives the whole page.
  const scopedRows = useMemo(
    () =>
      (q.data?.rows ?? []).filter(
        (r) => (r.slot_group_id ?? null) === scopeGroupId,
      ),
    [q.data, scopeGroupId],
  );

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

  // Which groups actually have assignments in the current date
  // range. We hide pills for groups with zero rows so the toggle
  // stays useful — no point in offering a tab that's empty.
  const groupsWithData = useMemo(() => {
    const ids = new Set<number>();
    for (const r of q.data?.rows ?? []) {
      if (r.slot_group_id !== null) ids.add(r.slot_group_id);
    }
    return (groups.data ?? []).filter((g) => ids.has(g.id));
  }, [q.data, groups.data]);
  const hasMainTeamData = useMemo(
    () => (q.data?.rows ?? []).some((r) => r.slot_group_id === null),
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
            {totalAssignments} asignaciones · {slotMeta.length} actividades
            · planificaciones publicadas y archivadas.
          </div>
        )}
      </div>

      {/* Scope toggle. Render only when there's actually
          something to switch between — single-team tenants
          never see this pill. Switching to a sub-equipo flips
          every section below (per-slot charts, weekend chart,
          detail table) to that group's data in one go. */}
      {q.data && groupsWithData.length > 0 && (
        <div className="mb-5">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-soft">
            <ScopePill
              label="Equipo principal"
              active={scopeGroupId === null}
              disabled={!hasMainTeamData}
              onClick={() => setScopeGroupId(null)}
            />
            {groupsWithData.map((g) => (
              <ScopePill
                key={g.id}
                label={g.name}
                active={scopeGroupId === g.id}
                onClick={() => setScopeGroupId(g.id)}
              />
            ))}
          </div>
        </div>
      )}

      {q.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}
      {q.data && scopedRows.length === 0 && (
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Sin datos en el rango seleccionado"
          description={
            scopeGroupId === null
              ? "Solo se contabilizan asignaciones de planificaciones publicadas o archivadas."
              : "Este sub-equipo no tiene asignaciones publicadas en el rango seleccionado."
          }
        />
      )}

      {q.data && scopedRows.length > 0 && (
        <div className="space-y-6">
          {slotMeta.map((slot) => (
            <PerSlotChart
              key={slot.key}
              slot={slot}
              rows={scopedRows}
              months={monthsBetween(fromDate, toDate)}
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

// Single pill inside the scope-toggle bar. Visual style mirrors
// the ViewSwitcher segmented control elsewhere — the active tab
// is white-on-shadow against the gray track. `disabled` is for
// the rare case the main-team has zero data; we still show the
// pill but block it so the toggle layout doesn't shift around.
function ScopePill({
  label,
  active,
  disabled = false,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 "
        + (active
          ? "bg-brand-50 text-brand-700 shadow-sm"
          : "text-gray-600 hover:text-gray-900")
      }
    >
      {label}
    </button>
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
}) {
  // Pivot: one row per person, columns are months (count for THIS
  // slot/role). Skip persons with zero count for this slot to keep
  // the chart tight.
  const data = useMemo(() => {
    const byPid = new Map<number, { person: string; total: number; cells: Record<string, number> }>();
    for (const r of rows) {
      if (r.slot_id !== slot.slot_id) continue;
      if ((r.team_role_id ?? null) !== slot.team_role_id) continue;
      let row = byPid.get(r.person_id);
      if (!row) {
        row = { person: personLastName({ name: r.person_name }), total: 0, cells: {} };
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

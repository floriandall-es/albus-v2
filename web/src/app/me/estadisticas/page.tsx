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
import { api, type TeamComparison } from "@/lib/api";
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

// Tableau-10-derived categorical palette. The original Tailwind
// 500-shade set we shipped had pink + rose + violet + indigo all
// fighting each other on a single stacked bar; this is a
// designer-vetted sequence that stays harmonious when many slot
// types stack next to each other. Teal sits first so the user's
// accent (substituted at render time via useAccentPalette) lands
// on what's usually the highest-volume row.
const FALLBACK_PALETTE = [
  "#0d9488", // teal — replaced with user's accent at render time
  "#4e79a7", // muted blue
  "#f28e2b", // warm orange
  "#76b7b2", // soft teal
  "#59a14f", // muted green
  "#edc948", // mustard
  "#b07aa1", // dusty purple
  "#9c755f", // brown
  "#ff9da7", // soft pink
  "#bab0ab", // warm gray
];

// Libre / "absent" series — kept off the categorical palette and
// in its own emerald tone so it reads as the off-duty counterpart
// to working shifts (matches the "Libre" green used on the
// planning grid, /me/turnos and the PDF).
const LIBRE_COLOR = "#10b981";
const LIBRE_LABEL = "Libre";

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

  // Own approved absences for the same range. We count by *day*
  // (expand each range) so a 14-day vacation block contributes
  // 14 to "Libre", consistent with how clinicians think about
  // time off ("two weeks of vacation" = 14 days).
  const myAbsences = useQuery({
    queryKey: ["my-availability-requests"],
    queryFn: () => api.listMyAvailabilityRequests(),
  });
  const libreDaysByMonth = useMemo(() => {
    const map = new Map<string, number>();
    if (!myAbsences.data) return map;
    const rangeStart = new Date(`${fromDate}T00:00:00`);
    const rangeEnd = new Date(`${toDate}T00:00:00`);
    for (const b of myAbsences.data) {
      if (b.status !== "approved") continue;
      const [sy, sm, sd] = b.start_date.split("-").map(Number);
      const [ey, em, ed] = b.end_date.split("-").map(Number);
      const start = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, ed);
      // Clip to the selected date range.
      const cur = new Date(Math.max(start.getTime(), rangeStart.getTime()));
      const stop = new Date(Math.min(end.getTime(), rangeEnd.getTime()));
      while (cur <= stop) {
        const ym = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
        map.set(ym, (map.get(ym) ?? 0) + 1);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }, [myAbsences.data, fromDate, toDate]);
  const totalLibre = useMemo(() => {
    let acc = 0;
    for (const n of libreDaysByMonth.values()) acc += n;
    return acc;
  }, [libreDaysByMonth]);

  // Same day-expansion as libreDaysByMonth, but bucketed by reason
  // (block_type) for the "Días libres por motivo" breakdown. Personal
  // only — we deliberately do NOT compare absences to the team
  // average: surfacing "you took more sick leave than average" is a
  // privacy / morale landmine.
  const libreDaysByReason = useMemo(() => {
    const map = new Map<string, number>();
    if (!myAbsences.data) return map;
    const rangeStart = new Date(`${fromDate}T00:00:00`);
    const rangeEnd = new Date(`${toDate}T00:00:00`);
    for (const b of myAbsences.data) {
      if (b.status !== "approved") continue;
      const [sy, sm, sd] = b.start_date.split("-").map(Number);
      const [ey, em, ed] = b.end_date.split("-").map(Number);
      const start = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, ed);
      const cur = new Date(Math.max(start.getTime(), rangeStart.getTime()));
      const stop = new Date(Math.min(end.getTime(), rangeEnd.getTime()));
      let days = 0;
      while (cur <= stop) {
        days += 1;
        cur.setDate(cur.getDate() + 1);
      }
      if (days > 0) {
        map.set(b.block_type, (map.get(b.block_type) ?? 0) + days);
      }
    }
    return map;
  }, [myAbsences.data, fromDate, toDate]);

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
  type ActividadRow = {
    key: string;
    label: string;
    count: number;
    avg: number;
    color: string;
  };
  const perActividad = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of q.data?.rows ?? []) {
      const k = `${r.slot_id}|${r.team_role_id ?? ""}`;
      totals.set(k, (totals.get(k) ?? 0) + r.count);
    }
    // Team mean per activity, keyed the same way so each bar lines
    // up with its media counterpart.
    const avgByKey = new Map<string, number>();
    for (const a of q.data?.team_comparison?.by_activity ?? []) {
      avgByKey.set(`${a.slot_id}|${a.team_role_id ?? ""}`, a.avg_count);
    }
    const rows: ActividadRow[] = [];
    for (const s of slotMeta) {
      const n = totals.get(s.key) ?? 0;
      if (n === 0) continue;
      rows.push({
        key: s.key,
        label: s.label,
        count: n,
        avg: avgByKey.get(s.key) ?? 0,
        color: s.color,
      });
    }
    rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"));
    return rows;
  }, [q.data, slotMeta]);

  // The backend only returns team_comparison when there are >= 2
  // people to compare against (same-category peers, or the whole team
  // as a fallback for a sole-category caller). So its mere presence
  // means we have a meaningful comparison to render.
  const hasComparison = !!q.data?.team_comparison;

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
      // Libre stacks on top of the working-shift bars so the
      // total bar height = "days touched by Trivu" (worked or
      // off). Different unit (days vs shifts) so we surface
      // that ambiguity in the chart subtitle below.
      row[LIBRE_LABEL] = libreDaysByMonth.get(m) ?? 0;
      return row;
    });
  }, [q.data, slotMeta, months, libreDaysByMonth]);

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
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            // Build the preset list inline so all the "set both
            // bounds at once" callbacks stay close to their
            // labels. Each preset computes [fromMonthIdx, fromYear,
            // toMonthIdx, toYear] from `today`, then a single
            // `apply()` helper writes both pickers.
            const apply = (
              fromM: number,
              fromY: number,
              toM: number,
              toY: number,
            ) => {
              setFromPeriod(isoFromMonthYear(fromM, fromY));
              setToPeriod(isoFromMonthYear(toM, toY));
            };
            const thisM = today.getMonth();
            const thisY = today.getFullYear();
            // Calendar-quarter start month: 0 (Jan-Mar), 3 (Apr-Jun),
            // 6 (Jul-Sep), 9 (Oct-Dec). End of "this quarter" is
            // the current month — same QTD convention as "Este año".
            const qStart = Math.floor(thisM / 3) * 3;
            // Rolling 3 months: current month minus 2 → current.
            const last3Start = new Date(thisY, thisM, 1);
            last3Start.setMonth(last3Start.getMonth() - 2);
            // Rolling 12 months: current minus 11 → current.
            const last12Start = new Date(thisY, thisM, 1);
            last12Start.setMonth(last12Start.getMonth() - 11);
            return (
              <>
                <PresetButton
                  label="Este mes"
                  onClick={() => apply(thisM, thisY, thisM, thisY)}
                />
                <PresetButton
                  label="Últimos 3 meses"
                  onClick={() =>
                    apply(
                      last3Start.getMonth(),
                      last3Start.getFullYear(),
                      thisM,
                      thisY,
                    )
                  }
                />
                <PresetButton
                  label="Este trimestre"
                  onClick={() => apply(qStart, thisY, thisM, thisY)}
                />
                <PresetButton
                  label="Este año"
                  onClick={() => apply(0, thisY, thisM, thisY)}
                />
                <PresetButton
                  label="Últimos 12 meses"
                  onClick={() =>
                    apply(
                      last12Start.getMonth(),
                      last12Start.getFullYear(),
                      thisM,
                      thisY,
                    )
                  }
                />
                <PresetButton
                  label="Año pasado"
                  onClick={() => apply(0, thisY - 1, 11, thisY - 1)}
                />
              </>
            );
          })()}
        </div>
      </div>

      <p className="mb-6 -mt-2 text-xs text-gray-500">
        Cuenta turnos de planificaciones publicadas y archivadas.
        Los borradores no se incluyen.
      </p>

      {q.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}

      {q.data && totalTurnos === 0 && totalLibre === 0 && (
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Sin actividad en este rango"
          description="No has cubierto turnos publicados ni tienes ausencias aprobadas en las fechas seleccionadas. Cambia el rango o vuelve cuando se publique una planificación."
        />
      )}

      {q.data && (totalTurnos > 0 || totalLibre > 0) && (
        <div className="space-y-6">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            <KpiCard
              label="Días libres"
              value={totalLibre}
              accent={LIBRE_COLOR}
              sublabel="Vacaciones, bajas, formación y personales aprobadas"
            />
          </div>

          {/* Comparison vs the team average. Aggregate-only data
              (mean per member) so no colleague's individual numbers
              are exposed. Hidden until the API returns the block and
              the team has at least one member. */}
          {q.data.team_comparison && hasComparison && (
            <TeamComparisonCard
              comparison={q.data.team_comparison}
              myTotal={totalTurnos}
              myWeekend={totalWeekendOrHoliday}
              accent={accentHex}
            />
          )}

          {/* Días libres por motivo — personal breakdown (no team
              comparison; see libreDaysByReason note). */}
          {totalLibre > 0 && (
            <DaysOffByReasonCard byReason={libreDaysByReason} total={totalLibre} />
          )}

          {/* Per-actividad horizontal bars */}
          <Card>
            <div className="p-5">
              <h3 className="mb-1 text-sm font-semibold text-gray-800">
                Por actividad
              </h3>
              <p className="mb-3 text-xs text-gray-500">
                {hasComparison
                  ? `Tus turnos (en color) frente a la media ${
                      q.data.team_comparison?.comparison_scope === "team"
                        ? "del equipo"
                        : "de tu categoría"
                    } (en gris), por tipo de actividad.`
                  : "Total de turnos por tipo de actividad en el rango."}
              </p>
              <ResponsiveContainer
                width="100%"
                height={Math.max(
                  hasComparison ? 180 : 160,
                  perActividad.length * (hasComparison ? 52 : 36)
                    + (hasComparison ? 70 : 60),
                )}
              >
                <BarChart
                  data={perActividad}
                  layout="vertical"
                  margin={{ top: 8, right: 40, left: 16, bottom: 4 }}
                  barCategoryGap="22%"
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
                  {/* "Tú" — per-activity colour, bold label. */}
                  <Bar dataKey="count" name="Tú" radius={[0, 4, 4, 0]}>
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
                  {/* Media bar — neutral grey, lighter label. Only
                      rendered when the backend supplied a comparison
                      (>= 2 people). */}
                  {hasComparison && (
                    <Bar
                      dataKey="avg"
                      name={
                        q.data.team_comparison?.comparison_scope === "team"
                          ? "Media del equipo"
                          : "Media de tu categoría"
                      }
                      fill="#cbd5e1"
                      radius={[0, 4, 4, 0]}
                    >
                      <LabelList
                        dataKey="avg"
                        position="right"
                        fill="#6b7280"
                        style={{ fontSize: 11 }}
                      />
                    </Bar>
                  )}
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
                Turnos por mes, apilados por actividad. La barra
                Libre cuenta días naturales (no turnos) de
                ausencias aprobadas.
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
                  {/* Libre stacked last so it caps the bar — reads
                      as "and on top of all that, X days off". */}
                  <Bar
                    dataKey={LIBRE_LABEL}
                    stackId="mes"
                    fill={LIBRE_COLOR}
                    radius={[2, 2, 0, 0]}
                  />
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
                <li className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: LIBRE_COLOR }}
                  />
                  {LIBRE_LABEL}
                </li>
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

/** "Tú vs media del equipo" card. Two metrics (total shifts +
 *  weekend/holiday shifts), each a pair of bars (you / team mean) on
 *  a shared scale plus a neutral delta chip. The average is an
 *  aggregate only — never exposes a colleague's individual number. */
function TeamComparisonCard({
  comparison,
  myTotal,
  myWeekend,
  accent,
}: {
  comparison: TeamComparison;
  myTotal: number;
  myWeekend: number;
  accent: string;
}) {
  return (
    <Card>
      <div className="p-5">
        <h3 className="mb-1 text-sm font-semibold text-gray-800">
          {comparison.comparison_scope === "team"
            ? "Comparativa con el equipo"
            : "Comparativa con tu categoría"}
        </h3>
        <p className="mb-4 text-xs text-gray-500">
          {comparison.comparison_scope === "team" ? (
            <>
              Tu actividad frente a la media de las{" "}
              {comparison.team_member_count} personas del equipo
              {comparison.category_name
                ? " (eres la única persona de tu categoría)"
                : ""}
              , en el mismo rango.
            </>
          ) : (
            <>
              Tu actividad frente a la media de las{" "}
              {comparison.team_member_count} personas de tu categoría
              {comparison.category_name ? ` (${comparison.category_name})` : ""}
              , en el mismo rango.
            </>
          )}
        </p>
        <div className="space-y-5">
          <ComparisonMetric
            label="Turnos cubiertos"
            mine={myTotal}
            avg={comparison.avg_total_shifts}
            accent={accent}
          />
          <ComparisonMetric
            label="Fines de semana o festivos"
            mine={myWeekend}
            avg={comparison.avg_weekend_or_holiday_shifts}
            accent="#f59e0b"
          />
          <ComparisonMetric
            label="Cambios solicitados"
            mine={comparison.my_swaps_requested}
            avg={comparison.avg_swaps_requested}
            accent="#0ea5e9"
          />
          <ComparisonMetric
            label="Coberturas a compañeros"
            mine={comparison.my_swaps_covered}
            avg={comparison.avg_swaps_covered}
            accent="#8b5cf6"
          />
        </div>
      </div>
    </Card>
  );
}

function ComparisonMetric({
  label,
  mine,
  avg,
  accent,
}: {
  label: string;
  mine: number;
  avg: number;
  accent: string;
}) {
  // Shared scale so the two bars are visually comparable. Guard the
  // zero-data case so we never divide by zero.
  const max = Math.max(mine, avg, 1);
  const delta = Math.round((mine - avg) * 10) / 10;
  // Neutral framing: more shifts isn't inherently "good" or "bad",
  // so the chip stays gray rather than green/red. It just states the
  // gap so the member can read it however they like.
  const deltaLabel =
    delta === 0
      ? "en la media"
      : delta > 0
        ? `+${delta} vs media`
        : `${delta} vs media`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-gray-700">{label}</span>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
          {deltaLabel}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        <ComparisonBar
          caption="Tú"
          value={mine}
          display={String(mine)}
          max={max}
          color={accent}
          emphasis
        />
        <ComparisonBar
          caption="Media"
          value={avg}
          display={avg.toFixed(1)}
          max={max}
          color="#cbd5e1"
        />
      </div>
    </div>
  );
}

function ComparisonBar({
  caption,
  value,
  display,
  max,
  color,
  emphasis = false,
}: {
  caption: string;
  value: number;
  display: string;
  max: number;
  color: string;
  emphasis?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-gray-500">{caption}</span>
      <div className="relative h-5 flex-1 overflow-hidden rounded bg-gray-100">
        <div
          className="h-full rounded"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span
        className={
          "w-10 shrink-0 text-right text-xs tabular-nums "
          + (emphasis ? "font-semibold text-gray-900" : "text-gray-600")
        }
      >
        {display}
      </span>
    </div>
  );
}

// Reason → label + color for the days-off breakdown. Order is the
// render order (filtered to reasons with >0 days). Matches the
// block_type values + the palette used elsewhere for bloqueos.
const ABSENCE_REASON: { key: string; label: string; color: string }[] = [
  { key: "vacation", label: "Vacaciones", color: "#0d9488" },
  { key: "sick", label: "Baja médica", color: "#f43f5e" },
  { key: "training", label: "Formación", color: "#3b82f6" },
  { key: "personal", label: "Personal", color: "#8b5cf6" },
  { key: "other", label: "Otro", color: "#64748b" },
];

/** "Días libres por motivo" — the caller's own approved absence days
 *  in the range, split by reason. Personal only; no team comparison
 *  (absences are sensitive — see libreDaysByReason). */
function DaysOffByReasonCard({
  byReason,
  total,
}: {
  byReason: Map<string, number>;
  total: number;
}) {
  const rows = ABSENCE_REASON.map((r) => ({
    ...r,
    days: byReason.get(r.key) ?? 0,
  })).filter((r) => r.days > 0);
  // Any block_types not in our known list (future-proofing) — bucket
  // them under "Otro" rather than dropping silently.
  let known = 0;
  for (const r of rows) known += r.days;
  const leftover = total - known;
  if (leftover > 0) {
    const other = rows.find((r) => r.key === "other");
    if (other) other.days += leftover;
    else rows.push({ key: "other", label: "Otro", color: "#64748b", days: leftover });
  }
  rows.sort((a, b) => b.days - a.days);
  const max = Math.max(1, ...rows.map((r) => r.days));
  return (
    <Card>
      <div className="p-5">
        <h3 className="mb-1 text-sm font-semibold text-gray-800">
          Días libres por motivo
        </h3>
        <p className="mb-4 text-xs text-gray-500">
          Días de ausencia aprobada en el rango, repartidos por motivo.
          Solo tú ves este desglose.
        </p>
        <div className="space-y-2.5">
          {rows.map((r) => {
            const pct = (r.days / max) * 100;
            return (
              <div key={r.key} className="flex items-center gap-3">
                <span className="w-28 shrink-0 text-sm text-gray-700">
                  {r.label}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded bg-gray-100">
                  <div
                    className="h-full rounded"
                    style={{ width: `${pct}%`, backgroundColor: r.color }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-gray-900">
                  {r.days} {r.days === 1 ? "día" : "días"}
                </span>
              </div>
            );
          })}
        </div>
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
  // Padding + text size mirror MonthPicker's <select> (px-3 py-2
  // text-sm) so the preset chips sit flush with the dropdowns
  // rather than reading as a smaller secondary control.
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
    >
      {label}
    </button>
  );
}


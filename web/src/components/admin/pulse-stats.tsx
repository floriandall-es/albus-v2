"use client";

/**
 * Shared <PulseStats /> — the pulso survey results dashboard.
 *
 * Lifted out of /admin/pulso so it can render on /admin/stats?tab=pulso
 * (the new home for results) without /admin/pulso also having to
 * duplicate it. /admin/pulso keeps the settings + question
 * catalogue; the results live with the other stats now.
 *
 * Two cards:
 *   - Response rate (single line, % of eligible team who answered
 *     each week). Watch this before reading any other chart — if
 *     it's low the other lines are noise.
 *   - Per-question time-series (one small line chart per ENABLED
 *     question — the recommended core plus any optional question the
 *     admin turned on in /admin/pulso). A question that has data but
 *     was since disabled still charts so its history isn't lost.
 *
 * The "enabled" gate copy points the admin back to /admin/pulso
 * when the feature is off — this component doesn't know how to
 * turn it on, that's the SettingsSection's job.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/admin/ui";
import { api, type PulseQuestionStat } from "@/lib/api";

// Fallback order used only until the catalogue query resolves. The
// real chart set is driven by which questions the tenant has ENABLED
// (core + any optional the admin turned on) — see PulseStats.
const CORE_KEYS = [
  "fairness",
  "workload",
  "recovery",
  "predictability",
] as const;

// Curated short titles + direction hints for the known catalogue keys.
// Any question not listed here falls back to its catalogue prompt + a
// hint derived from its scale labels (hintFromLabels), so new optional
// questions still render sensibly without a code change.
const QUESTION_TITLES: Record<string, string> = {
  fairness: "Reparto justo",
  workload: "Carga de trabajo",
  recovery: "Descanso",
  // question_key stays "predictability" (stable backend contract)
  // but the display matches what the score actually measures:
  // higher = more last-minute changes = LESS predictable.
  predictability: "Cambios de última hora",
  team_support: "Apoyo del equipo",
  leadership_support: "Apoyo de responsables",
  wellbeing: "Bienestar general",
  recommend: "Recomendaría el equipo",
};

const QUESTION_HINTS: Record<string, string> = {
  fairness: "Más alto = más justo percibido",
  workload: "Más alto = más pesado",
  recovery: "Más alto = más descansado",
  predictability: "Más alto = más cambios imprevistos",
  team_support: "Más alto = más apoyo",
  leadership_support: "Más alto = más apoyo",
  wellbeing: "Más alto = mejor",
  recommend: "Más alto = más probable",
};

/** Generic direction hint for a question we don't have a curated
 * line for — uses the top scale label (scales are monotonic worst→
 * best by contract). e.g. labels ["Ninguno",…,"Total"] → "Más alto =
 * Total". */
function hintFromLabels(labels: string[]): string {
  const top = labels[labels.length - 1];
  return top ? `Más alto = ${top}` : "";
}

export function PulseStats() {
  const stats = useQuery({
    queryKey: ["admin-pulse-stats"],
    queryFn: () => api.getAdminPulseStats(),
  });
  const settings = useQuery({
    queryKey: ["admin-pulse-settings"],
    queryFn: api.getAdminPulseSettings,
  });
  const catalogue = useQuery({
    queryKey: ["admin-pulse-catalogue"],
    queryFn: api.getAdminPulseCatalogue,
  });
  const enabled = settings.data?.enabled ?? false;
  if (!enabled) {
    return (
      <Card>
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-900">
            Pulso del equipo desactivado
          </h3>
          <p className="mt-2 text-sm text-gray-600 leading-relaxed">
            Activa la encuesta semanal desde{" "}
            <Link
              href="/admin/pulso"
              className="font-medium text-brand-700 hover:underline"
            >
              Pulso del equipo
            </Link>{" "}
            para empezar a recoger datos. Aquí verás la evolución semanal
            por pregunta y el ratio de respuesta una vez activada.
          </p>
        </div>
      </Card>
    );
  }
  if (stats.isLoading) {
    return <p className="text-sm text-gray-500">Cargando estadísticas…</p>;
  }
  const data = stats.data;
  if (!data || data.weekly.length === 0) {
    return (
      <Card>
        <div className="p-4">
          <p className="text-sm text-gray-700">
            Sin datos todavía. La primera tanda de respuestas llegará el
            viernes que viene, o antes si activaste el pulso esta semana
            y alguien ha contestado ya.
          </p>
        </div>
      </Card>
    );
  }
  // Which questions to chart: every ENABLED question from the
  // catalogue (core + admin-enabled optional), in catalogue order —
  // plus any question that already has data in the window even if it's
  // since been disabled, so turning one off doesn't erase its history.
  // Falls back to the core keys until the catalogue query resolves.
  const ordered = catalogue.data
    ? [...catalogue.data.core, ...catalogue.data.rotating]
    : null;
  const weeklyKeys = new Set(data.weekly.map((w) => w.question_key));
  const chartKeys: { key: string; title: string; hint: string }[] = ordered
    ? ordered
        .filter((q) => q.enabled || weeklyKeys.has(q.key))
        .map((q) => ({
          key: q.key,
          title: QUESTION_TITLES[q.key] ?? q.prompt,
          hint: QUESTION_HINTS[q.key] ?? hintFromLabels(q.labels),
        }))
    : CORE_KEYS.map((k) => ({
        key: k,
        title: QUESTION_TITLES[k] ?? k,
        hint: QUESTION_HINTS[k] ?? "",
      }));

  return (
    <div className="space-y-6">
      <ResponseRateCard
        weekly={data.weekly}
        eligibleCount={data.eligible_count}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {chartKeys.map((q) => (
          <QuestionTimeseriesCard
            key={q.key}
            questionKey={q.key}
            title={q.title}
            hint={q.hint}
            weekly={data.weekly}
          />
        ))}
      </div>
    </div>
  );
}

function ResponseRateCard({
  weekly,
  eligibleCount,
}: {
  weekly: PulseQuestionStat[];
  eligibleCount: number;
}) {
  // Response rate per week = max(response_count for that week's
  // questions) / eligible_count. We use max because a respondent
  // who answers any one of the 5 counts as "responded" for that
  // week. Mean response_count would deflate the metric every time
  // someone skipped a question.
  const series = useMemo(() => {
    const byWeek = new Map<string, number>();
    for (const w of weekly) {
      const cur = byWeek.get(w.week_iso) ?? 0;
      if (w.response_count > cur) byWeek.set(w.week_iso, w.response_count);
    }
    return Array.from(byWeek.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, count]) => ({
        week,
        label: prettyWeekShort(week),
        rate:
          eligibleCount > 0
            ? Math.round((count / eligibleCount) * 100)
            : 0,
      }));
  }, [weekly, eligibleCount]);
  const latest = series[series.length - 1];
  return (
    <Card>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-medium text-gray-900">
                Ratio de respuesta
              </h3>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Qué porcentaje del equipo contesta cada semana. Si baja,
              todos los demás indicadores pierden fiabilidad.
            </p>
          </div>
          {latest && (
            <div className="text-right">
              <div className="text-2xl font-semibold text-gray-900">
                {latest.rate}%
              </div>
              <div className="text-[11px] text-gray-500">
                {prettyWeekShort(latest.week)}
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 h-40 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="label"
                stroke="#6b7280"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={11}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                formatter={(v) => [`${Number(v)}%`, "Ratio"]}
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid #e5e7eb",
                }}
              />
              <Line
                type="monotone"
                dataKey="rate"
                stroke="rgb(13 148 136)"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}

function QuestionTimeseriesCard({
  questionKey,
  title,
  hint,
  weekly,
}: {
  questionKey: string;
  title: string;
  hint: string;
  weekly: PulseQuestionStat[];
}) {
  const series = useMemo(() => {
    return weekly
      .filter((w) => w.question_key === questionKey)
      .sort((a, b) => a.week_iso.localeCompare(b.week_iso))
      .map((w) => ({
        week: w.week_iso,
        label: prettyWeekShort(w.week_iso),
        mean: w.mean,
        count: w.response_count,
      }));
  }, [weekly, questionKey]);
  const latest = series[series.length - 1];
  return (
    <Card>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-gray-900">{title}</h3>
            {hint && (
              <p className="mt-0.5 text-[11px] text-gray-500">{hint}</p>
            )}
          </div>
          {latest && (
            <div className="text-right">
              <div className="text-2xl font-semibold text-gray-900">
                {latest.mean}
              </div>
              <div className="text-[11px] text-gray-500">
                n = {latest.count}
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 h-40 w-full">
          {series.length === 0 ? (
            <p className="flex h-full items-center justify-center text-xs text-gray-500">
              Sin datos todavía.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="label"
                  stroke="#6b7280"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#6b7280"
                  fontSize={11}
                  // All scales are 4-point (even-numbered so there's
                  // no neutral middle to coast on). If we ship a
                  // question with a different scale, make per-card.
                  domain={[1, 4]}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(v) => [Number(v).toFixed(2), "Media"]}
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 6,
                    border: "1px solid #e5e7eb",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="mean"
                  stroke={lineColorFor(questionKey)}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </Card>
  );
}

function lineColorFor(key: string): string {
  // Distinct hues per core question so the eye locks in across the
  // 4-card grid. Picked from the existing Tailwind palette
  // (sky / amber / emerald / rose) so the cards feel platform-y.
  switch (key) {
    case "fairness":
      return "rgb(2 132 199)"; // sky-600
    case "workload":
      return "rgb(217 119 6)"; // amber-600
    case "recovery":
      return "rgb(5 150 105)"; // emerald-600
    case "predictability":
      return "rgb(225 29 72)"; // rose-600
    default:
      return "rgb(75 85 99)"; // gray-600
  }
}

/** Compact ISO week label for chart x-axes. */
function prettyWeekShort(weekIso: string): string {
  const [, w] = weekIso.split("-W");
  return `S${w}`;
}

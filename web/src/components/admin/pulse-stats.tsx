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
 *   - Per-question time-series (4 small line charts, one per core
 *     question). Rotating questions are excluded because each
 *     week's slot is a different metric.
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

// Kept in sync with services/pulse.py::CORE_QUESTIONS — rotating
// questions are intentionally excluded from the chart grid.
const CORE_KEYS = [
  "fairness",
  "workload",
  "recovery",
  "predictability",
] as const;

const QUESTION_TITLES: Record<string, string> = {
  fairness: "Reparto justo",
  workload: "Carga de trabajo",
  recovery: "Descanso",
  // question_key stays "predictability" (stable backend contract)
  // but the display matches what the score actually measures:
  // higher = more last-minute changes = LESS predictable.
  predictability: "Cambios de última hora",
};

const QUESTION_HINTS: Record<string, string> = {
  fairness: "Más alto = más justo percibido",
  workload: "Más alto = más pesado",
  recovery: "Más alto = más descansado",
  predictability: "Más alto = más cambios imprevistos",
};

export function PulseStats() {
  const stats = useQuery({
    queryKey: ["admin-pulse-stats"],
    queryFn: () => api.getAdminPulseStats(),
  });
  const settings = useQuery({
    queryKey: ["admin-pulse-settings"],
    queryFn: api.getAdminPulseSettings,
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
  return (
    <div className="space-y-6">
      <ResponseRateCard
        weekly={data.weekly}
        eligibleCount={data.eligible_count}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {CORE_KEYS.map((key) => (
          <QuestionTimeseriesCard
            key={key}
            questionKey={key}
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
  weekly,
}: {
  questionKey: string;
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
  const title = QUESTION_TITLES[questionKey] ?? questionKey;
  const hint = QUESTION_HINTS[questionKey] ?? "";
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

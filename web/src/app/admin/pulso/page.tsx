"use client";

/**
 * /admin/pulso — admin-facing pulse survey dashboard (migration 0090).
 *
 * Three sections, top to bottom:
 *
 *   1. Settings card — on/off toggle, last-notified-week, plain-
 *      language explanation of what enabling does. This is the
 *      one place admins flip the feature on for their team.
 *
 *   2. Response rate — single line chart of how many people
 *      answered each week / total eligible. The team's
 *      engagement-with-the-feature signal; admins should watch
 *      this before reading any other chart.
 *
 *   3. Per-question time-series — 4 small line charts (one per
 *      core question) showing weekly mean over the trailing
 *      6 months. The rotating 5th-question key isn't included
 *      because each week's rotating slot is a different metric
 *      — comparing them on one line would be lying.
 *
 * Correlation cards (fairness vs. shift variance, recovery vs.
 * guardias, etc.) live behind this scaffolding; they need
 * cross-querying with the existing schedule data and land in a
 * follow-up commit. For v1 the dashboard renders the raw pulse
 * signals well, which is enough to start producing insight.
 */

import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Activity, Users } from "lucide-react";
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

/** Core question keys, fixed in the order we want them on the
 * dashboard. Kept in sync with services/pulse.py::CORE_QUESTIONS —
 * if the backend catalogue changes, the unknown key just renders
 * as "Otro". Rotating questions are not charted here (see
 * page-level docstring). */
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
  predictability: "Predictibilidad",
};

const QUESTION_HINTS: Record<string, string> = {
  fairness: "Más alto = más justo percibido",
  workload: "Más alto = más pesado",
  recovery: "Más alto = más descansado",
  predictability: "Más alto = más cambios de última hora",
};

export default function AdminPulsoPage() {
  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Activity className="h-6 w-6 text-brand-600" />
        <h1 className="text-2xl font-semibold">Pulso del equipo</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-gray-600">
        Encuesta semanal opcional para entender cómo se siente el
        equipo: reparto, carga, descanso, predictibilidad. Las
        respuestas son anónimas — solo ves la media y la
        distribución, nunca quién contestó qué.
      </p>
      <SettingsSection />
      <StatsSection />
    </div>
  );
}

function SettingsSection() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["admin-pulse-settings"],
    queryFn: api.getAdminPulseSettings,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patchAdminPulseSettings({ enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-pulse-settings"] });
      qc.invalidateQueries({ queryKey: ["admin-pulse-stats"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(msg);
    },
  });
  const enabled = settings.data?.enabled ?? false;
  return (
    <div className="mb-8 max-w-2xl">
      <Card>
        <div className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-gray-900">
                Encuesta semanal
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                Cuando está activa, cada viernes a las 14:00 el
                equipo recibe una notificación (push si tienen la
                app instalada, email si no) con 5 preguntas. La
                semana cierra el domingo a medianoche; las
                respuestas pasadas son inmutables.
              </p>
              {settings.data?.last_notified_week_iso && (
                <p className="mt-2 text-[11px] text-gray-500">
                  Última notificación enviada:{" "}
                  {prettyWeek(settings.data.last_notified_week_iso)}
                </p>
              )}
            </div>
            <ToggleSwitch
              checked={enabled}
              onChange={(v) => toggle.mutate(v)}
              disabled={settings.isLoading || toggle.isPending}
              ariaLabel="Activar pulso del equipo"
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 "
        + (checked ? "bg-brand-600" : "bg-gray-300")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform "
          + (checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}

function StatsSection() {
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
      <div className="max-w-2xl">
        <p className="text-sm text-gray-500">
          Activa la encuesta arriba para empezar a recoger datos.
          Verás aquí la evolución semanal por pregunta y el ratio
          de respuesta.
        </p>
      </div>
    );
  }
  if (stats.isLoading) {
    return (
      <p className="text-sm text-gray-500">Cargando estadísticas…</p>
    );
  }
  const data = stats.data;
  if (!data || data.weekly.length === 0) {
    return (
      <div className="max-w-2xl">
        <Card>
          <div className="p-4">
            <p className="text-sm text-gray-700">
              Sin datos todavía. La primera tanda de respuestas
              llegará el viernes que viene, o antes si activaste el
              pulso esta semana y alguien ha contestado ya.
            </p>
          </div>
        </Card>
      </div>
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
              Qué porcentaje del equipo contesta cada semana.
              Si baja, todos los demás indicadores pierden
              fiabilidad.
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
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#e5e7eb"
              />
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
            <h3 className="text-sm font-medium text-gray-900">
              {title}
            </h3>
            {hint && (
              <p className="mt-0.5 text-[11px] text-gray-500">
                {hint}
              </p>
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
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#e5e7eb"
                />
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
                  domain={[1, 5]}
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
  // Distinct hues per core question so the eye locks in across
  // the 4-card grid. Picked from the existing Tailwind palette
  // we use elsewhere (sky / amber / emerald / rose) so the cards
  // feel like part of the platform, not a new chart kit.
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

/** "2026-W22" → "Semana 22 · 2026". */
function prettyWeek(weekIso: string): string {
  const [year, w] = weekIso.split("-W");
  return `Semana ${w} · ${year}`;
}

/** Compact ISO week label for chart x-axes. Drops the year unless
 * we're looking back across a year boundary — keeps the axis from
 * getting crowded on long ranges. */
function prettyWeekShort(weekIso: string): string {
  const [, w] = weekIso.split("-W");
  return `S${w}`;
}

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

import { useState } from "react";
import Link from "next/link";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Pencil,
  RotateCcw,
  Star,
  X,
} from "lucide-react";

import { Card } from "@/components/admin/ui";
import {
  api,
  type PulseCatalogueQuestion,
} from "@/lib/api";

export default function AdminPulsoPage() {
  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Activity className="h-6 w-6 text-brand-600" />
        <h1 className="text-2xl font-semibold">Pulso del equipo</h1>
      </div>
      <p className="mb-4 max-w-2xl text-sm text-gray-600">
        Encuesta semanal opcional para entender cómo se siente el
        equipo: reparto, carga, descanso, predictibilidad. Las
        respuestas son anónimas — solo ves la media y la
        distribución, nunca quién contestó qué.
      </p>
      <div className="mb-6 max-w-2xl">
        <Link
          href="/admin/stats?tab=pulso"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
        >
          Ver resultados en Estadísticas
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <SettingsSection />
      <CatalogueSection />
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
                app instalada, email si no) con las preguntas que
                tengas activas abajo. La encuesta queda abierta
                hasta el siguiente viernes — las respuestas se
                congelan cuando arranca la nueva.
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
  size = "md",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** "md" (default) — full-size for the settings card. "sm" —
   * inline-friendly for per-question rows. */
  size?: "md" | "sm";
}) {
  const isSm = size === "sm";
  const track = isSm ? "h-5 w-9" : "h-6 w-11";
  const thumb = isSm ? "h-4 w-4" : "h-5 w-5";
  const offTranslate = isSm ? "translate-x-0.5" : "translate-x-0.5";
  const onTranslate = isSm ? "translate-x-4" : "translate-x-5";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:opacity-50 "
        + track
        + " "
        + (checked ? "bg-brand-600" : "bg-gray-300")
      }
    >
      <span
        className={
          "inline-block transform rounded-full bg-white shadow-sm transition-transform "
          + thumb
          + " "
          + (checked ? onTranslate : offTranslate)
        }
      />
    </button>
  );
}

function CatalogueSection() {
  // Default collapsed: most pageloads are "I want to glance at the
  // stats", not "I want to edit questions". The catalogue is long
  // and previously forced the admin to scroll past it every time
  // to reach the charts.
  const [expanded, setExpanded] = useState(false);
  const catalogue = useQuery({
    queryKey: ["admin-pulse-catalogue"],
    queryFn: api.getAdminPulseCatalogue,
  });
  if (catalogue.isLoading) {
    return (
      <div className="mb-8 max-w-2xl">
        <p className="text-sm text-gray-500">Cargando preguntas…</p>
      </div>
    );
  }
  if (!catalogue.data) return null;
  const { core, rotating, current_week_iso } = catalogue.data;
  const all = [...core, ...rotating];
  const activeCount = all.filter((q) => q.enabled).length;
  const totalCount = all.length;
  const customCount = all.filter((q) => q.is_customized).length;

  return (
    <div className="mb-8 max-w-2xl">
      <Card>
        {/* Header is a button so the whole row is clickable (cursor
            target is the entire bar, not just the chevron). */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start gap-2 p-4 text-left hover:bg-gray-50"
        >
          <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-gray-500" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-gray-900">
              Preguntas
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">
              {activeCount} activas de {totalCount}
              {customCount > 0 && ` · ${customCount} personalizadas`}
            </p>
          </div>
          {expanded ? (
            <ChevronUp className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
          ) : (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
          )}
        </button>
        {expanded && (
          <div className="border-t border-gray-100 p-4">
            <p className="text-xs text-gray-500">
              Estas son todas las preguntas disponibles. Cada
              semana se piden todas las que tengas activas.
              Recomendamos empezar con las 4 que vienen
              preactivadas y añadir más cuando tengas curiosidad
              por nuevos ángulos.
            </p>
            <div className="mt-5">
              <SectionLabel
                icon={<Star className="h-3.5 w-3.5" />}
                text="Recomendadas · activas por defecto"
              />
              <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200">
                {core.map((q) => (
                  <QuestionRow key={q.key} q={q} />
                ))}
              </ul>
            </div>
            <div className="mt-5">
              <SectionLabel
                icon={<Activity className="h-3.5 w-3.5" />}
                text="Opcionales · desactivadas por defecto"
              />
              <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200">
                {rotating.map((q) => (
                  <QuestionRow key={q.key} q={q} />
                ))}
              </ul>
            </div>
            <p className="mt-4 text-[11px] text-gray-500">
              Reescribe cualquier pregunta para que suene a tu
              equipo, o cambia su interruptor para activarla o
              desactivarla. La escala se queda fija para que las
              gráficas históricas sigan comparándose como deben.
              (Semana actual: {prettyWeek(current_week_iso)}.)
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function SectionLabel({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
      {icon}
      {text}
    </div>
  );
}

function QuestionRow({
  q,
}: {
  q: PulseCatalogueQuestion;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(q.prompt);
  const patch = useMutation({
    mutationFn: (body: { prompt?: string | null; enabled?: boolean }) =>
      api.patchAdminPulseQuestion(q.key, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-pulse-catalogue"] });
      qc.invalidateQueries({ queryKey: ["pulse-current-week"] });
      setEditing(false);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(msg);
    },
  });
  function saveDraft() {
    const trimmed = draft.trim();
    // Empty → clear the rewording (server falls back to default).
    patch.mutate({
      prompt: trimmed.length === 0 ? null : trimmed,
    });
  }
  function resetPrompt() {
    setDraft(q.default_prompt);
    patch.mutate({ prompt: null });
  }
  return (
    <li
      className={
        "px-3 py-2 transition-colors "
        + (!q.enabled ? "opacity-60" : "")
      }
    >
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={300}
            autoFocus
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-gray-500">
              Por defecto:{" "}
              <span className="italic">{q.default_prompt}</span>
            </p>
            <div className="flex shrink-0 items-center gap-1">
              {q.prompt !== q.default_prompt && (
                <button
                  type="button"
                  onClick={resetPrompt}
                  disabled={patch.isPending}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />
                  Por defecto
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraft(q.prompt);
                  setEditing(false);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
              >
                <X className="h-3 w-3" />
                Cancelar
              </button>
              <button
                type="button"
                onClick={saveDraft}
                disabled={
                  patch.isPending || draft.trim() === q.prompt
                }
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                <Check className="h-3 w-3" />
                {patch.isPending ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-900">
              {q.prompt}
              {q.is_customized && (
                <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                  Personalizada
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {scaleDescription(q)}
              {!q.enabled && (
                <span className="ml-2 text-gray-400">
                  · Desactivada
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Editar pregunta"
              onClick={() => {
                setDraft(q.prompt);
                setEditing(true);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <ToggleSwitch
              checked={q.enabled}
              onChange={(v) => patch.mutate({ enabled: v })}
              disabled={patch.isPending}
              ariaLabel={
                q.enabled
                  ? "Desactivar pregunta"
                  : "Activar pregunta"
              }
              size="sm"
            />
          </div>
        </div>
      )}
    </li>
  );
}

/** Plain-text description of how the question is answered.
 * Always shows the per-point labels alongside the numbers so the
 * admin sees what their team is actually picking from. */
function scaleDescription(q: PulseCatalogueQuestion): string {
  const labels = q.labels ?? [];
  if (labels.length === 0) {
    // Defensive — old catalogue rows without labels render as
    // bare numbers. Should not happen in v1 since every question
    // ships with labels now.
    return `Escala 1–${q.scale_max}`;
  }
  // "1 Injusto · 2 Poco · 3 Regular · 4 Bien · 5 Muy bien"
  return labels.map((l, i) => `${i + 1} ${l}`).join(" · ");
}

/** "2026-W22" → "Semana 22 · 2026". */
function prettyWeek(weekIso: string): string {
  const [year, w] = weekIso.split("-W");
  return `Semana ${w} · ${year}`;
}


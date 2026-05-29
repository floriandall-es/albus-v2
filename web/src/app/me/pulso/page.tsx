"use client";

/**
 * /me/pulso — clinician-facing pulse survey (migration 0090).
 *
 * One page, four states:
 *
 *   1. Disabled: tenant hasn't opted in. Show a quiet "Tu equipo
 *      todavía no tiene esta función activada" message + link to
 *      ask the admin. No form.
 *
 *   2. Loading: spinner-ish placeholder.
 *
 *   3. Answer: header, 5 questions as either 1–5 numeric scales
 *      ("scale" type) or labelled choice buttons ("choice" type).
 *      Partial state persists — the server stores answers as you
 *      submit, and `my_answers` rehydrates the form on revisit.
 *      Submit button: enabled when at least one question is
 *      answered. Encourages "fill what you feel like" rather than
 *      gating on all-or-nothing.
 *
 *   4. Thank-you: confirmation card after submit. Optional
 *      self-history accordion at the bottom of the page is
 *      visible in both the answer and thank-you states.
 *
 * The page is also reached by tapping the Friday push or the
 * /me Inicio card — both deep-link straight here. Mobile-first
 * layout: questions stack vertically, buttons stretch full width
 * on narrow screens.
 */

import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Activity, Check, ChevronDown, ChevronUp } from "lucide-react";

import { Card } from "@/components/admin/ui";
import { api, type PulseQuestion } from "@/lib/api";

export default function PulsoPage() {
  const qc = useQueryClient();
  const cw = useQuery({
    queryKey: ["pulse-current-week"],
    queryFn: api.getPulseCurrentWeek,
  });

  // Local answer state, seeded from server's `my_answers` so a
  // user returning mid-flow sees their selections highlighted.
  const [answers, setAnswers] = useState<Record<string, number>>({});
  useEffect(() => {
    if (cw.data?.my_answers) {
      setAnswers(cw.data.my_answers);
    }
  }, [cw.data?.my_answers]);

  // "Just submitted in this session" → flips the page to the
  // thank-you state until reload. Survives because the server
  // confirmed the upsert; we don't need to re-fetch.
  const [justSubmitted, setJustSubmitted] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      api.postPulseResponses(
        Object.entries(answers).map(([k, s]) => ({
          question_key: k,
          score: s,
        })),
      ),
    onSuccess: () => {
      setJustSubmitted(true);
      qc.invalidateQueries({ queryKey: ["pulse-current-week"] });
      qc.invalidateQueries({ queryKey: ["pulse-history"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo guardar: ${msg}`);
    },
  });

  if (cw.isLoading) {
    return (
      <div>
        <Header />
        <p className="text-sm text-gray-500">Cargando…</p>
      </div>
    );
  }

  if (!cw.data?.enabled) {
    return (
      <div>
        <Header />
        <DisabledState />
        <HistoryAccordion />
      </div>
    );
  }

  const questions = cw.data.questions;
  const answeredCount = Object.keys(answers).length;
  const total = questions.length;

  if (justSubmitted) {
    return (
      <div>
        <Header />
        <ThankYouCard
          onAnswerMore={() => setJustSubmitted(false)}
          answeredCount={answeredCount}
          total={total}
        />
        <HistoryAccordion />
      </div>
    );
  }

  return (
    <div>
      <Header weekIso={cw.data.week_iso} />
      <p className="mb-4 text-sm text-gray-600">
        Tu respuesta es siempre agregada — el jefe ve la media del
        equipo, nunca quién contestó qué. Tarda unos 30 segundos.
      </p>
      <div className="max-w-xl space-y-4">
        {questions.map((q) => (
          <QuestionCard
            key={q.key}
            question={q}
            value={answers[q.key]}
            onChange={(score) =>
              setAnswers((prev) => ({ ...prev, [q.key]: score }))
            }
          />
        ))}
      </div>
      <div className="mt-6 flex max-w-xl items-center justify-between gap-3">
        <span className="text-xs text-gray-500">
          {answeredCount} de {total} respondidas
        </span>
        <button
          type="button"
          onClick={() => submit.mutate()}
          disabled={answeredCount === 0 || submit.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          {submit.isPending ? "Guardando…" : "Enviar"}
        </button>
      </div>
      <HistoryAccordion />
    </div>
  );
}

function Header({ weekIso }: { weekIso?: string }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <Activity className="h-6 w-6 text-brand-600" />
      <h1 className="text-2xl font-semibold">Pulso semanal</h1>
      {weekIso && (
        <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
          {prettyWeek(weekIso)}
        </span>
      )}
    </div>
  );
}

function DisabledState() {
  return (
    <div className="max-w-xl">
      <Card>
        <div className="p-4">
          <p className="text-sm text-gray-700">
            Tu equipo todavía no tiene esta función activada. El
            pulso semanal ayuda a entender cómo se siente el equipo
            (carga, descanso, reparto) y a tomar decisiones más
            informadas. Habla con tu jefe/a de servicio si crees
            que sería útil.
          </p>
        </div>
      </Card>
    </div>
  );
}

function ThankYouCard({
  onAnswerMore,
  answeredCount,
  total,
}: {
  onAnswerMore: () => void;
  answeredCount: number;
  total: number;
}) {
  const allDone = answeredCount === total;
  return (
    <div className="max-w-xl">
      <Card>
        <div className="p-4">
          <div className="flex items-start gap-3">
            <Check className="mt-0.5 h-5 w-5 text-green-600" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-gray-900">
                {allDone
                  ? "Gracias — todas guardadas."
                  : "Gracias — guardadas."}
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                {allDone
                  ? "Verás los resultados del equipo si tu admin los comparte."
                  : `Has contestado ${answeredCount} de ${total}. Si te apetece, puedes terminar el resto.`}
              </p>
              {!allDone && (
                <button
                  type="button"
                  onClick={onAnswerMore}
                  className="mt-3 text-xs font-medium text-brand-700 hover:underline"
                >
                  Contestar las restantes
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function QuestionCard({
  question,
  value,
  onChange,
}: {
  question: PulseQuestion;
  value: number | undefined;
  onChange: (score: number) => void;
}) {
  return (
    <Card>
      <div className="p-4">
        <p className="text-sm font-medium text-gray-900">
          {question.prompt}
        </p>
        <div className="mt-3">
          {question.scale_type === "scale" ? (
            <ScaleButtons
              max={question.scale_max}
              labels={question.labels}
              value={value}
              onChange={onChange}
            />
          ) : (
            <ChoiceButtons
              labels={question.labels}
              value={value}
              onChange={onChange}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function ScaleButtons({
  max,
  labels,
  value,
  onChange,
}: {
  max: number;
  /** Per-point semantic labels. Length should match `max`; if
   * empty (legacy/older catalogue), buttons render number-only. */
  labels: string[];
  value: number | undefined;
  onChange: (score: number) => void;
}) {
  // Same vertical layout as ChoiceButtons — one row per option,
  // number badge on the left, label on the right. Consistency
  // across both question types beats the horizontal "scale" cue:
  // a survey that mixes layouts feels uneven, and the labels are
  // already the disambiguator the number-only scale was missing.
  const scale = Array.from({ length: max }, (_, i) => i + 1);
  return (
    <div className="flex flex-col gap-1.5">
      {scale.map((n) => {
        const selected = value === n;
        const label = labels[n - 1] ?? "";
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={
              "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors "
              + (selected
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-gray-300 text-gray-700 hover:bg-gray-50")
            }
          >
            <span
              className={
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold "
                + (selected
                  ? "bg-brand-100 text-brand-700"
                  : "bg-gray-100 text-gray-600")
              }
            >
              {n}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChoiceButtons({
  labels,
  value,
  onChange,
}: {
  labels: string[];
  value: number | undefined;
  onChange: (score: number) => void;
}) {
  // 4-point labelled choices. Scores are 1-indexed to match the
  // server (so "Ligera" = 1, "Insostenible" = 4 for the workload
  // question — higher = worse, consistent with admin chart
  // direction). Number prefix on each row so the underlying
  // value is visible while the label disambiguates.
  return (
    <div className="flex flex-col gap-1.5">
      {labels.map((label, idx) => {
        const score = idx + 1;
        const selected = value === score;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange(score)}
            className={
              "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors "
              + (selected
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-gray-300 text-gray-700 hover:bg-gray-50")
            }
          >
            <span
              className={
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold "
                + (selected
                  ? "bg-brand-100 text-brand-700"
                  : "bg-gray-100 text-gray-600")
              }
            >
              {score}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function HistoryAccordion() {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ["pulse-history"],
    queryFn: () => api.getPulseHistory(12),
    enabled: open, // lazy: don't pay the round-trip until expanded
  });
  return (
    <div className="mt-8 max-w-xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
      >
        <span>Tu historial · últimas 12 semanas</span>
        {open ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-gray-200 bg-white">
          {history.isLoading && (
            <p className="px-3 py-2 text-xs text-gray-500">Cargando…</p>
          )}
          {history.data && history.data.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-500">
              Todavía no has contestado ningún pulso.
            </p>
          )}
          {history.data && history.data.length > 0 && (
            <HistoryTable rows={history.data} />
          )}
        </div>
      )}
    </div>
  );
}

function HistoryTable({
  rows,
}: {
  rows: { week_iso: string; question_key: string; score: number }[];
}) {
  // Tiny table: one row per week × question. For v1 we skip the
  // sparkline chart and just show the raw numbers grouped by
  // week — it's the user's own history, scope is small, table is
  // honest. Charts land in v2 alongside the admin dashboard.
  const byWeek = useMemo(() => {
    const m: Record<string, { week_iso: string; entries: typeof rows }> = {};
    for (const r of rows) {
      if (!m[r.week_iso]) {
        m[r.week_iso] = { week_iso: r.week_iso, entries: [] };
      }
      m[r.week_iso].entries.push(r);
    }
    return Object.values(m).sort((a, b) =>
      b.week_iso.localeCompare(a.week_iso),
    );
  }, [rows]);
  return (
    <ul className="divide-y divide-gray-100">
      {byWeek.map((w) => (
        <li key={w.week_iso} className="px-3 py-2">
          <div className="text-xs font-medium text-gray-700">
            {prettyWeek(w.week_iso)}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {w.entries.map((e) => (
              <span
                key={e.question_key}
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700"
              >
                <span className="text-gray-500">
                  {shortQuestionLabel(e.question_key)}
                </span>
                <span className="font-medium text-gray-900">
                  {e.score}
                </span>
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "2026-W22" → "Semana 22 · 2026". Compact enough for the pill
 * next to the page title and the history table. */
function prettyWeek(weekIso: string): string {
  const [year, w] = weekIso.split("-W");
  return `Semana ${w} · ${year}`;
}

/** Short label for the history pills. The question_keys are stable
 * by contract (see services/pulse.py) so this mapping is safe to
 * keep client-side without a round-trip. Falls back to the raw
 * key when an unknown rotating question shows up — defensive
 * against catalogue evolution. */
function shortQuestionLabel(key: string): string {
  switch (key) {
    case "fairness":
      return "Reparto";
    case "workload":
      return "Carga";
    case "recovery":
      return "Descanso";
    case "predictability":
      return "Cambios imprevistos";
    case "team_support":
      return "Apoyo del equipo";
    case "tool_friction":
      return "Trivu";
    case "wellbeing":
      return "Bienestar";
    case "recommend":
      return "Recomendar";
    default:
      return key;
  }
}

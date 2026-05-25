"use client";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  EyeOff,
  RotateCcw,
} from "lucide-react";
import { api, type Violation } from "@/lib/api";

/**
 * Top-of-page warning banner listing every rule breach Trivu has
 * detected in the schedule's current assignments. Warnings only —
 * the admin can save anything and we'll surface what they broke,
 * but nothing here blocks an edit.
 *
 * "Hide / overrule" affordance
 * ----------------------------
 * Each row carries an "Ocultar" button. Clicking it stamps a
 * suppression row on the backend (keyed by violation signature)
 * and the row falls out of the visible list. The banner header
 * shows a "Mostrar N ocultos" toggle so the admin can review what
 * they've hidden and un-hide individual entries (RotateCcw icon).
 *
 * The whole-banner severity tone + the per-cell ring on the
 * planning grid both reflect ONLY the non-suppressed set — once
 * everything's hidden the banner disappears and the cells lose
 * their red ring. That's the whole point of "overrule": acknowledge
 * the conflict, move on.
 *
 * Collapsed by default to keep visual weight low when there's
 * nothing to act on; expands inline to show every violation
 * message with its kind + per-row controls.
 */
export function ViolationsBanner({
  scheduleId,
  violations,
}: {
  scheduleId: number;
  violations: Violation[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Whether the admin has chosen to also surface the hidden ones.
  // Resets on every banner remount (which happens on schedule
  // navigation) — the default is "hide what's been overruled."
  const [showHidden, setShowHidden] = useState(false);

  const active = useMemo(
    () => violations.filter((v) => v.suppressed_at === null),
    [violations],
  );
  const hidden = useMemo(
    () => violations.filter((v) => v.suppressed_at !== null),
    [violations],
  );

  const suppress = useMutation({
    mutationFn: (v: Violation) =>
      api.suppressScheduleViolation(scheduleId, {
        signature: v.signature,
        kind: v.kind,
      }),
    onSuccess: () => {
      // Refetch so the violation re-serializes with
      // suppressed_at set, the banner tone recomputes, and the
      // cell-ring set narrows.
      qc.invalidateQueries({ queryKey: ["schedule-violations", scheduleId] });
    },
  });
  const unsuppress = useMutation({
    mutationFn: (v: Violation) =>
      api.unsuppressScheduleViolation(scheduleId, v.signature),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule-violations", scheduleId] });
    },
  });

  // Banner disappears entirely when every conflict is overruled
  // AND the admin hasn't opted into showing hidden ones. We keep
  // a tiny "N conflictos ocultos · mostrar" affordance so they're
  // never permanently invisible, mounted as its own pill below.
  if (active.length === 0 && hidden.length === 0) return null;
  if (active.length === 0 && !showHidden) {
    return (
      <div className="mb-4 flex items-center gap-2 text-xs text-gray-500">
        <EyeOff className="h-3.5 w-3.5" />
        <span>
          {hidden.length === 1
            ? "1 conflicto oculto"
            : `${hidden.length} conflictos ocultos`}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowHidden(true);
            setOpen(true);
          }}
          className="font-medium text-gray-700 underline-offset-2 hover:underline"
        >
          Mostrar
        </button>
      </div>
    );
  }

  // Tone the banner by the worst severity present in the ACTIVE
  // set. Hard rules → rose; soft + implicit-only → amber.
  // Implicit checks (time_overlap, post_rest) have no severity in
  // the data but are treated as hard since they're impossible
  // physical conflicts.
  const hasHard = active.some(
    (v) => v.severity === "hard" || v.severity === null,
  );
  const tone = hasHard ? "rose" : "amber";

  const wrapperClass =
    tone === "rose"
      ? "border-rose-200 bg-rose-50/70"
      : "border-amber-200 bg-amber-50/70";
  const titleClass = tone === "rose" ? "text-rose-900" : "text-amber-900";
  const iconClass = tone === "rose" ? "text-rose-600" : "text-amber-600";

  // Build the render list: active always; hidden only if the
  // admin's toggled "Mostrar X ocultos". Hidden entries render
  // with a struck-through, gray look + a "Mostrar" button instead
  // of "Ocultar".
  const rows: Violation[] = showHidden ? [...active, ...hidden] : active;

  return (
    <div
      className={
        "mb-4 rounded-xl border " + wrapperClass + " overflow-hidden"
      }
    >
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
      >
        <AlertTriangle className={"h-5 w-5 shrink-0 " + iconClass} />
        <div className="flex-1 min-w-0">
          <div className={"text-sm font-semibold " + titleClass}>
            {active.length === 1
              ? "1 conflicto detectado"
              : `${active.length} conflictos detectados`}
            {hidden.length > 0 && (
              <span className="ml-2 text-xs font-normal text-gray-600">
                · {hidden.length} oculto{hidden.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-600">
            Pulsa para ver los detalles. Puedes ocultar los
            conflictos que no apliquen.
          </div>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-500 shrink-0" />
        )}
      </button>
      {open && (
        <>
          <ul className="divide-y divide-gray-200 border-t border-gray-200 bg-white">
            {rows.map((v) => {
              const isHidden = v.suppressed_at !== null;
              return (
                <li
                  key={v.signature}
                  className={
                    "flex items-start gap-2 px-4 py-2 text-sm "
                    + (isHidden ? "bg-gray-50" : "")
                  }
                >
                  <KindBadge kind={v.kind} severity={v.severity} />
                  <span
                    className={
                      "flex-1 "
                      + (isHidden
                        ? "text-gray-500 line-through decoration-gray-300"
                        : "text-gray-800")
                    }
                  >
                    {v.message}
                  </span>
                  {isHidden ? (
                    <button
                      type="button"
                      onClick={() => unsuppress.mutate(v)}
                      disabled={unsuppress.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Mostrar
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => suppress.mutate(v)}
                      disabled={suppress.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      title="No es un problema en este caso — ocultar"
                    >
                      <EyeOff className="h-3.5 w-3.5" />
                      Ocultar
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {hidden.length > 0 && (
            <div className="border-t border-gray-200 bg-white px-4 py-2 text-xs text-gray-600">
              <button
                type="button"
                onClick={() => setShowHidden((x) => !x)}
                className="font-medium text-gray-700 underline-offset-2 hover:underline"
              >
                {showHidden
                  ? "Esconder los ya overrulados"
                  : `Mostrar ${hidden.length} ya overrulado${hidden.length === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const KIND_LABEL: Record<Violation["kind"], string> = {
  incompatibility: "Mismo día",
  succession: "Sucesión",
  frequency: "Frecuencia",
  time_overlap: "Solape",
  post_rest: "Descanso",
};

function KindBadge({
  kind,
  severity,
}: {
  kind: Violation["kind"];
  severity: Violation["severity"];
}) {
  const isHard = severity === "hard" || severity === null;
  const cls = isHard
    ? "bg-rose-100 text-rose-800 ring-rose-200"
    : "bg-amber-100 text-amber-800 ring-amber-200";
  return (
    <span
      className={
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 "
        + cls
      }
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

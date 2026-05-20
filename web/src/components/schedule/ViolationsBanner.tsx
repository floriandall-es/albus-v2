"use client";
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import type { Violation } from "@/lib/api";

/**
 * Top-of-page warning banner listing every rule breach Trivu has
 * detected in the schedule's current assignments. Warnings only —
 * the admin can save anything and we'll surface what they broke,
 * but nothing here blocks an edit.
 *
 * Collapsed by default to keep visual weight low when there's
 * nothing to act on; expands inline to show every violation
 * message with its kind.
 */
export function ViolationsBanner({
  violations,
}: {
  violations: Violation[];
}) {
  const [open, setOpen] = useState(false);

  if (violations.length === 0) return null;

  // Tone the banner by the worst severity present. Hard rules → rose;
  // soft + implicit-only → amber. Implicit checks (time_overlap,
  // post_rest) have no severity in the data but are treated as hard
  // since they're impossible physical conflicts.
  const hasHard = violations.some(
    (v) => v.severity === "hard" || v.severity === null,
  );
  const tone = hasHard ? "rose" : "amber";

  const wrapperClass =
    tone === "rose"
      ? "border-rose-200 bg-rose-50/70"
      : "border-amber-200 bg-amber-50/70";
  const titleClass = tone === "rose" ? "text-rose-900" : "text-amber-900";
  const iconClass = tone === "rose" ? "text-rose-600" : "text-amber-600";

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
            {violations.length === 1
              ? "1 conflicto detectado"
              : `${violations.length} conflictos detectados`}
          </div>
          <div className="text-xs text-gray-600">
            Pulsa para ver los detalles y corregir antes de publicar.
          </div>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-500 shrink-0" />
        )}
      </button>
      {open && (
        <ul className="divide-y divide-gray-200 border-t border-gray-200 bg-white">
          {violations.map((v, i) => (
            <li key={i} className="px-4 py-2 text-sm flex items-start gap-2">
              <KindBadge kind={v.kind} severity={v.severity} />
              <span className="text-gray-800">{v.message}</span>
            </li>
          ))}
        </ul>
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

"use client";
import { type Assignment } from "@/lib/api";
import { formatHours, formatLongDate } from "@/lib/dates";

/**
 * Single-line summary of an upcoming shift, used both on the
 * `/me` landing page ("Tu próximo turno") and at the top of
 * `/me/turnos` (same content, same look). Wording follows the
 * pattern "Lunes 18 mayo — Quirófano · Cirujano 1 — 08:00 a 15:00".
 *
 * Pass `title` to override the default "Tu próximo turno" label
 * (the /me landing reuses this for "Hoy" / "Mañana" cards).
 */
export function NextShiftBanner({
  shift,
  title = "Tu próximo turno",
}: {
  shift: Assignment;
  title?: string;
}) {
  const hours = formatHours(shift.slot_start_time, shift.slot_end_time);
  return (
    <div className="rounded-xl bg-brand-50/60 ring-1 ring-brand-200 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
        {title}
      </div>
      <div className="mt-1 text-sm text-brand-900">
        <span className="font-semibold">{formatLongDate(shift.date)}</span>
        <span className="text-brand-700/70"> — </span>
        <span>{shift.slot_name}</span>
        {shift.team_role_label && (
          <span className="text-brand-700/80">
            <span className="text-brand-700/70"> · </span>
            {shift.team_role_label}
          </span>
        )}
        {hours && (
          <>
            <span className="text-brand-700/70"> — </span>
            <span>{hours}</span>
          </>
        )}
      </div>
    </div>
  );
}

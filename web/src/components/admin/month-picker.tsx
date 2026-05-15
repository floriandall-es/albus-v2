"use client";
import { useMemo } from "react";

const MONTHS_ES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

// Format a YYYY-MM-DD ISO period (always first-of-month from the API) as
// human-readable Spanish "Junio 2026". Capitalised.
export function formatPeriod(iso: string): string {
  // Parse manually to avoid timezone surprises (new Date("2026-05-01")
  // gets interpreted as UTC midnight which can shift to the previous day
  // in negative-offset zones).
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const year = m[1];
  const monthIdx = Number(m[2]) - 1;
  return `${MONTHS_ES[monthIdx] ?? "?"} ${year}`;
}

// ISO first-of-month string from month+year. Used to round-trip through
// the API which still wants YYYY-MM-DD.
export function isoFromMonthYear(month: number, year: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

type Props = {
  label?: string;
  /** ISO yyyy-MM-dd (first of month). */
  value: string;
  onChange: (iso: string) => void;
  /** Year range; defaults to current ±3. */
  minYear?: number;
  maxYear?: number;
};

export function MonthPicker({
  label,
  value,
  onChange,
  minYear,
  maxYear,
}: Props) {
  const m = /^(\d{4})-(\d{2})/.exec(value);
  const year = m ? Number(m[1]) : new Date().getFullYear();
  const monthIdx = m ? Number(m[2]) - 1 : new Date().getMonth();

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const lo = minYear ?? now - 3;
    const hi = maxYear ?? now + 3;
    const arr: number[] = [];
    for (let y = lo; y <= hi; y++) arr.push(y);
    return arr;
  }, [minYear, maxYear]);

  return (
    <div className="block">
      {label && (
        <span className="text-sm font-medium text-gray-700">{label}</span>
      )}
      <div className={(label ? "mt-1 " : "") + "flex gap-2"}>
        <select
          value={monthIdx}
          onChange={(e) =>
            onChange(isoFromMonthYear(Number(e.target.value), year))
          }
          className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
        >
          {MONTHS_ES.map((name, i) => (
            <option key={i} value={i}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) =>
            onChange(isoFromMonthYear(monthIdx, Number(e.target.value)))
          }
          className="w-24 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

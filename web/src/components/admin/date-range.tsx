"use client";
import { useEffect, useRef, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { es } from "date-fns/locale";
import { format, isValid, parse } from "date-fns";
import "react-day-picker/style.css";

type Props = {
  startLabel?: string;
  endLabel?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  onChange: (start: string, end: string) => void;
  required?: boolean;
};

// Pretty date-range picker for vacation / availability-block requests.
// Renders two readonly text inputs (formatted dd/MM/yyyy) and a single
// dropdown calendar showing both months, click start then click end.
export function DateRangeField({
  startLabel = "Desde",
  endLabel = "Hasta",
  startDate,
  endDate,
  onChange,
  required,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        wrapRef.current
        && !wrapRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const parseIso = (s: string): Date | undefined => {
    if (!s) return undefined;
    const d = parse(s, "yyyy-MM-dd", new Date());
    return isValid(d) ? d : undefined;
  };

  const range: DateRange | undefined = startDate
    ? { from: parseIso(startDate), to: parseIso(endDate) }
    : undefined;

  const display = (d: Date | undefined) =>
    d ? format(d, "dd/MM/yyyy") : "";

  const handleSelect = (r: DateRange | undefined) => {
    if (!r) {
      onChange("", "");
      return;
    }
    const fromStr = r.from ? format(r.from, "yyyy-MM-dd") : "";
    const toStr = r.to ? format(r.to, "yyyy-MM-dd") : "";
    onChange(fromStr, toStr);
    // Close once both ends picked.
    if (r.from && r.to) setOpen(false);
  };

  const placeholder = "dd/mm/yyyy";

  return (
    <div ref={wrapRef} className="relative">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            {startLabel}
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={
              "mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm "
              + (startDate ? "text-gray-900" : "text-gray-400")
            }
          >
            {startDate ? display(parseIso(startDate)) : placeholder}
          </button>
          {/* Hidden input so native form validation can still flag empty range. */}
          {required && (
            <input
              tabIndex={-1}
              aria-hidden
              required
              value={startDate}
              onChange={() => undefined}
              className="sr-only"
            />
          )}
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">{endLabel}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={
              "mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm "
              + (endDate ? "text-gray-900" : "text-gray-400")
            }
          >
            {endDate ? display(parseIso(endDate)) : placeholder}
          </button>
          {required && (
            <input
              tabIndex={-1}
              aria-hidden
              required
              value={endDate}
              onChange={() => undefined}
              className="sr-only"
            />
          )}
        </label>
      </div>
      {open && (
        <div className="absolute left-0 z-50 mt-2 rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
          <DayPicker
            mode="range"
            numberOfMonths={2}
            selected={range}
            onSelect={handleSelect}
            locale={es}
            weekStartsOn={1}
            showOutsideDays
          />
        </div>
      )}
    </div>
  );
}

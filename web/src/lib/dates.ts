// Date helpers used by the member-facing pages (Inicio, Mis turnos)
// to render shifts in plain Spanish. Kept simple and locale-agnostic
// (no Intl.DateTimeFormat) so the wording matches the rest of the
// app and doesn't drift based on browser locale.

export const WEEKDAY_LONG_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

export const MONTH_SHORT_ES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

export const MONTH_LONG_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/** Parse a YYYY-MM-DD string as a LOCAL-time Date. Avoids JS's
 * default "ISO without time = UTC midnight" gotcha that shifts dates
 * by one day in negative timezones. */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Today's date as a YYYY-MM-DD string in local time. */
export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Tomorrow's date as a YYYY-MM-DD string in local time. */
export function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** "Lunes 18 mayo" — capitalized weekday + day + full month name. */
export function formatLongDate(iso: string): string {
  const d = parseIsoDate(iso);
  const weekday = WEEKDAY_LONG_ES[d.getDay()];
  const dayNum = d.getDate();
  const month = MONTH_LONG_ES[d.getMonth()];
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${dayNum} ${month}`;
}

/** "08:00 a 15:00". Returns null when either side is missing
 * (on-call / all-day slots). Accepts the HH:MM:SS strings the API
 * sends and trims the seconds. */
export function formatHours(
  start: string | null,
  end: string | null,
): string | null {
  if (!start || !end) return null;
  return `${start.slice(0, 5)} a ${end.slice(0, 5)}`;
}

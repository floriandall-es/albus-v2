"use client";
import { personLastName, type Assignment } from "@/lib/api";
import { Avatar } from "@/components/schedule/planning-grid";
import {
  MONTH_SHORT_ES,
  WEEKDAY_LONG_ES,
  formatHours,
} from "@/lib/dates";

/**
 * Shared shift-list primitives used by both /me (Inicio dashboard)
 * and /me/turnos (full month list). Same look, same click behavior —
 * one place to keep them consistent.
 *
 * ShiftSection renders a labelled card list. Pass an array of
 * assignments and an onClick handler; locked shifts render as
 * non-interactive rows with a small "Bloqueado" badge.
 */

export function ShiftSection({
  title,
  items,
  emptyText,
  todayIso,
  dimmed = false,
  onClickShift,
  canRequestCoverage = true,
  showPerson = false,
  myPersonId,
}: {
  title: string;
  items: Assignment[];
  /** Show this gray-text card when `items` is empty. Omit to
   * collapse empty sections silently. */
  emptyText?: string;
  todayIso: string;
  /** Render the rows in a muted style — used for the "Pasados"
   * section on /me/turnos. */
  dimmed?: boolean;
  onClickShift: (a: Assignment) => void;
  /** Sub-equipo members can't request coverage through the system
   * yet — their lead handles it offline. When false the row is
   * non-interactive and the "Pedir cobertura →" hint is hidden. */
  canRequestCoverage?: boolean;
  /** When true, each row carries an avatar + person's last name so
   * the section can list the entire team. Used by /me/turnos's
   * Ámbito=Equipo + Vista=Lista view. */
  showPerson?: boolean;
  /** Person id of the current user. Only used in tandem with
   * `showPerson` to tint their own rows + render the avatar with the
   * brand-blue ring, so the user can spot themselves in a long team
   * list at a glance. */
  myPersonId?: number | null;
}) {
  if (items.length === 0) {
    if (!emptyText) return null;
    return (
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </h2>
        <div className="rounded-xl bg-white p-4 ring-1 ring-gray-200 text-sm text-gray-500">
          {emptyText}
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </h2>
      <ul className="divide-y divide-gray-100 rounded-xl bg-white ring-1 ring-gray-200 overflow-hidden">
        {items.map((a) => (
          <ShiftRow
            key={a.id}
            a={a}
            todayIso={todayIso}
            dimmed={dimmed}
            onClick={onClickShift}
            canRequestCoverage={canRequestCoverage}
            showPerson={showPerson}
            isMine={myPersonId != null && a.person_id === myPersonId}
          />
        ))}
      </ul>
    </div>
  );
}

function ShiftRow({
  a,
  todayIso,
  dimmed,
  onClick,
  canRequestCoverage,
  showPerson,
  isMine,
}: {
  a: Assignment;
  todayIso: string;
  dimmed: boolean;
  onClick: (a: Assignment) => void;
  canRequestCoverage: boolean;
  showPerson: boolean;
  isMine: boolean;
}) {
  const isToday = a.date === todayIso;
  const isLocked = !!a.locked_at;
  // Effectively "is the row clickable?" — locked turns it off, sub-
  // equipo members never get the coverage flow at all, and team-list
  // rows that aren't mine are also non-interactive (can't request
  // coverage for someone else).
  const isInteractive =
    !isLocked && canRequestCoverage && (!showPerson || isMine);
  // The list item is a button when clickable (not locked); plain
  // div otherwise. Either way it sits 44px+ tall for touch targets.
  const body = (
    <div
      className={
        "flex items-center gap-4 px-4 py-3 "
        + (showPerson && isMine ? "bg-brand-50/40" : "")
      }
    >
      <DateBlock dateIso={a.date} highlight={isToday} dimmed={dimmed} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={
              "text-base font-semibold "
              + (dimmed ? "text-gray-500" : "text-gray-900")
            }
          >
            {a.slot_name}
          </span>
          {a.team_role_label && (
            <span className="text-sm text-gray-500">
              · {a.team_role_label}
            </span>
          )}
          {/* The "Bloqueado" badge used to live here. Removed
              because members don't need to know an admin
              pinned the shift — the lock's only behavioural
              consequence for them is "no coverage button",
              which the conditional render below already handles
              silently. The internal `isLocked` flag stays so
              that gate keeps working. */}
        </div>
        <ShiftTimeBadge a={a} inline />
      </div>
      {showPerson && a.person_id != null && a.person_name && (
        <div className="hidden sm:flex items-center gap-1.5 shrink-0 text-xs text-gray-700">
          <Avatar
            name={a.person_name}
            mine={isMine}
            imageUrl={a.person_avatar_url}
          />
          <span className={isMine ? "font-medium text-brand-700" : ""}>
            {personLastName({
              name: a.person_name,
              last_name: a.person_last_name,
            })}
          </span>
        </div>
      )}
      {isInteractive && (
        <span className="hidden sm:inline text-xs text-brand-700 group-hover:underline">
          Pedir cobertura →
        </span>
      )}
    </div>
  );
  if (!isInteractive) {
    return <li className="bg-white">{body}</li>;
  }
  return (
    <li className="bg-white group hover:bg-brand-50/30 transition-colors">
      <button
        type="button"
        onClick={() => onClick(a)}
        className="block w-full text-left"
        aria-label={`Pedir cobertura para ${a.slot_name} el ${a.date}`}
      >
        {body}
      </button>
    </li>
  );
}

function DateBlock({
  dateIso,
  highlight,
  dimmed,
}: {
  dateIso: string;
  highlight: boolean;
  dimmed: boolean;
}) {
  // Parse local-date safely (avoid the JS Date timezone trap for
  // YYYY-MM-DD strings, which the engine treats as UTC midnight).
  const [yy, mm, dd] = dateIso.split("-").map(Number);
  const d = new Date(yy, mm - 1, dd);
  const weekday = WEEKDAY_LONG_ES[d.getDay()].slice(0, 3);
  const dayNum = String(d.getDate()).padStart(2, "0");
  const monthShort = MONTH_SHORT_ES[d.getMonth()];
  return (
    <div
      className={
        "shrink-0 w-14 text-center rounded-lg border px-1 py-1.5 "
        + (highlight
          ? "border-brand-300 bg-brand-50 text-brand-700"
          : dimmed
            ? "border-gray-200 bg-gray-50 text-gray-400"
            : "border-gray-200 bg-white text-gray-700")
      }
    >
      <div className="text-[10px] uppercase tracking-wide">{weekday}</div>
      <div
        className={
          "text-xl font-bold leading-none "
          + (highlight
            ? "text-brand-800"
            : dimmed
              ? "text-gray-500"
              : "text-gray-900")
        }
      >
        {dayNum}
      </div>
      <div className="text-[10px] uppercase">{monthShort}</div>
    </div>
  );
}

function ShiftTimeBadge({
  a,
  inline = false,
}: {
  a: Assignment;
  inline?: boolean;
}) {
  const hours = formatHours(a.slot_start_time, a.slot_end_time);
  if (!hours) return null;
  return (
    <span
      className={
        (inline ? "mt-0.5 block " : "ml-2 inline ") + "text-xs text-gray-500"
      }
    >
      {hours}
    </span>
  );
}

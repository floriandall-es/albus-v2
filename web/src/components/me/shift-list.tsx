"use client";
import { Users } from "lucide-react";
import {
  personLastName,
  type Assignment,
  type AvailabilityBlockType,
  type MeetingInstance,
  type TeamAbsence,
} from "@/lib/api";
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
  meetings,
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
  /** Meeting instances to render *after* the shifts inside the same
   * card. The /me Inicio page passes today's + tomorrow's meetings
   * here so the user sees their whole agenda at a glance, not just
   * the clinical shifts. Non-interactive rows — for full meeting
   * detail / edit / delete the user goes to /me/reuniones. */
  meetings?: MeetingInstance[];
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
  const meetingsList = meetings ?? [];
  if (items.length === 0 && meetingsList.length === 0) {
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
        {meetingsList.map((m) => (
          <MeetingRow
            key={`meeting_${m.meeting_id}_${m.date}`}
            inst={m}
            todayIso={todayIso}
            dimmed={dimmed}
          />
        ))}
      </ul>
    </div>
  );
}

/** Read-only "reunión" row to mix into ShiftSection cards. Uses the
 * same DateBlock + row layout as ShiftRow so the agenda reads as one
 * thing, with a distinct left icon and a "Reunión" label so a member
 * can't confuse a meeting with a clinical shift. Clicking does
 * nothing — full detail lives on /me/reuniones. */
function MeetingRow({
  inst,
  todayIso,
  dimmed,
}: {
  inst: MeetingInstance;
  todayIso: string;
  dimmed: boolean;
}) {
  const isToday = inst.date === todayIso;
  const timeRange = `${inst.start_time.slice(0, 5)}–${inst.end_time.slice(0, 5)}`;
  return (
    <li className="bg-white">
      <div className="flex items-center gap-4 px-4 py-3">
        <DateBlock dateIso={inst.date} highlight={isToday} dimmed={dimmed} />
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
          <Users className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={
              "truncate text-base font-semibold "
              + (dimmed ? "text-gray-500" : "text-gray-900")
            }
          >
            {inst.title}
          </div>
          <div
            className={
              "mt-0.5 flex items-baseline gap-2 flex-wrap text-sm "
              + (dimmed ? "text-gray-400" : "text-gray-600")
            }
          >
            <span className="inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-700">
              Reunión
            </span>
            <span>{timeRange}</span>
            {inst.location && (
              <span className="text-gray-400 truncate">· {inst.location}</span>
            )}
          </div>
        </div>
      </div>
    </li>
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
  //
  // Two layouts depending on `showPerson`:
  //   - showPerson=false (Mis-only list): shift name is the lead
  //     because every row is the same person.
  //   - showPerson=true (Equipo list): the assigned person is the
  //     lead — clinicians scanning the team roster need to spot
  //     "who's on" before "what they're doing", so the name + avatar
  //     get top billing and the slot becomes the supporting line.
  const personPrimary =
    showPerson && a.person_id != null && a.person_name
      ? personLastName({
          name: a.person_name,
          last_name: a.person_last_name,
        })
      : null;
  const body = (
    <div
      className={
        "flex items-center gap-4 px-4 py-3 "
        + (showPerson && isMine ? "bg-brand-50/40" : "")
      }
    >
      <DateBlock dateIso={a.date} highlight={isToday} dimmed={dimmed} />
      {personPrimary && a.person_name ? (
        <>
          <Avatar
            name={a.person_name}
            mine={isMine}
            imageUrl={a.person_avatar_url}
            size="md"
          />
          <div className="flex-1 min-w-0">
            <div
              className={
                "truncate text-base font-semibold "
                + (isMine
                  ? "text-brand-700"
                  : dimmed
                    ? "text-gray-500"
                    : "text-gray-900")
              }
            >
              {personPrimary}
              {isMine && (
                <span className="ml-2 text-[11px] font-medium uppercase tracking-wide text-brand-600">
                  Tú
                </span>
              )}
            </div>
            <div
              className={
                "mt-0.5 flex items-baseline gap-2 flex-wrap text-sm "
                + (dimmed ? "text-gray-400" : "text-gray-600")
              }
            >
              <span>{a.slot_name}</span>
              {a.team_role_label && (
                <span className="text-gray-400">· {a.team_role_label}</span>
              )}
              {/* Equipo chip — only set on sibling-tenant rows in
                  the /me/turnos Servicio scope Lista. No chip on
                  the caller's own rows means "no chip = my equipo",
                  giving Servicio Lista a clean visual where the
                  user's own shifts read naturally and cross-team
                  rows are explicitly tagged. */}
              {a.tenant_name && (
                <span className="inline-flex items-center rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                  {a.tenant_name}
                </span>
              )}
              <ShiftTimeBadge a={a} />
            </div>
          </div>
        </>
      ) : (
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
                because members don't need to know an admin pinned
                the shift — the lock's only behavioural consequence
                for them is "no coverage button", which the
                conditional render below already handles silently.
                The internal `isLocked` flag stays so that gate
                keeps working. */}
          </div>
          <ShiftTimeBadge a={a} inline />
        </div>
      )}
      {isInteractive && (
        <span className="hidden sm:inline text-xs text-brand-700 group-hover:underline shrink-0">
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

// User-facing labels for AvailabilityBlock.block_type. Mirrors the
// map in planning-grid.tsx — duplicated rather than imported to
// keep this file's dependency on planning-grid limited to <Avatar>.
const ABSENCE_LABEL: Record<AvailabilityBlockType, string> = {
  vacation: "Vacaciones",
  sick: "Baja médica",
  training: "Formación",
  personal: "Personal",
  other: "Otro",
};

/**
 * /me/turnos "Mis turnos" list — one row per day in the active Rango,
 * including days with no shift. Off days surface as "Sin turno" or
 * "Libre · Vacaciones/Baja/…" when an approved absence covers the
 * user. The Equipo + Lista combination keeps using the date-sectioned
 * ShiftSection list above (different ergonomics: it groups today/
 * mañana/próximos by date instead of enumerating each calendar day).
 */
export function DayByDayList({
  dates,
  myAssignments,
  myAbsences,
  todayIso,
  onClickShift,
  canRequestCoverage,
}: {
  /** Enumerated YYYY-MM-DD dates to render, in display order. */
  dates: string[];
  /** Assignments already filtered to the current user. May include
   * dates outside `dates` — we filter again when bucketing. */
  myAssignments: Assignment[];
  /** Approved absences already filtered to the current user.
   * Range-typed (start_date..end_date), expanded per day inside. */
  myAbsences: TeamAbsence[];
  todayIso: string;
  onClickShift: (a: Assignment) => void;
  canRequestCoverage: boolean;
}) {
  // assignments by date — multiple shifts on the same day are
  // listed in their natural slot order.
  const byDate = new Map<string, Assignment[]>();
  for (const a of myAssignments) {
    const list = byDate.get(a.date) ?? [];
    list.push(a);
    byDate.set(a.date, list);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => a.slot_name.localeCompare(b.slot_name));
  }

  // Per-date absence lookup. Pick the FIRST absence covering each
  // date (sub-day overlaps are unusual in this app, and showing
  // multiple labels per off day would clutter the row).
  const absenceByDate = new Map<string, TeamAbsence>();
  for (const d of dates) {
    const hit = myAbsences.find((b) => b.start_date <= d && d <= b.end_date);
    if (hit) absenceByDate.set(d, hit);
  }

  return (
    <ul className="divide-y divide-gray-100 rounded-xl bg-white ring-1 ring-gray-200 overflow-hidden">
      {dates.map((d) => {
        const shifts = byDate.get(d) ?? [];
        const absence = absenceByDate.get(d);
        const isPast = d < todayIso;
        return (
          <DayRow
            key={d}
            dateIso={d}
            shifts={shifts}
            absence={absence}
            todayIso={todayIso}
            dimmed={isPast}
            onClickShift={onClickShift}
            canRequestCoverage={canRequestCoverage}
          />
        );
      })}
    </ul>
  );
}

function DayRow({
  dateIso,
  shifts,
  absence,
  todayIso,
  dimmed,
  onClickShift,
  canRequestCoverage,
}: {
  dateIso: string;
  shifts: Assignment[];
  absence: TeamAbsence | undefined;
  todayIso: string;
  dimmed: boolean;
  onClickShift: (a: Assignment) => void;
  canRequestCoverage: boolean;
}) {
  const isToday = dateIso === todayIso;
  return (
    <li className={dimmed ? "bg-gray-50/40" : "bg-white"}>
      <div className="flex items-start gap-4 px-4 py-3">
        <DateBlock dateIso={dateIso} highlight={isToday} dimmed={dimmed} />
        <div className="min-w-0 flex-1">
          {shifts.length > 0 && (
            <ul className="space-y-1.5">
              {shifts.map((a) => (
                <ShiftEntry
                  key={a.id}
                  a={a}
                  dimmed={dimmed}
                  canRequestCoverage={canRequestCoverage}
                  onClick={onClickShift}
                />
              ))}
            </ul>
          )}
          {shifts.length === 0 && (
            <EmptyDayContent absence={absence} dimmed={dimmed} />
          )}
        </div>
      </div>
    </li>
  );
}

/** Single shift inside a DayRow. Same look as ShiftRow's body but
 * without the DateBlock (DayRow already shows the date once on the
 * left). Kept as a separate component so the "Pedir cobertura →"
 * hint and clickability behave identically across rows. */
function ShiftEntry({
  a,
  dimmed,
  canRequestCoverage,
  onClick,
}: {
  a: Assignment;
  dimmed: boolean;
  canRequestCoverage: boolean;
  onClick: (a: Assignment) => void;
}) {
  const isLocked = !!a.locked_at;
  const isInteractive = !isLocked && canRequestCoverage;
  const body = (
    <div className="flex items-baseline gap-2 flex-wrap">
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
      <ShiftTimeBadge a={a} />
      {isInteractive && (
        <span className="ml-auto hidden sm:inline text-xs text-brand-700 group-hover:underline">
          Pedir cobertura →
        </span>
      )}
    </div>
  );
  if (!isInteractive) {
    return <li>{body}</li>;
  }
  return (
    <li className="group">
      <button
        type="button"
        onClick={() => onClick(a)}
        className="block w-full text-left rounded hover:bg-brand-50/30 transition-colors -mx-1 px-1 py-0.5"
        aria-label={`Pedir cobertura para ${a.slot_name} el ${a.date}`}
      >
        {body}
      </button>
    </li>
  );
}

function EmptyDayContent({
  absence,
  dimmed,
}: {
  absence: TeamAbsence | undefined;
  dimmed: boolean;
}) {
  if (absence) {
    return (
      <div className="text-sm">
        <span
          className={
            "font-medium "
            + (dimmed ? "text-gray-500" : "text-emerald-700")
          }
        >
          Libre
        </span>
        <span className="text-gray-500"> · {ABSENCE_LABEL[absence.block_type]}</span>
      </div>
    );
  }
  return (
    <div
      className={
        "text-sm italic " + (dimmed ? "text-gray-400" : "text-gray-500")
      }
    >
      Sin turno
    </div>
  );
}

"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ArrowRight,
  CalendarDays,
  CalendarOff,
  Settings,
} from "lucide-react";
import {
  api,
  personFirstName,
  type Assignment,
  type MeetingInstance,
} from "@/lib/api";
import { Card } from "@/components/admin/ui";
import { ShiftSection } from "@/components/me/shift-list";
import { RequestCoverageModal } from "@/components/me/request-coverage-modal";
import { todayIso, tomorrowIso } from "@/lib/dates";

/**
 * Member landing page (`/me`). Replaces the previous bare redirect
 * to /me/turnos. What a logged-in member sees the second they
 * arrive:
 *
 * - Greeting with their first name.
 * - Today's + tomorrow's agenda: shifts plus meetings they're
 *   invited to, rendered with the same ShiftSection rows as on
 *   /me/turnos so the design is consistent across the two pages.
 * - Four quick-access cards mirroring the sidebar (Mis turnos,
 *   Cambios, Mis bloqueos, Mi cuenta).
 *
 * Cuts the "open app → tap nav → scan grid" sequence down to "open
 * app → glance" for the common case.
 */
export default function MeHome() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });
  const [swapTarget, setSwapTarget] = useState<Assignment | null>(null);

  // Members only see published schedules.
  const publishedSchedules = useMemo(() => {
    const all = schedules.data ?? [];
    return all.filter((s) => s.status === "published");
  }, [schedules.data]);

  // Both today and tomorrow can live in the same calendar month,
  // OR straddle a month boundary. Resolve which schedule(s) we need.
  const todayIsoStr = useMemo(() => todayIso(), []);
  const tomorrowIsoStr = useMemo(() => tomorrowIso(), []);
  const todayMonth = todayIsoStr.slice(0, 7);
  const tomorrowMonth = tomorrowIsoStr.slice(0, 7);
  const todaySchedule = publishedSchedules.find(
    (s) => s.period.slice(0, 7) === todayMonth,
  );
  const tomorrowSchedule = publishedSchedules.find(
    (s) => s.period.slice(0, 7) === tomorrowMonth,
  );
  // De-dupe — same month covers both days most of the time.
  const scheduleIdsToLoad = Array.from(
    new Set(
      [todaySchedule, tomorrowSchedule]
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s) => s.id),
    ),
  );

  const detailA = useQuery({
    queryKey: ["schedule", scheduleIdsToLoad[0]],
    queryFn: () => api.getSchedule(scheduleIdsToLoad[0]!),
    enabled: scheduleIdsToLoad[0] !== undefined,
  });
  const detailB = useQuery({
    queryKey: ["schedule", scheduleIdsToLoad[1]],
    queryFn: () => api.getSchedule(scheduleIdsToLoad[1]!),
    enabled: scheduleIdsToLoad[1] !== undefined,
  });

  const myShiftsByDate = useMemo(() => {
    if (!me.data) return new Map<string, Assignment[]>();
    const personId = me.data.person.id;
    const allAssignments: Assignment[] = [
      ...(detailA.data?.assignments ?? []),
      ...(detailB.data?.assignments ?? []),
    ];
    const map = new Map<string, Assignment[]>();
    for (const a of allAssignments) {
      if (a.person_id !== personId) continue;
      const list = map.get(a.date) ?? [];
      list.push(a);
      map.set(a.date, list);
    }
    // Stable per-day order: by slot_position then slot_name.
    for (const list of map.values()) {
      list.sort((x, y) => {
        if (x.slot_position !== y.slot_position) {
          return x.slot_position - y.slot_position;
        }
        return x.slot_name.localeCompare(y.slot_name);
      });
    }
    return map;
  }, [me.data, detailA.data, detailB.data]);

  // Meetings the user is invited to in the today..tomorrow window.
  // The list endpoint is already audience-scoped server-side so we
  // just take what comes back and bucket by date.
  const meetings = useQuery({
    queryKey: ["meeting-instances-inicio", todayIsoStr, tomorrowIsoStr],
    queryFn: () =>
      api.listMeetingInstances(todayIsoStr, tomorrowIsoStr),
  });
  const meetingsByDate = useMemo(() => {
    const map = new Map<string, MeetingInstance[]>();
    for (const m of meetings.data ?? []) {
      const list = map.get(m.date) ?? [];
      list.push(m);
      map.set(m.date, list);
    }
    // Earlier meetings first.
    for (const list of map.values()) {
      list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    }
    return map;
  }, [meetings.data]);

  if (me.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (!me.data) return null;

  const firstName = personFirstName(me.data.person);
  const todayShifts = myShiftsByDate.get(todayIsoStr) ?? [];
  const tomorrowShifts = myShiftsByDate.get(tomorrowIsoStr) ?? [];
  const todayMeetings = meetingsByDate.get(todayIsoStr) ?? [];
  const tomorrowMeetings = meetingsByDate.get(tomorrowIsoStr) ?? [];
  const anyToday = todayShifts.length > 0 || todayMeetings.length > 0;
  const anyTomorrow =
    tomorrowShifts.length > 0 || tomorrowMeetings.length > 0;
  const anyContent = anyToday || anyTomorrow;

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">
          {firstName ? `Hola, ${firstName}` : "Hola"}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {anyContent
            ? "Tu agenda para hoy y mañana."
            : "No tienes turnos ni reuniones hoy ni mañana."}
        </p>
      </header>

      {/* Today / tomorrow agenda — shifts (clickable for coverage)
          plus meeting instances mixed into the same per-day card. */}
      {anyContent && (
        <section className="mb-8 space-y-4">
          {anyToday && (
            <ShiftSection
              title="Hoy"
              items={todayShifts}
              meetings={todayMeetings}
              todayIso={todayIsoStr}
              onClickShift={(a) => {
                if (a.locked_at) return;
                setSwapTarget(a);
              }}
              canRequestCoverage={true}
            />
          )}
          {anyTomorrow && (
            <ShiftSection
              title="Mañana"
              items={tomorrowShifts}
              meetings={tomorrowMeetings}
              todayIso={todayIsoStr}
              onClickShift={(a) => {
                if (a.locked_at) return;
                setSwapTarget(a);
              }}
              canRequestCoverage={true}
            />
          )}
        </section>
      )}

      {/* If neither today nor tomorrow has shifts or meetings,
          suggest looking at the upcoming list. */}
      {!anyContent && (
        <section className="mb-8">
          <Card>
            <div className="p-4 text-sm text-gray-600">
              Mira tus próximos turnos en{" "}
              <Link
                href="/me/turnos"
                className="font-medium text-brand-700 hover:underline"
              >
                Mis turnos
              </Link>
              {" "}o tus{" "}
              <Link
                href="/me/reuniones"
                className="font-medium text-brand-700 hover:underline"
              >
                reuniones
              </Link>
              .
            </div>
          </Card>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Accesos rápidos
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ShortcutCard
            icon={<CalendarDays className="h-5 w-5" />}
            label="Mis turnos"
            sublabel="Lista o planificación del equipo"
            href="/me/turnos"
          />
          <ShortcutCard
            icon={<ArrowLeftRight className="h-5 w-5" />}
            label="Cambios"
            sublabel="Pide cobertura o responde a otros"
            href="/me/swaps"
          />
          <ShortcutCard
            icon={<CalendarOff className="h-5 w-5" />}
            label="Mis bloqueos"
            sublabel="Vacaciones, bajas, formación"
              href="/me/bloqueos"
          />
          <ShortcutCard
            icon={<Settings className="h-5 w-5" />}
            label="Mi cuenta"
            sublabel="Foto, email, contraseña"
            href="/me/settings"
          />
        </div>
      </section>

      {swapTarget && (
        <RequestCoverageModal
          assignment={swapTarget}
          onClose={() => setSwapTarget(null)}
        />
      )}
    </>
  );
}

function ShortcutCard({
  icon,
  label,
  sublabel,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  href: string;
}) {
  return (
    <Link href={href} className="block group">
      <Card>
        <div className="p-4 flex items-center gap-3 hover:bg-brand-50/30 transition-colors rounded-xl">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100 text-gray-700 shrink-0 group-hover:bg-brand-100 group-hover:text-brand-700 transition-colors">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900 truncate">
              {label}
            </div>
            <div className="text-xs text-gray-500 truncate">{sublabel}</div>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-gray-400 group-hover:text-brand-700 shrink-0" />
        </div>
      </Card>
    </Link>
  );
}

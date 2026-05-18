"use client";
import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ArrowRight,
  CalendarDays,
  CalendarOff,
  Settings,
} from "lucide-react";
import { api, personFirstName, type Assignment } from "@/lib/api";
import { Card } from "@/components/admin/ui";
import { NextShiftBanner } from "@/components/me/next-shift-banner";
import { todayIso, tomorrowIso } from "@/lib/dates";

/**
 * Member landing page (`/me`). Replaces the previous bare redirect
 * to /me/turnos. What a logged-in member sees the second they
 * arrive:
 *
 * - Greeting with their first name.
 * - Today's shifts (if any), then tomorrow's shifts (if any), each
 *   rendered with the same NextShiftBanner look as on /me/turnos.
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

  if (me.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (!me.data) return null;

  const firstName = personFirstName(me.data.person);
  const todayShifts = myShiftsByDate.get(todayIsoStr) ?? [];
  const tomorrowShifts = myShiftsByDate.get(tomorrowIsoStr) ?? [];
  const anyShifts = todayShifts.length > 0 || tomorrowShifts.length > 0;

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">
          {firstName ? `Hola, ${firstName}` : "Hola"}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {anyShifts
            ? "Tus turnos para hoy y mañana."
            : "No tienes turnos hoy ni mañana."}
        </p>
      </header>

      {/* Today / tomorrow shifts — only the cards that have content. */}
      {anyShifts && (
        <section className="mb-8 space-y-3">
          {todayShifts.map((a) => (
            <NextShiftBanner key={a.id} shift={a} title="Hoy" />
          ))}
          {tomorrowShifts.map((a) => (
            <NextShiftBanner key={a.id} shift={a} title="Mañana" />
          ))}
        </section>
      )}

      {/* If neither today nor tomorrow has shifts, suggest looking at
          the upcoming list. */}
      {!anyShifts && (
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

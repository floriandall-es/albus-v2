"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock, ArrowRight } from "lucide-react";
import { api, personFirstName } from "@/lib/api";
import { Card } from "@/components/admin/ui";

/**
 * Sub-team lead landing page. Shows them at a glance:
 *  - what activities their group currently has
 *  - how many people are in the group
 *  - shortcuts to the two things they actually do here
 */
export default function LeadInicio() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const slots = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  if (me.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }

  const firstName = me.data ? personFirstName(me.data.person) : null;
  // /api/slots and /api/team are already scoped server-side: a
  // group lead only gets back their group's rows. So counting
  // them gives the right "your group" totals without filtering.
  const activityCount = slots.data?.length ?? 0;
  const teamCount = team.data?.length ?? 0;

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">
          {firstName ? `Hola, ${firstName}` : "Hola"}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Aquí gestionas las actividades y la planificación de tu sub-equipo.
        </p>
      </header>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Resumen
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <div className="p-4 flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <Clock className="h-5 w-5" />
              </span>
              <div>
                <div className="text-2xl font-semibold text-gray-900">
                  {activityCount}
                </div>
                <div className="text-xs text-gray-500">
                  {activityCount === 1 ? "actividad" : "actividades"}
                </div>
              </div>
            </div>
          </Card>
          <Card>
            <div className="p-4 flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <CalendarDays className="h-5 w-5" />
              </span>
              <div>
                <div className="text-2xl font-semibold text-gray-900">
                  {teamCount}
                </div>
                <div className="text-xs text-gray-500">
                  {teamCount === 1 ? "miembro" : "miembros"} en el sub-equipo
                </div>
              </div>
            </div>
          </Card>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Accesos rápidos
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <ShortcutCard
            icon={<Clock className="h-5 w-5" />}
            label="Actividades"
            sublabel="Define los turnos que hace tu sub-equipo"
            href="/lead/actividades"
          />
          <ShortcutCard
            icon={<CalendarDays className="h-5 w-5" />}
            label="Planificación"
            sublabel="Asigna a tu equipo a cada día"
            href="/lead/planificacion"
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

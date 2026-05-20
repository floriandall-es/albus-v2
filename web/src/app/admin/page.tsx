"use client";
import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock,
  Layers,
  Sparkles,
  Stethoscope,
  Users,
} from "lucide-react";
import { api, personFirstName } from "@/lib/api";
import { Card } from "@/components/admin/ui";
import { formatPeriod } from "@/components/admin/month-picker";

/**
 * Admin landing dashboard. Replaces the previous bare redirect to
 * /admin/team. Designed for non-technical jefes who don't know the
 * sidebar yet — surfaces "what to do next" as big friendly cards
 * that derive their state from the tenant data, plus a row of
 * always-visible shortcuts to common actions.
 *
 * The setup checklist disappears once all four steps are done.
 */
export default function AdminDashboard() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });

  const state = useMemo(() => {
    const allSchedules = schedules.data ?? [];
    const todayIso = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const sorted = [...allSchedules].sort((a, b) =>
      a.period.localeCompare(b.period),
    );
    const currentMonth = sorted.find((s) => s.period.slice(0, 7) === todayIso);
    const upcoming = sorted.find((s) => s.period.slice(0, 7) > todayIso);
    const latest = [...sorted].reverse()[0] ?? null;
    const nextSchedule = currentMonth ?? upcoming ?? latest;

    const t = me.data?.current_tenant;
    // Explicit per-area "I'm done" flags toggled by the admin on
    // each subpage. Replacing the previous heuristic signals (which
    // lit up green the moment the admin ticked any template in the
    // wizard, making the checklist useless on real signups).
    return {
      activitiesDone: !!t?.setup_activities_completed_at,
      rulesDone: !!t?.setup_rules_completed_at,
      teamDone: !!t?.setup_team_completed_at,
      subteamsDone: !!t?.setup_subteams_completed_at,
      hasSubteamsFlag: t?.has_subteams ?? false,
      firstName: me.data ? personFirstName(me.data.person) : "",
      nextSchedule,
    };
  }, [me.data, schedules.data]);

  // Setup is "done" when every applicable area has been explicitly
  // marked done. Sub-equipos only counts when has_subteams=true.
  const setupDone =
    state.activitiesDone
    && state.rulesDone
    && state.teamDone
    && (!state.hasSubteamsFlag || state.subteamsDone);

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">
          {state.firstName ? `Hola, ${state.firstName}` : "Hola"}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {setupDone
            ? "Todo listo. Aquí tienes los accesos rápidos a las acciones más habituales."
            : "Estos son los siguientes pasos para que tu servicio esté funcionando."}
        </p>
      </header>

      {/* Setup checklist — only shown while there are pending items.
          Each card's `done` state is driven by the explicit
          tenant.setup_<area>_completed_at flag toggled on the
          subpage via the SetupBanner. The sub-equipos card only
          appears when the admin answered "Sí" at signup. */}
      {!setupDone && (
        <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StepCard
            done={state.activitiesDone}
            icon={<Stethoscope className="h-5 w-5" />}
            title="Configura las actividades del servicio"
            description="Define cada actividad (consulta, guardia, quirófano…) que utiliza tu servicio."
            ctaLabel="Ir a Actividades"
            href="/admin/slots"
            primary={!state.activitiesDone}
          />
          <StepCard
            done={state.rulesDone}
            icon={<Sparkles className="h-5 w-5" />}
            title="Configura las reglas del solver"
            description="Incompatibilidades del mismo día, sucesión entre actividades y límites por persona."
            ctaLabel="Ir a Reglas"
            href="/admin/rules"
            primary={state.activitiesDone && !state.rulesDone}
          />
          <StepCard
            done={state.teamDone}
            icon={<Users className="h-5 w-5" />}
            title="Revisa tu equipo"
            description="Las invitaciones ya se enviaron durante el alta. Asigna a cada miembro su categoría profesional para que el solver pueda repartir las actividades."
            ctaLabel="Ir al equipo"
            href="/admin/team"
            primary={
              state.activitiesDone
              && state.rulesDone
              && !state.teamDone
            }
          />
          {state.hasSubteamsFlag && (
            <StepCard
              done={state.subteamsDone}
              icon={<Layers className="h-5 w-5" />}
              title="Configura tus sub-equipos"
              description="Crea un sub-equipo (residentes, becarios, etc.) para que su responsable gestione sus propias actividades y planificación."
              ctaLabel="Ir a Sub-equipos"
              href="/admin/groups"
              primary={
                state.activitiesDone
                && state.rulesDone
                && state.teamDone
                && !state.subteamsDone
              }
            />
          )}
        </section>
      )}

      {/* Quick-action shortcuts. Always visible. */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Accesos rápidos
        </h2>
        {/* Order mirrors the "Operativa" group in the sidebar. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ShortcutCard
            icon={<CalendarDays className="h-5 w-5" />}
            label="Planificación"
            sublabel={
              state.nextSchedule
                ? formatPeriod(state.nextSchedule.period)
                : "Genera el primer mes"
            }
            href={
              state.nextSchedule
                ? `/admin/schedule/${state.nextSchedule.id}`
                : "/admin/schedule"
            }
          />
          <ShortcutCard
            icon={<BarChart3 className="h-5 w-5" />}
            label="Estadísticas"
            sublabel="Reparto por persona y actividad"
            href="/admin/stats"
          />
          <ShortcutCard
            icon={<ArrowLeftRight className="h-5 w-5" />}
            label="Cambios de turno"
            sublabel="Histórico y solicitudes"
            href="/admin/swaps"
          />
          <ShortcutCard
            icon={<Clock className="h-5 w-5" />}
            label="Bloqueos"
            sublabel="Vacaciones, bajas, formación"
            href="/admin/availability"
          />
        </div>
      </section>
    </>
  );
}

function StepCard({
  done,
  icon,
  title,
  description,
  ctaLabel,
  href,
  primary = false,
}: {
  done: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  ctaLabel: string;
  href: string;
  primary?: boolean;
}) {
  return (
    <Card>
      <div className="p-4 flex flex-col gap-3 h-full">
        <div className="flex items-start gap-3">
          <span
            className={
              "inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0 "
              + (done
                ? "bg-emerald-100 text-emerald-700"
                : primary
                  ? "bg-brand-100 text-brand-700"
                  : "bg-gray-100 text-gray-700")
            }
            aria-hidden
          >
            {done ? <CheckCircle2 className="h-5 w-5" /> : icon}
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-gray-900 leading-tight">
              {title}
            </h3>
            <p className="mt-1 text-xs text-gray-600 leading-relaxed">
              {description}
            </p>
          </div>
        </div>
        <Link
          href={href}
          className={
            "mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors "
            + (primary
              ? "bg-brand-600 text-white hover:bg-brand-700"
              : "border border-gray-300 text-gray-800 hover:bg-gray-50")
          }
        >
          {ctaLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Card>
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
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">
              {label}
            </div>
            <div className="text-xs text-gray-500 truncate">{sublabel}</div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CalendarOff,
  CheckCircle2,
  Clock,
  MailWarning,
  Sparkles,
  Stethoscope,
  Users,
} from "lucide-react";
import { api, personFirstName } from "@/lib/api";
import { Card } from "@/components/admin/ui";
import { formatPeriod } from "@/components/admin/month-picker";
import {
  ProductTour,
  type TourStep,
} from "@/components/onboarding/product-tour";

// First-visit-only flag for the /admin product tour. Local to this
// device — if the admin signs in on another browser later, they'll
// see the tour again. Acceptable trade-off vs adding a backend
// column for v1; can promote to a per-membership flag later if it
// becomes a real complaint.
//
// Versioned key: bump the suffix when we change the tour content
// or dismissal model enough that previously-dismissed users
// should see it again.
//
//   v2 — sidebar-walkthrough expansion (6 hero stops → one short
//        stop per sidebar item).
//   v3 — opt-in dismissal model. v2 silenced on any close action;
//        v3 only silences when the admin actively ticks "No
//        volver a mostrar". Anyone who closed v2 by mistake
//        deserves to see the new flow.
const TOUR_SEEN_KEY = "trivu.admin.tourSeen.v3";

// Stops are ordered to walk the sidebar top-to-bottom after the
// welcome + checklist overview, with a short one-liner per item.
// Module-gated items (Trasplantes, Directorio) and the dual-role
// ViewSwitcher are present here unconditionally — the ProductTour
// component drops any step whose anchor is missing from the DOM,
// so they only appear for tenants/users where they exist.
const TOUR_STEPS: TourStep[] = [
  {
    tourId: null,
    title: "Bienvenido a Trivu",
    body:
      "Te enseñamos rápidamente lo que ves en esta pantalla y "
      + "después cada sección del menú lateral, para que sepas "
      + "dónde está cada cosa. Cuando lo tengas claro, marca "
      + "\"No volver a mostrar este tour\" abajo.",
  },
  {
    tourId: "setup-checklist",
    title: "Lista de configuración",
    body:
      "Aquí ves lo que aún te queda por configurar para que tu "
      + "servicio esté funcionando. Cada tarjeta te lleva a la "
      + "sección correspondiente.",
    placement: "bottom",
  },

  // ViewSwitcher sits at the very top of the sidebar (above the
  // nav sections), so it makes sense to introduce it before we
  // start walking the nav items. Drops silently for non-dual-role
  // admins, who never see the pill in the first place.
  {
    tourId: "view-switcher",
    title: "Vista Admin vs Personal",
    body:
      "Si tú también haces turnos clínicos, cambia a \"Personal\" "
      + "para ver tu propio calendario, pedir cobertura o solicitar "
      + "días libres. Vuelve aquí cuando quieras gestionar el "
      + "servicio.",
    placement: "right",
  },

  // ---------- Operativa ----------
  {
    tourId: "nav-inicio",
    title: "Inicio",
    body:
      "Esta pantalla. Vuelve aquí en cualquier momento para ver el "
      + "resumen del servicio y los accesos rápidos.",
    placement: "right",
  },
  {
    tourId: "nav-planificacion",
    title: "Planificación",
    body:
      "Genera, ajusta y publica el calendario mensual. Una vez "
      + "publicado, el equipo lo verá en su sección \"Mis turnos\".",
    placement: "right",
  },
  {
    tourId: "nav-estadisticas",
    title: "Estadísticas",
    body:
      "Reparto de turnos por persona, por categoría y por mes. "
      + "Útil para comprobar que el reparto es equitativo.",
    placement: "right",
  },
  {
    tourId: "nav-swaps",
    title: "Cambios de turno",
    body:
      "Los miembros pueden pedir cobertura para sus turnos. Tú "
      + "apruebas o rechazas cada cambio desde aquí.",
    placement: "right",
  },
  {
    tourId: "nav-bloqueos",
    title: "Bloqueos",
    body:
      "Los miembros piden días libres (vacaciones, bajas, "
      + "formación…) y tú los apruebas o rechazas aquí. Los "
      + "bloqueos aprobados se reflejan en la planificación.",
    placement: "right",
  },
  {
    tourId: "nav-reuniones",
    title: "Reuniones",
    body:
      "Crea reuniones puntuales o recurrentes (sesión clínica, "
      + "comité de tumores…) para que el equipo las vea en su "
      + "planificación.",
    placement: "right",
  },
  {
    tourId: "nav-incidencias",
    title: "Incidencias",
    body:
      "Registro libre de eventos fuera de lo común: bajas "
      + "inesperadas, conflictos en cambios de turno, quejas…",
    placement: "right",
  },
  {
    tourId: "nav-trasplantes",
    title: "Trasplantes",
    body:
      "Registro detallado de cada caso (donante, receptor, equipos "
      + "explante e implante) con estadísticas por cirujano.",
    placement: "right",
  },
  {
    tourId: "nav-directorio",
    title: "Directorio del hospital",
    body:
      "Listado de contactos de otros servicios del hospital. Cada "
      + "persona decide qué datos comparte.",
    placement: "right",
  },

  // ---------- Configuración ----------
  {
    tourId: "nav-equipo",
    title: "Equipo",
    body:
      "Tu equipo. Aquí asignas la categoría profesional a cada "
      + "miembro y envías las invitaciones por email cuando todo "
      + "esté listo.",
    placement: "right",
  },
  {
    tourId: "nav-categorias",
    title: "Categorías",
    body:
      "Las categorías profesionales de tu servicio (adjunto, "
      + "residente R1, R2…) — definen quién puede hacer cada "
      + "actividad.",
    placement: "right",
  },
  // The "Sub-equipos" tour stop (nav-grupos) was removed in
  // Bucket 1 — the corresponding sidebar item no longer exists,
  // and orphan tour stops crash the guided-tour overlay.
  {
    tourId: "nav-actividades",
    title: "Actividades",
    body:
      "Las actividades que cubre tu servicio: guardia, consulta, "
      + "quirófano, planta… Aquí defines días, horario y "
      + "composición del equipo de cada una.",
    placement: "right",
  },
  {
    tourId: "nav-reglas",
    title: "Reglas",
    body:
      "Cómo Trivu reparte los turnos: límites por persona, "
      + "incompatibilidades entre actividades, días fijos, sucesión "
      + "entre actividades…",
    placement: "right",
  },
  {
    tourId: "nav-festivos",
    title: "Festivos",
    body:
      "Festivos importados según tu comunidad autónoma. Puedes "
      + "añadir o quitar días manualmente.",
    placement: "right",
  },

  // ---------- Cuenta + view switcher ----------
  {
    tourId: "nav-cuenta",
    title: "Mi cuenta",
    body:
      "Cambiar tu contraseña, ajustes personales y cerrar sesión.",
    placement: "right",
  },
];

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
  // Pendientes counts — same React Query key the sidebar layout
  // uses, so the two stay in lockstep with one network fetch.
  const pendientes = useQuery({
    queryKey: ["admin-pendientes"],
    queryFn: api.getAdminPendientes,
    refetchInterval: 60_000,
  });

  // Product-tour gate. Hydration-safe: start as null (= "don't
  // know yet"), then on mount read localStorage and either show or
  // mark already-seen. Avoids the "tour flashes on every refresh"
  // bug you get when you initialise from localStorage during SSR.
  //
  // Dismissal is OPT-IN: the tour reopens on every /admin visit
  // until the admin actively ticks "No volver a mostrar este tour"
  // before closing. That way a fresh admin who accidentally skips
  // or closes still gets the tour next time around.
  const [showTour, setShowTour] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setShowTour(window.localStorage.getItem(TOUR_SEEN_KEY) !== "1");
  }, []);
  const dismissTour = (dismissPermanently: boolean) => {
    setShowTour(false);
    if (dismissPermanently && typeof window !== "undefined") {
      window.localStorage.setItem(TOUR_SEEN_KEY, "1");
    }
  };

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
      {/* First-visit guided tour. Mounted at the page root so it
          can spotlight sidebar items (which live in the admin
          layout, not in this page). Hydration-guarded via
          `showTour === true` so SSR doesn't render the portal. */}
      {showTour === true && (
        <ProductTour steps={TOUR_STEPS} onClose={dismissTour} />
      )}
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
        <section
          className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          data-tour-id="setup-checklist"
        >
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
            title="Configura las reglas de asignación"
            description="Incompatibilidades del mismo día, sucesión entre actividades y límites por persona."
            ctaLabel="Ir a Reglas"
            href="/admin/rules"
            primary={state.activitiesDone && !state.rulesDone}
          />
          <StepCard
            done={state.teamDone}
            icon={<Users className="h-5 w-5" />}
            title="Revisa tu equipo"
            description="Estos son los miembros que añadiste durante el alta. Asigna a cada uno su categoría profesional y, cuando estés listo, pulsa Enviar invitación para que reciban el email de activación."
            ctaLabel="Ir al equipo"
            href="/admin/team"
            primary={
              state.activitiesDone
              && state.rulesDone
              && !state.teamDone
            }
          />
          {/* The "Configura tus sub-equipos" setup card was
              removed in Bucket 1 of the equipos redesign — each
              sub-equipo is now a peer Equipo with its own admin
              login. The has_subteams flag stays in the tenant
              schema for now (read by other code paths during
              transition); Phase E will retire the flag and the
              flow that sets it on signup. */}
        </section>
      )}

      {/* Pendientes — admin work queue. Only renders when at
          least one of the three categories has rows. Each card
          deeplinks to the page that actions it. The sidebar
          Inicio badge mirrors the total. */}
      {pendientes.data
        && pendientes.data.bloqueos_pending
          + pendientes.data.invitations_open
          + pendientes.data.swap_offers_open
          > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Pendientes
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pendientes.data.bloqueos_pending > 0 && (
              <PendientesCard
                icon={<CalendarOff className="h-5 w-5" />}
                count={pendientes.data.bloqueos_pending}
                label="Bloqueos por revisar"
                sublabel="Vacaciones, bajas, formación"
                href="/admin/availability"
                tone="amber"
              />
            )}
            {pendientes.data.invitations_open > 0 && (
              <PendientesCard
                icon={<MailWarning className="h-5 w-5" />}
                count={pendientes.data.invitations_open}
                label="Invitaciones sin activar"
                sublabel="Miembros que aún no han entrado"
                href="/admin/team"
                tone="violet"
              />
            )}
            {pendientes.data.swap_offers_open > 0 && (
              <PendientesCard
                icon={<ArrowLeftRight className="h-5 w-5" />}
                count={pendientes.data.swap_offers_open}
                label="Cambios abiertos"
                sublabel="Solicitudes de cobertura sin cerrar"
                href="/admin/swaps"
                tone="sky"
              />
            )}
          </div>
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

function PendientesCard({
  icon,
  count,
  label,
  sublabel,
  href,
  tone,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  sublabel: string;
  href: string;
  /** Colour family for the icon chip + count pill. Each
   * category uses a distinct tone so the eye can sort them at
   * a glance without reading. */
  tone: "amber" | "violet" | "sky";
}) {
  const toneClasses = {
    amber: {
      chip: "bg-amber-100 text-amber-700 group-hover:bg-amber-200",
      pill: "bg-amber-600",
    },
    violet: {
      chip: "bg-violet-100 text-violet-700 group-hover:bg-violet-200",
      pill: "bg-violet-600",
    },
    sky: {
      chip: "bg-sky-100 text-sky-700 group-hover:bg-sky-200",
      pill: "bg-sky-600",
    },
  }[tone];
  return (
    <Link href={href} className="block group">
      <Card>
        <div className="p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors rounded-xl">
          <span
            className={
              "inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0 transition-colors "
              + toneClasses.chip
            }
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span
                className={
                  "inline-flex min-w-[1.5rem] justify-center rounded-full px-2 py-0.5 text-xs font-semibold leading-tight text-white "
                  + toneClasses.pill
                }
              >
                {count}
              </span>
              <span className="truncate text-sm font-semibold text-gray-900">
                {label}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-gray-500 truncate">
              {sublabel}
            </div>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-gray-400 shrink-0 group-hover:text-gray-600" />
        </div>
      </Card>
    </Link>
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

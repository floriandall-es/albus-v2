"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  BarChart3,
  CalendarDays,
  CalendarOff,
  Clock,
  Heart,
  Home,
  LogOut,
  Menu,
  MessageSquare,
  PartyPopper,
  Settings,
  Share2,
  Sparkles,
  Tag,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import Image from "next/image";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";
import { EmailVerifyBanner } from "@/components/email-verify-banner";
import { BillingBanner } from "@/components/billing-banner";
import { ViewSwitcher } from "@/components/view-switcher";
import { InstallButton } from "@/components/pwa/install-button";

type NavSection = {
  title: string;
  items: { href: string; label: string; icon: LucideIcon }[];
};

/** Tour-anchor map for the /admin product tour. Every sidebar
 * destination the tour explains has an entry here; the value
 * lands as `data-tour-id="..."` on the matching <Link>. Module-
 * gated items (Trasplantes) are present in the map too — their
 * <Link> doesn't render when the tenant hasn't opted in, so the
 * tour drops those steps automatically via its "missing anchor =
 * skip" rule. */
const TOUR_ID_BY_HREF: Record<string, string | undefined> = {
  "/admin": "nav-inicio",
  "/admin/schedule": "nav-planificacion",
  "/admin/stats": "nav-estadisticas",
  "/admin/swaps": "nav-swaps",
  "/admin/availability": "nav-bloqueos",
  "/admin/reuniones": "nav-reuniones",
  "/admin/incidents": "nav-incidencias",
  "/admin/trasplantes": "nav-trasplantes",
  "/admin/team": "nav-equipo",
  "/admin/categories": "nav-categorias",
  "/admin/slots": "nav-actividades",
  "/admin/rules": "nav-reglas",
  "/admin/holidays": "nav-festivos",
  "/admin/settings": "nav-cuenta",
};

const NAV: NavSection[] = [
  {
    title: "Operativa",
    items: [
      { href: "/admin", label: "Inicio", icon: Home },
      { href: "/admin/schedule", label: "Planificación", icon: CalendarDays },
      { href: "/admin/stats", label: "Estadísticas", icon: BarChart3 },
      // Migration 0090: team wellbeing pulse. Opt-in per tenant
      // (default off); the page itself surfaces the toggle and a
      // dashboard of weekly trends + response rate.
      { href: "/admin/pulso", label: "Pulso", icon: Activity },
      { href: "/admin/swaps", label: "Cambios de turno", icon: ArrowLeftRight },
      { href: "/admin/availability", label: "Bloqueos", icon: CalendarOff },
      { href: "/admin/reuniones", label: "Reuniones", icon: MessageSquare },
      { href: "/admin/incidents", label: "Incidencias", icon: AlertCircle },
      { href: "/admin/trasplantes", label: "Trasplantes", icon: Heart },
      // Servicio (cross-equipo vista conjunta) and Directorio (cross-
      // tenant hospital directory) used to live here pointing at their
      // /me/* routes, but clicking them from the admin sidebar
      // surprise-jumped the user into the personal view. They're
      // pure-personal surfaces — admins still reach them via the
      // Admin/Personal toggle at the top of the sidebar. The admin
      // editing surface for the share policy stays under
      // Configuración → Compartir.
    ],
  },
  {
    title: "Configuración",
    items: [
      { href: "/admin/team", label: "Equipo", icon: Users },
      { href: "/admin/categories", label: "Categorías", icon: Tag },
      // The "Sub-equipos" entry (linking to /admin/groups) was
      // removed in Bucket 1 of the equipos redesign. Sub-equipos
      // are now peer equipos with their own admin/tenant; the
      // legacy /admin/groups route still exists (Phase E drops it)
      // but is no longer surfaced in navigation.
      { href: "/admin/slots", label: "Actividades", icon: Clock },
      { href: "/admin/rules", label: "Reglas", icon: Sparkles },
      { href: "/admin/holidays", label: "Festivos", icon: PartyPopper },
      // Periodos especiales (vacation/Christmas date ranges with their
      // own slot/rule config) live inline on Operativa → Planificación
      // now — there's a "Generar planificación de vacaciones" button
      // on that page that opens a periodos card. The dedicated
      // /admin/periodos route was deleted with V.2.5.
      // Phase C.2: admin-only — what THIS equipo exposes to its
      // siblings in the servicio. The read-only "Vista conjunta"
      // lives under Operativa → Servicio (shared with members);
      // the toggle lives here so non-admins can't flip it.
      // Gated below on tenant.servicio_id non-null.
      { href: "/admin/compartir", label: "Compartir", icon: Share2 },
    ],
  },
  {
    title: "Cuenta",
    items: [
      // Facturación lives INSIDE Mi cuenta now — see
      // /admin/settings/page.tsx for the deep-link card. Pulled
      // out of the sidebar because admins don't need it on every
      // page; surfacing it permanently was clutter for the value
      // it added.
      { href: "/admin/settings", label: "Mi cuenta", icon: Settings },
    ],
  },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const logout = useLogout();
  const pathname = usePathname();
  const [authChecked, setAuthChecked] = useState(false);
  // Mobile drawer state. Sidebar collapses to a hamburger on
  // small viewports because the 240px fixed column would otherwise
  // eat 60% of a phone screen. Auto-closes on route change so
  // tapping a nav link doesn't leave the drawer hanging open.
  // Same pattern as /me/layout.tsx — the admin layout was the
  // last surface still rendering sidebar-as-permanent on mobile,
  // making the whole /admin tree unusable on phone.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setAuthChecked(true);
  }, [router]);

  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    enabled: authChecked,
  });

  // Pendientes roll-up: bloqueos awaiting approval, invitations
  // not yet activated, open + pending-admin swap offers. Drives
  // the badge on the Inicio link (same shape as the DM unread
  // badge in the member layout). Polls every 60 s — flat-cost
  // SQL on the backend, a handful of .count() queries.
  const pendientes = useQuery({
    queryKey: ["admin-pendientes"],
    queryFn: api.getAdminPendientes,
    enabled: authChecked,
    refetchInterval: 60_000,
  });
  const pendientesTotal = pendientes.data
    ? pendientes.data.bloqueos_pending
      + pendientes.data.invitations_open
      + pendientes.data.swap_offers_open
      + pendientes.data.swap_offers_pending_admin
    : 0;

  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) => m.roles.includes("admin"));
    if (!isAdmin) router.replace("/me");
  }, [me.data, router]);

  if (!authChecked || me.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Cargando…</div>;
  }
  if (me.isError) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-600 mb-4">{(me.error as Error).message}</p>
        <button
          className="rounded-md border px-3 py-1 text-sm"
          onClick={logout}
        >
          Iniciar sesión de nuevo
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Mobile backdrop: dims the page when the drawer is open
          and dismisses on tap. Hidden on md+ where the sidebar
          is always visible. */}
      {drawerOpen && (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}
      <aside
        className={
          "fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col transform transition-transform duration-200 md:static md:translate-x-0 "
          + (drawerOpen ? "translate-x-0" : "-translate-x-full")
        }
      >
        <div className="px-4 py-4 border-b border-gray-100">
          {/* Top row: logo + tenant name. Tenant is line-clamped
              to 2 because that column is narrow (sidebar width
              minus the 56px logo + gap leaves ~150px). */}
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon.png"
              alt="Trivu"
              className="h-14 w-14 shrink-0 rounded-lg object-cover shadow-soft"
            />
            <div
              className="min-w-0 flex-1 text-sm font-medium text-gray-700 leading-tight line-clamp-2"
              title={me.data?.current_tenant.name}
            >
              {me.data?.current_tenant.name}
            </div>
            {/* Mobile-only close button. 44×44 touch target so
                soft-cased or sweaty fingers still hit it. */}
            <button
              type="button"
              aria-label="Cerrar menú"
              onClick={() => setDrawerOpen(false)}
              className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 active:bg-gray-200 md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {/* Hospital roll-up label on its own row below — gets
              the full sidebar width so a long official name like
              "Hospital Universitari i Politècnic La Fe de
              València" can wrap onto however many lines it
              needs. Renders only when the tenant has a parent
              (migration 0051); hidden for standalone tenants. */}
          {me.data?.current_tenant.hospital_name && (
            <div
              className="mt-2 text-[11px] text-gray-500 leading-snug"
              title={me.data.current_tenant.hospital_name}
            >
              {me.data.current_tenant.hospital_name}
            </div>
          )}
        </div>

        <InstallButton />
        {me.data && <ViewSwitcher me={me.data} current="admin" />}

        <nav
          className="flex-1 overflow-y-auto px-3 py-4 space-y-5"
          data-tour-id="sidebar"
        >
          {NAV.map((section) => (
            <div key={section.title}>
              <div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {section.title}
              </div>
              <div className="space-y-0.5">
                {section.items
                  .filter((item) => {
                    // Module-gated entries: trasplantes only shows
                    // when the tenant opted into the module at
                    // signup. Most tenants never see it.
                    if (
                      item.href === "/admin/trasplantes"
                      && !me.data?.current_tenant.transplants_enabled
                    ) {
                      return false;
                    }
                    // (Directorio/Servicio used to be gated here when
                    // their links lived in the admin sidebar; they
                    // moved to personal-only after the cross-view
                    // jump confused admins.)
                    // Same servicio gate for the share-policy
                    // setting — pointless when this equipo has no
                    // siblings to share with.
                    if (
                      item.href === "/admin/compartir"
                      && me.data?.current_tenant.servicio_id == null
                    ) {
                      return false;
                    }
                    return true;
                  })
                  .map((item) => {
                  const Icon = item.icon;
                  // /admin (Inicio) is a prefix of every other admin
                  // route, so use an exact match for it specifically —
                  // otherwise the dashboard link would light up on
                  // every page.
                  const active =
                    item.href === "/admin"
                      ? pathname === "/admin"
                      : pathname?.startsWith(item.href);
                  // Tour anchors — populated only for the nav items
                  // the first-visit product tour cares about. Keeps
                  // the attribute set tight so the DOM stays clean.
                  const tourId = TOUR_ID_BY_HREF[item.href];
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      data-tour-id={tourId}
                      className={
                        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors "
                        + (active
                          ? "bg-brand-50 text-brand-700"
                          : "text-gray-700 hover:bg-gray-100")
                      }
                    >
                      <Icon
                        className={
                          "h-4 w-4 shrink-0 "
                          + (active
                            ? "text-brand-600"
                            : "text-gray-400 group-hover:text-gray-600")
                        }
                      />
                      <span className="truncate">{item.label}</span>
                      {/* Pendientes roll-up badge on the Inicio
                          link. Mirrors the DM unread badge on
                          the member layout — single number,
                          capped at 99+, hidden when zero. */}
                      {item.href === "/admin" && pendientesTotal > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                          {pendientesTotal >= 99
                            ? "99+"
                            : pendientesTotal}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

        </nav>

        <div className="border-t border-gray-100 px-3 py-3">
          <div className="px-1 pb-2 text-[11px] text-gray-500 truncate">
            {me.data?.person.email}
          </div>
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
            onClick={logout}
          >
            <LogOut className="h-4 w-4 text-gray-400" />
            Cerrar sesión
          </button>
        </div>
      </aside>
      {/* `min-w-0` is load-bearing: flex items default to
          min-width:auto, which lets their content (here: a
          Recharts ResponsiveContainer that measures its parent
          to decide its own width) push the flex track wider
          than the viewport. The chart bars then overflow the
          card and bleed past the right edge of the page. With
          min-w-0 the column is correctly bounded to the
          remaining flex space and the chart sizes itself to
          fit. Same fix below in /lead and /me layouts.
          See https://defensivecss.dev/tip/flexbox-min-content-size/ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar: hamburger + logo + tenant name + a
            compact Pendientes badge so the admin sees there's
            something needing attention without having to open
            the drawer. Hidden on md+ where the sidebar shows
            everything. */}
        <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 md:hidden">
          <button
            type="button"
            aria-label="Abrir menú"
            onClick={() => setDrawerOpen(true)}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 active:bg-gray-200"
          >
            <Menu className="h-5 w-5" />
            {pendientesTotal > 0 && (
              <span
                aria-hidden
                className="absolute mt-[-18px] ml-[18px] h-2 w-2 rounded-full bg-brand-600 ring-2 ring-white"
              />
            )}
          </button>
          <Image
            src="/logo-icon.png"
            alt="Trivu"
            width={28}
            height={28}
            className="rounded-md object-cover"
          />
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
            {me.data?.current_tenant.name}
          </div>
        </div>
        <EmailVerifyBanner />
        <BillingBanner />
        {/* Tighter horizontal padding on mobile (where 8px·2 =
            16px is plenty) and the existing p-8 on md+. Without
            this every page was inheriting the laptop-sized p-8,
            which left ~280px of content room on a 393px phone
            even after the sidebar fix. */}
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

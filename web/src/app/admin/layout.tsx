"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeftRight,
  BarChart3,
  CalendarDays,
  CalendarOff,
  Clock,
  Heart,
  Home,
  Layers,
  LogOut,
  MessageSquare,
  PartyPopper,
  Settings,
  Sparkles,
  Tag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";
import { EmailVerifyBanner } from "@/components/email-verify-banner";
import { ViewSwitcher } from "@/components/view-switcher";

type NavSection = {
  title: string;
  items: { href: string; label: string; icon: LucideIcon }[];
};

const NAV: NavSection[] = [
  {
    title: "Operativa",
    items: [
      { href: "/admin", label: "Inicio", icon: Home },
      { href: "/admin/schedule", label: "Planificación", icon: CalendarDays },
      { href: "/admin/stats", label: "Estadísticas", icon: BarChart3 },
      { href: "/admin/swaps", label: "Cambios de turno", icon: ArrowLeftRight },
      { href: "/admin/availability", label: "Bloqueos", icon: CalendarOff },
      { href: "/admin/reuniones", label: "Reuniones", icon: MessageSquare },
      { href: "/admin/incidents", label: "Incidentes", icon: AlertCircle },
      { href: "/admin/trasplantes", label: "Trasplantes", icon: Heart },
    ],
  },
  {
    title: "Configuración",
    items: [
      { href: "/admin/team", label: "Equipo", icon: Users },
      { href: "/admin/categories", label: "Categorías", icon: Tag },
      { href: "/admin/groups", label: "Sub-equipos", icon: Layers },
      { href: "/admin/slots", label: "Actividades", icon: Clock },
      { href: "/admin/rules", label: "Reglas", icon: Sparkles },
      { href: "/admin/holidays", label: "Festivos", icon: PartyPopper },
    ],
  },
  {
    title: "Cuenta",
    items: [
      { href: "/admin/settings", label: "Mi cuenta", icon: Settings },
    ],
  },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const logout = useLogout();
  const pathname = usePathname();
  const [authChecked, setAuthChecked] = useState(false);

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

  // Sub-team groups for the dynamic sidebar entries (one
  // per group). Only the tenant admin sees these — group leads
  // never land in this layout.
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: api.listGroups,
    enabled: authChecked,
  });

  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) => m.roles.includes("admin"));
    const isGroupLead = me.data.lead_group_id !== null;
    // Only tenant admins get the full admin UI. Group leads have
    // a dedicated UI at /lead purpose-built for "manage your
    // group's actividades + planning" — they don't need (and
    // shouldn't see) tenant-level pages here.
    if (!isAdmin) router.replace(isGroupLead ? "/lead" : "/me");
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
      <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-gray-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.jpeg"
            alt="Trivu"
            className="h-14 w-14 rounded-lg object-cover shadow-soft"
          />
          <div className="min-w-0 leading-tight">
            {/* Tenant + hospital labels can be long (the alpha
                customer's official hospital name is 50+ chars).
                Allow up to 2 lines via line-clamp; hover shows
                the full string. */}
            <div
              className="text-sm font-medium text-gray-700 line-clamp-2"
              title={me.data?.current_tenant.name}
            >
              {me.data?.current_tenant.name}
            </div>
            {/* Hospital roll-up label. Renders only when the
                tenant has a parent (migration 0051). Hidden for
                standalone tenants so the sidebar stays clean. */}
            {me.data?.current_tenant.hospital_name && (
              <div
                className="mt-0.5 text-[11px] text-gray-500 line-clamp-2"
                title={me.data.current_tenant.hospital_name}
              >
                {me.data.current_tenant.hospital_name}
              </div>
            )}
          </div>
        </div>

        {me.data && <ViewSwitcher me={me.data} current="admin" />}

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
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
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
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
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Dynamic sub-team plans: one entry per group so the
              tenant admin can read each group's planning without
              it mixing into the main schedule view. Read-only —
              actual editing happens in /lead/* by the group's
              lead. */}
          {groups.data && groups.data.length > 0 && (
            <div>
              <div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Sub-equipos
              </div>
              <div className="space-y-0.5">
                {groups.data.map((g) => {
                  const href = `/admin/groups/${g.id}/planificacion`;
                  const active = pathname === href;
                  return (
                    <Link
                      key={g.id}
                      href={href}
                      className={
                        "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors "
                        + (active
                          ? "bg-brand-50 text-brand-700"
                          : "text-gray-700 hover:bg-gray-100")
                      }
                    >
                      <Layers
                        className={
                          "h-4 w-4 shrink-0 "
                          + (active
                            ? "text-brand-600"
                            : "text-gray-400 group-hover:text-gray-600")
                        }
                      />
                      <span className="truncate">{g.name}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
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
        <EmailVerifyBanner />
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}

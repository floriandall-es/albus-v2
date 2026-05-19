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
  Home,
  Layers,
  LogOut,
  PartyPopper,
  Settings,
  Sparkles,
  Tag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** True = visible to group leads too. Default (omitted) = tenant
   * admin only. Group leads see a curated subset of the admin UI —
   * everything tenant-wide (Categorías, Reglas, Festivos, etc.) is
   * hidden from them because they have no business editing it. */
  leadAccess?: boolean;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

const NAV: NavSection[] = [
  {
    title: "Operativa",
    items: [
      { href: "/admin", label: "Inicio", icon: Home, leadAccess: true },
      { href: "/admin/schedule", label: "Planificación", icon: CalendarDays, leadAccess: true },
      { href: "/admin/stats", label: "Estadísticas", icon: BarChart3 },
      { href: "/admin/swaps", label: "Cambios de turno", icon: ArrowLeftRight },
      { href: "/admin/availability", label: "Bloqueos", icon: CalendarOff },
      { href: "/admin/incidents", label: "Incidentes", icon: AlertCircle },
    ],
  },
  {
    title: "Configuración",
    items: [
      { href: "/admin/team", label: "Equipo", icon: Users, leadAccess: true },
      { href: "/admin/categories", label: "Categorías", icon: Tag },
      { href: "/admin/groups", label: "Sub-equipos", icon: Layers },
      { href: "/admin/slots", label: "Actividades", icon: Clock, leadAccess: true },
      { href: "/admin/rules", label: "Reglas", icon: Sparkles },
      { href: "/admin/holidays", label: "Festivos", icon: PartyPopper },
    ],
  },
  {
    title: "Cuenta",
    items: [
      { href: "/admin/settings", label: "Mi cuenta", icon: Settings, leadAccess: true },
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

  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) => m.roles.includes("admin"));
    const isGroupLead = me.data.lead_group_id !== null;
    // Tenant admins AND group leads both get the (scoped) admin UI.
    // Plain members are bounced back to /me.
    if (!isAdmin && !isGroupLead) router.replace("/me");
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
          <div className="text-sm font-medium text-gray-700 leading-tight">
            {me.data?.current_tenant.name}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {NAV.map((section) => {
            // Filter items down for group leads. Tenant admins see
            // everything; leads see only items tagged leadAccess.
            const isTenantAdmin = me.data?.memberships.some((m) =>
              m.roles.includes("admin"),
            );
            const items = isTenantAdmin
              ? section.items
              : section.items.filter((i) => i.leadAccess);
            if (items.length === 0) return null;
            return (
            <div key={section.title}>
              <div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {section.title}
              </div>
              <div className="space-y-0.5">
                {items.map((item) => {
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
            );
          })}
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
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}

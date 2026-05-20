"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  Clock,
  Home,
  LogOut,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";
import { EmailVerifyBanner } from "@/components/email-verify-banner";

/**
 * Dedicated shell for sub-team leads (the "residente mayor" and
 * equivalents). Purpose-built for "manage this group's actividades
 * + plan this group's people" — NOT a filtered version of /admin.
 *
 * Auth gate: requires the caller to be lead_group_id !== null on
 * the /me response. Tenant admins are bounced to /admin (they have
 * their own bigger UI); plain members go to /me.
 *
 * Sidebar deliberately tiny — three operational items + Mi cuenta.
 * No tenant-level concepts (no schedules-as-publishable-objects,
 * no rules, no holidays, no stats). Manual planning only.
 */
const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/lead", label: "Inicio", icon: Home },
  { href: "/lead/actividades", label: "Actividades", icon: Clock },
  { href: "/lead/planificacion", label: "Planificación", icon: CalendarDays },
  { href: "/lead/settings", label: "Mi cuenta", icon: Settings },
];

export default function LeadLayout({ children }: { children: ReactNode }) {
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

  // Route guard: only group leads get here. Tenant admins (who
  // could happen to also be a lead) go to /admin because that's
  // their main UI. Plain members go to /me.
  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) => m.roles.includes("admin"));
    if (isAdmin) {
      router.replace("/admin");
      return;
    }
    if (me.data.lead_group_id === null) {
      router.replace("/me");
    }
  }, [me.data, router]);

  // Look up the lead's group name for the sidebar header. We don't
  // store it on /me to keep that response slim — one extra request
  // here is fine and gets cached by react-query.
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: api.listGroups,
    enabled: !!me.data?.lead_group_id,
  });
  const myGroup = groups.data?.find(
    (g) => g.id === me.data?.lead_group_id,
  );

  if (!authChecked || me.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Cargando…</div>;
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
          <div className="leading-tight">
            <div className="text-sm font-medium text-gray-700">
              {me.data?.current_tenant.name}
            </div>
            {myGroup && (
              <div className="text-xs text-gray-500 mt-0.5">
                Sub-equipo:{" "}
                <span className="font-medium text-gray-700">
                  {myGroup.name}
                </span>
              </div>
            )}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            // /lead (Inicio) is a prefix of every other lead route,
            // so use exact match for it specifically.
            const active =
              item.href === "/lead"
                ? pathname === "/lead"
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
      <div className="flex-1 flex flex-col">
        <EmailVerifyBanner />
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}

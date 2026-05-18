"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  CalendarDays,
  CalendarOff,
  Home,
  LogOut,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/me", label: "Inicio", icon: Home },
  { href: "/me/turnos", label: "Mis turnos", icon: CalendarDays },
  { href: "/me/swaps", label: "Cambios", icon: ArrowLeftRight },
  { href: "/me/bloqueos", label: "Mis bloqueos", icon: CalendarOff },
  { href: "/me/settings", label: "Mi cuenta", icon: Settings },
];

export default function MeLayout({ children }: { children: ReactNode }) {
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

  // Un-onboarded admins still go through the wizard.
  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) =>
      m.roles.includes("admin"),
    );
    if (isAdmin && me.data.current_tenant.onboarding_completed_at === null) {
      router.replace("/onboarding");
    }
  }, [me.data, router]);

  if (!authChecked || me.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Cargando…</div>;
  }
  if (me.isError) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-600 mb-4">
          {(me.error as Error).message}
        </p>
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

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            // /me (Inicio) is a prefix of every other member route,
            // so use an exact match for it specifically — otherwise
            // the dashboard link would light up on every page.
            const active =
              item.href === "/me"
                ? pathname === "/me"
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
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}

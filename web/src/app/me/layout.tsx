"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  BarChart3,
  Building2,
  CalendarDays,
  CalendarOff,
  CreditCard,
  Home,
  LogOut,
  Menu,
  MessageCircle,
  MessageSquare,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, getToken, personFullName } from "@/lib/api";
import { Avatar } from "@/components/schedule/planning-grid";
import { useLogout } from "@/lib/use-logout";
import { EmailVerifyBanner } from "@/components/email-verify-banner";
import { BillingBanner } from "@/components/billing-banner";
import { ViewSwitcher } from "@/components/view-switcher";
import { InstallButton } from "@/components/pwa/install-button";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/me", label: "Inicio", icon: Home },
  { href: "/me/turnos", label: "Mis turnos", icon: CalendarDays },
  { href: "/me/reuniones", label: "Reuniones", icon: MessageSquare },
  { href: "/me/swaps", label: "Cambios", icon: ArrowLeftRight },
  { href: "/me/bloqueos", label: "Mis bloqueos", icon: CalendarOff },
  { href: "/me/estadisticas", label: "Mis estadísticas", icon: BarChart3 },
  // Phase C.2: cross-equipo Servicio view used to live here as a
  // dedicated nav entry. It got folded into /me/turnos as the third
  // "Servicio" scope option — the standalone page was redundant
  // (the Servicio view always wanted the user's team grid at the
  // top anyway). The route still exists as a redirect for old deep
  // links from /admin/compartir + /admin/equipos-pendientes.
  // Sprint 28: cross-tenant hospital directory. Only renders when
  // the current tenant has a parent hospital — handled in the
  // filter below.
  { href: "/me/directorio", label: "Directorio", icon: Building2 },
  // Sprint 28 / Phase 2A: 1:1 DMs. Same hospital gate as the
  // directory — DMs only work between members of the same hospital.
  { href: "/me/mensajes", label: "Mensajes", icon: MessageCircle },
  { href: "/me/settings", label: "Mi cuenta", icon: Settings },
  // Migration 0080 / docs/billing-plan.md. Personal billing page —
  // active under members_pay (the member subscribes themselves);
  // shows a "your team pays" notice under team_pays. Always visible
  // in the nav so the member can find it either way.
  { href: "/me/billing", label: "Facturación", icon: CreditCard },
];

export default function MeLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const logout = useLogout();
  const pathname = usePathname();
  const [authChecked, setAuthChecked] = useState(false);
  // Mobile drawer state. Sidebar collapses to a hamburger on
  // small viewports because the 240px fixed column eats 60%
  // of a phone screen. Auto-closes on route change so tapping
  // a nav link doesn't leave the drawer hanging open.
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

  // Phase 2B: total unread DM count. Polls every 60s so the
  // sidebar badge stays roughly fresh without becoming a
  // perceived network expense. Skipped when the current tenant
  // has no hospital (DMs are hospital-gated).
  const unread = useQuery({
    queryKey: ["my-unread-count"],
    queryFn: api.getMyUnreadCount,
    enabled:
      authChecked && (me.data?.current_tenant.hospital_id ?? null) !== null,
    refetchInterval: 60_000,
  });

  // Un-onboarded admins still go through the wizard. We do NOT
  // auto-bounce leads to /lead anymore — leads who also have a
  // clinical membership (the chief resident, e.g.) need to be
  // able to land on /me via the ViewSwitcher without immediately
  // being kicked back. Login-time landing (in app/login/_utils.ts)
  // still sends leads to /lead by default; this guard is only
  // about post-login navigation.
  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) =>
      m.roles.includes("admin"),
    );
    if (isAdmin && me.data.current_tenant.onboarding_completed_at === null) {
      router.replace("/onboarding");
      return;
    }
  }, [me.data, router, pathname]);

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
          {/* Same shape as the admin header (sidebar parity): logo
              + tenant name in the top row, hospital name as a
              full-width muted subtitle underneath so a long
              official name like "Hospital Universitari i
              Politècnic La Fe de València" can wrap freely. */}
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.jpeg"
              alt="Trivu"
              className="h-14 w-14 shrink-0 rounded-lg object-cover shadow-soft"
            />
            <div
              className="min-w-0 flex-1 text-sm font-medium text-gray-700 leading-tight line-clamp-2"
              title={me.data?.current_tenant.name}
            >
              {me.data?.current_tenant.name}
            </div>
            {/* Mobile-only close button. 44×44 touch target. */}
            <button
              type="button"
              aria-label="Cerrar menú"
              onClick={() => setDrawerOpen(false)}
              className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 active:bg-gray-200 md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {me.data?.current_tenant.hospital_name && (
            <div
              className="mt-2 text-[11px] text-gray-500 leading-snug"
              title={me.data.current_tenant.hospital_name}
            >
              {me.data.current_tenant.hospital_name}
            </div>
          )}
        </div>

        {/* "You are signed in as X" card. Lives below the
            tenant/hospital header but above the InstallButton
            + ViewSwitcher block. Card chrome (light bg + ring)
            sets it apart so the user identity reads as a
            self-contained element rather than another header
            row. Doubles as a quick anchor to the profile page. */}
        {me.data && (
          <Link
            href="/me/settings"
            className="mx-3 mt-3 flex items-center gap-2.5 rounded-lg bg-gray-50 px-3 py-2.5 ring-1 ring-inset ring-gray-200 hover:bg-gray-100 transition-colors"
          >
            <Avatar
              name={me.data.person.name}
              mine={true}
              imageUrl={me.data.person.avatar_url}
              size="md"
            />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-medium text-gray-900">
                {personFullName(me.data.person)}
              </div>
              <div className="truncate text-[11px] text-gray-500">
                {me.data.person.email}
              </div>
            </div>
          </Link>
        )}

        <InstallButton />
        {me.data && <ViewSwitcher me={me.data} current="me" />}

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
          <div className="space-y-0.5">
            {NAV.filter((item) => {
              // Directory entry only when this tenant has a
              // parent hospital. Standalone tenants get nothing
              // to click — the page would render an empty state
              // anyway, so hide the entry point too.
              if (
                item.href === "/me/directorio"
                && me.data?.current_tenant.hospital_id == null
              ) {
                return false;
              }
              // DMs are hospital-gated the same way.
              if (
                item.href === "/me/mensajes"
                && me.data?.current_tenant.hospital_id == null
              ) {
                return false;
              }
              return true;
            }).map((item) => {
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
                  {/* Phase 2B: unread DM badge next to "Mensajes".
                      Hidden at 0; shows 99+ at the cap. */}
                  {item.href === "/me/mensajes"
                    && unread.data
                    && unread.data.total > 0 && (
                      <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                        {unread.data.total >= 99
                          ? "99+"
                          : unread.data.total}
                      </span>
                    )}
                </Link>
              );
            })}
          </div>

          {/* The dynamic sub-equipos section was removed in Bucket 1
              of the equipos redesign. Each sub-equipo is now a peer
              Equipo (its own tenant) — a member only belongs to one
              tenant at a time, so there's nothing useful to list
              here. Cross-equipo visibility returns as the Servicio
              timeline page in Phase C.2. */}
        </nav>

        <div className="border-t border-gray-100 px-3 py-3">
          {/* Email used to live here as the "signed in as"
              anchor. Moved into the identity card up top so the
              user's face and name lead the chrome; the email is
              still visible there, just not duplicated. */}
          <button
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
            onClick={logout}
          >
            <LogOut className="h-4 w-4 text-gray-400" />
            Cerrar sesión
          </button>
        </div>
      </aside>
      {/* min-w-0 stops wide content (planning grid, recharts
          ResponsiveContainer) from pushing this column past
          the viewport edge — see /admin/layout for the long
          explanation. */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar: hamburger + tenant name. Hidden on
            md+ where the sidebar is visible. */}
        <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 md:hidden">
          <button
            type="button"
            aria-label="Abrir menú"
            onClick={() => setDrawerOpen(true)}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-md text-gray-700 hover:bg-gray-100 active:bg-gray-200"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Image
            src="/logo.jpeg"
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
            16px is plenty) and the existing p-8 on md+. Also
            p-4 vertical on mobile so the page header doesn't
            sit flush to the topbar. */}
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

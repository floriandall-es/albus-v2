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
  Home,
  Layers,
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
import { ViewSwitcher } from "@/components/view-switcher";
import { InstallButton } from "@/components/pwa/install-button";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/me", label: "Inicio", icon: Home },
  { href: "/me/turnos", label: "Mis turnos", icon: CalendarDays },
  { href: "/me/reuniones", label: "Reuniones", icon: MessageSquare },
  { href: "/me/swaps", label: "Cambios", icon: ArrowLeftRight },
  { href: "/me/bloqueos", label: "Mis bloqueos", icon: CalendarOff },
  { href: "/me/estadisticas", label: "Mis estadísticas", icon: BarChart3 },
  // Sprint 28: cross-tenant hospital directory. Only renders when
  // the current tenant has a parent hospital — handled in the
  // filter below.
  { href: "/me/directorio", label: "Directorio", icon: Building2 },
  // Sprint 28 / Phase 2A: 1:1 DMs. Same hospital gate as the
  // directory — DMs only work between members of the same hospital.
  { href: "/me/mensajes", label: "Mensajes", icon: MessageCircle },
  { href: "/me/settings", label: "Mi cuenta", icon: Settings },
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

  // Sub-team groups for the dynamic sidebar section. Every member
  // can browse them: the per-group page surfaces published plans
  // only (drafts stay between the lead and tenant admin).
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: api.listGroups,
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
        <div className="px-4 py-4 border-b border-gray-100 space-y-3">
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.jpeg"
              alt="Trivu"
              className="h-12 w-12 rounded-lg object-cover shadow-soft shrink-0"
            />
            <div className="min-w-0 flex-1 leading-tight">
              {/* Hospital name on top, tenant (service) name below.
                  For standalone tenants (no parent hospital) we just
                  show the tenant name with no hospital label — keeps
                  the header from rendering an awkward empty line. */}
              {me.data?.current_tenant.hospital_name && (
                <div className="truncate text-[11px] uppercase tracking-wide text-gray-500">
                  {me.data.current_tenant.hospital_name}
                </div>
              )}
              <div className="truncate text-sm font-semibold text-gray-800">
                {me.data?.current_tenant.name}
              </div>
            </div>
            {/* Mobile-only close button — gives a fast dismiss
                without reaching for the backdrop. 44×44 touch target
                so it's reliably tappable. */}
            <button
              type="button"
              aria-label="Cerrar menú"
              onClick={() => setDrawerOpen(false)}
              className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 active:bg-gray-200 md:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {/* Logged-in user identity. Photo (or initials chip) +
              first+last name. Reads as the "you are signed in as
              X" anchor that nurses and adjuntos asked for —
              previously the header only said which hospital they
              were in, not who they were. */}
          {me.data && (
            <div className="flex items-center gap-2.5">
              <Avatar
                name={me.data.person.name}
                mine={true}
                imageUrl={me.data.person.avatar_url}
                size="md"
              />
              <div className="min-w-0 text-xs leading-tight text-gray-700">
                <div className="truncate font-medium">
                  {personFullName(me.data.person)}
                </div>
              </div>
            </div>
          )}
        </div>

        <InstallButton />
        {me.data && <ViewSwitcher me={me.data} current="me" />}

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
          <div className="space-y-0.5">
            {NAV.filter((item) => {
              // Sub-equipo members can't request coverage or
              // bloqueos through the system yet — their lead
              // manages absences and swaps internally. Hide the
              // entry points so they don't even see the option.
              const currentMembership = me.data?.memberships.find(
                (m) => m.tenant_id === me.data?.current_tenant.id,
              );
              const inSubEquipo =
                currentMembership?.group_id != null;
              if (inSubEquipo && item.href === "/me/swaps") return false;
              if (inSubEquipo && item.href === "/me/bloqueos") return false;
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

          {/* Dynamic sub-team plans — same shape as the admin
              sidebar's Sub-equipos section. Members see only
              published group plans (the per-group page handles
              "not yet published" empty states).
              We hide the user's OWN group, because /me/turnos
              already shows that planning for them — the sidebar
              entry would just be a duplicate route to the same
              data. Other groups stay visible so cross-cohort
              snooping (adjunto checking who's on guardia) works. */}
          {(() => {
            const currentMembership = me.data?.memberships.find(
              (m) => m.tenant_id === me.data?.current_tenant.id,
            );
            const myGroupId = currentMembership?.group_id ?? null;
            const visibleGroups = (groups.data ?? []).filter(
              (g) => g.id !== myGroupId,
            );
            if (visibleGroups.length === 0) return null;
            return (
            <div>
              <div className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Sub-equipos
              </div>
              <div className="space-y-0.5">
                {visibleGroups.map((g) => {
                  const href = `/me/sub-equipos/${g.id}`;
                  const active = pathname?.startsWith(href);
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
            );
          })()}
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
        {/* Tighter horizontal padding on mobile (where 8px·2 =
            16px is plenty) and the existing p-8 on md+. Also
            p-4 vertical on mobile so the page header doesn't
            sit flush to the topbar. */}
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";

/**
 * Founder-only dashboard wrapper. Gated client-side on
 * `person.is_founder` (migration 0079). The backend's
 * /api/founder/tenants route enforces the same check server-side
 * with a 403 — this is just the UX redirect so non-founders that
 * type the URL bounce back to /admin instead of seeing a flash of
 * the empty table.
 *
 * Intentionally NOT wired into the admin sidebar or the view
 * switcher; Florian reaches /founder by typing it directly.
 */
export default function FounderLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const logout = useLogout();
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
    if (!me.data.person.is_founder) {
      // Non-founder landed here by typing the URL. Bounce them to
      // their normal home — admin if they have it, /me otherwise.
      const isAdmin = me.data.memberships.some((m) =>
        m.roles.includes("admin"),
      );
      router.replace(isAdmin ? "/admin" : "/me");
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
  // Render nothing while the redirect is in flight; otherwise the
  // founder data flashes for one frame before the router unmounts
  // us.
  if (!me.data?.person.is_founder) {
    return <div className="p-8 text-sm text-gray-500">Redirigiendo…</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.jpeg"
              alt="Trivu"
              className="h-9 w-9 rounded-md object-cover shadow-soft"
            />
            <div>
              <div className="text-sm font-semibold text-gray-900">
                Trivu · Founder dashboard
              </div>
              <div className="text-[11px] text-gray-500">
                {me.data.person.email}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin"
              className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Volver a /admin
            </Link>
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <LogOut className="h-3.5 w-3.5 text-gray-400" />
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}

"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, clearToken, getToken } from "@/lib/api";

const NAV: { href: string; label: string }[] = [
  { href: "/admin/team", label: "Equipo" },
  { href: "/admin/categories", label: "Categorías" },
  { href: "/admin/pools", label: "Unidades" },
  { href: "/admin/skills", label: "Competencias" },
  { href: "/admin/slots", label: "Turnos" },
  { href: "/admin/rules", label: "Reglas" },
  { href: "/admin/holidays", label: "Festivos" },
  { href: "/admin/availability", label: "Bloqueos" },
  { href: "/admin/schedule", label: "Planificación" },
  { href: "/admin/settings", label: "Mi cuenta" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
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
          onClick={() => {
            clearToken();
            router.replace("/login");
          }}
        >
          Iniciar sesión de nuevo
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r bg-white">
        <div className="p-4 border-b">
          <div className="text-sm font-semibold">{me.data?.current_tenant.name}</div>
          <div className="text-xs text-gray-500">{me.data?.person.email}</div>
        </div>
        <nav className="p-2 space-y-1">
          {NAV.map((item) => {
            const active = pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "block rounded-md px-3 py-2 text-sm " +
                  (active
                    ? "bg-gray-900 text-white"
                    : "text-gray-700 hover:bg-gray-100")
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t mt-4">
          <button
            className="w-full text-left text-sm text-gray-600 hover:bg-gray-100 rounded-md px-3 py-2"
            onClick={() => {
              clearToken();
              router.replace("/login");
            }}
          >
            Cerrar sesión
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}

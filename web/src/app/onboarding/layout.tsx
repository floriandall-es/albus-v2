"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, clearToken, getToken } from "@/lib/api";

export const STEPS = [
  { slug: "categories", label: "Categorías" },
  { slug: "skills", label: "Skills" },
  { slug: "pools", label: "Pools" },
  { slug: "slots", label: "Slots" },
  { slug: "team", label: "Equipo" },
  { slug: "done", label: "Resumen" },
] as const;

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
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
    enabled: authChecked,
    retry: false,
  });

  // Non-admins can't run the wizard.
  useEffect(() => {
    if (!me.data) return;
    const isAdmin = me.data.memberships.some((m) => m.roles.includes("admin"));
    if (!isAdmin) router.replace("/me");
  }, [me.data, router]);

  const skip = useMutation({
    mutationFn: () => api.completeOnboarding(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/me");
    },
  });

  if (!authChecked || me.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Cargando…</div>;
  }

  const currentSlug = pathname?.split("/").pop() ?? "";
  const currentIdx = STEPS.findIndex((s) => s.slug === currentSlug);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-500">{me.data?.current_tenant.name}</div>
            <h1 className="text-lg font-semibold">Configuración inicial</h1>
          </div>
          <button
            onClick={() => skip.mutate()}
            className="text-sm text-gray-500 hover:text-gray-800 underline"
          >
            Saltar y configurar más tarde
          </button>
        </div>
        <div className="mx-auto max-w-3xl px-6 pb-4">
          <Stepper currentIdx={currentIdx} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-6">{children}</main>
      <footer className="mx-auto max-w-3xl px-6 pb-8 text-xs text-gray-400">
        <button
          onClick={() => {
            clearToken();
            router.replace("/login");
          }}
          className="underline"
        >
          Cerrar sesión
        </button>
      </footer>
    </div>
  );
}

function Stepper({ currentIdx }: { currentIdx: number }) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {STEPS.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <li key={s.slug} className="flex items-center gap-2">
            <Link
              href={`/onboarding/${s.slug}`}
              className={
                "flex items-center gap-1.5 rounded-full px-3 py-1 " +
                (active
                  ? "bg-gray-900 text-white"
                  : done
                  ? "bg-gray-200 text-gray-700"
                  : "border border-gray-300 text-gray-500 hover:bg-gray-100")
              }
            >
              <span
                className={
                  "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] " +
                  (active
                    ? "bg-white text-gray-900"
                    : done
                    ? "bg-gray-700 text-white"
                    : "border border-gray-300")
                }
              >
                {i + 1}
              </span>
              {s.label}
            </Link>
            {i < STEPS.length - 1 && <span className="text-gray-300">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

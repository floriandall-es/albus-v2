"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { useLogout } from "@/lib/use-logout";
import { STEPS } from "./_steps";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
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
    <div className="min-h-screen bg-gradient-to-b from-brand-50/40 to-gray-50">
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-3xl px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <Image
              src="/logo.png"
              alt="Trivu"
              width={120}
              height={48}
              priority
              className="h-12 w-auto shrink-0"
            />
            <div className="min-w-0">
              {/* Page title on top, org-context line below. The
                  inverse felt heavy: the small uppercase line
                  competed visually with the h1 sitting under it.
                  Now the page identity reads first and the
                  context anchors it. Show "Servicio · Equipo"
                  when both are known, fall back to equipo-only
                  for legacy tenants without a servicio link. */}
              <h1 className="text-xl font-semibold text-gray-900 leading-tight">
                Configuración inicial
              </h1>
              <div className="mt-0.5 text-xs uppercase tracking-wider text-brand-700 font-semibold">
                {me.data?.current_tenant.servicio_name
                  ? `${me.data.current_tenant.servicio_name} · ${me.data.current_tenant.name}`
                  : me.data?.current_tenant.name}
              </div>
            </div>
          </div>
          <button
            onClick={() => skip.mutate()}
            className="shrink-0 text-sm text-gray-500 hover:text-gray-800 underline"
          >
            Saltar y configurar más tarde
          </button>
        </div>
        <div className="mx-auto max-w-3xl px-6 pb-5">
          <Stepper currentIdx={currentIdx} />
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-6">{children}</main>
      <footer className="mx-auto max-w-3xl px-6 pb-8 text-xs text-gray-400">
        <button onClick={logout} className="underline">
          Cerrar sesión
        </button>
      </footer>
    </div>
  );
}

function Stepper({ currentIdx }: { currentIdx: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-y-1.5 gap-x-1.5 text-xs">
      {STEPS.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <li key={s.slug} className="flex items-center gap-1.5">
            <Link
              href={`/onboarding/${s.slug}`}
              aria-current={active ? "step" : undefined}
              className={
                "flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition-colors "
                + (active
                  ? "bg-brand-600 text-white shadow-soft"
                  : done
                    ? "bg-brand-50 text-brand-800 ring-1 ring-brand-200 hover:bg-brand-100"
                    : "ring-1 ring-gray-300 text-gray-500 hover:bg-gray-100")
              }
            >
              <span
                className={
                  "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] "
                  + (active
                    ? "bg-white/20 text-white"
                    : done
                      ? "bg-brand-600 text-white"
                      : "ring-1 ring-gray-300 text-gray-500")
                }
              >
                {done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              {s.label}
            </Link>
            {i < STEPS.length - 1 && (
              <span className="text-gray-300" aria-hidden>
                ›
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

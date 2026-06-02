"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type TenantPickerOption } from "@/lib/api";
import { finalizeLogin, PRE_AUTH_KEY } from "../_utils";

type Stash = {
  pre_auth_token: string;
  available_tenants: TenantPickerOption[];
  // Deep-link destination carried over from the login page so a `?next=`
  // survives the tenant-picker hop. Validated again in finalizeLogin.
  next?: string;
};

export default function SelectTenantPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [stash, setStash] = useState<Stash | null>(null);
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Picker is unreachable without a fresh pre_auth_token. If the user
    // navigates here directly (or refreshes after we cleared the stash),
    // bounce back to /login.
    const raw = sessionStorage.getItem(PRE_AUTH_KEY);
    if (!raw) {
      router.replace("/login");
      return;
    }
    try {
      setStash(JSON.parse(raw) as Stash);
    } catch {
      sessionStorage.removeItem(PRE_AUTH_KEY);
      router.replace("/login");
    }
  }, [router]);

  async function pick(tenantId: number) {
    if (!stash) return;
    setSubmitting(tenantId);
    setError(null);
    try {
      const res = await api.selectTenant({
        pre_auth_token: stash.pre_auth_token,
        tenant_id: tenantId,
      });
      sessionStorage.removeItem(PRE_AUTH_KEY);
      finalizeLogin(res, router, qc, stash.next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido continuar");
      setSubmitting(null);
    }
  }

  if (!stash) {
    return null;
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Image
            src="/logo.png"
            alt="Trivu"
            width={160}
            height={64}
            priority
            className="h-16 w-auto"
          />
        </div>
        <div className="rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6">
          <h1 className="mb-1 text-lg font-semibold text-center text-gray-900">
            Elige un servicio
          </h1>
          <p className="mb-5 text-sm text-gray-600 text-center">
            Tienes acceso a varios servicios. Selecciona en cuál quieres entrar.
          </p>
          <ul className="space-y-2">
            {stash.available_tenants.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(t.id)}
                  disabled={submitting !== null}
                  className="w-full text-left rounded-lg ring-1 ring-gray-200 px-4 py-3 hover:bg-brand-50/60 hover:ring-brand-200 disabled:opacity-50 transition-colors"
                >
                  <div className="font-medium text-gray-900">{t.name}</div>
                  <div className="text-xs text-gray-500">{t.slug}</div>
                  {submitting === t.id && (
                    <div className="text-xs text-brand-700 mt-1">Entrando…</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}
        </div>
        <p className="mt-4 text-center text-sm text-gray-600">
          <a
            className="text-brand-700 font-medium hover:underline"
            href="/login"
          >
            Volver a iniciar sesión
          </a>
        </p>
      </div>
    </main>
  );
}

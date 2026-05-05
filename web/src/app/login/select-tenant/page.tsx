"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type TenantPickerOption } from "@/lib/api";
import { finalizeLogin, PRE_AUTH_KEY } from "../page";

type Stash = {
  pre_auth_token: string;
  available_tenants: TenantPickerOption[];
};

export default function SelectTenantPage() {
  const router = useRouter();
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
      finalizeLogin(res, router);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido continuar");
      setSubmitting(null);
    }
  }

  if (!stash) {
    return null;
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <div className="flex flex-col items-center mb-6">
        <Image
          src="/logo.jpeg"
          alt="Trivu"
          width={160}
          height={160}
          priority
          className="h-32 w-auto"
        />
      </div>
      <h1 className="text-2xl font-semibold mb-2 text-center">Elige un servicio</h1>
      <p className="text-sm text-gray-600 mb-6 text-center">
        Tienes acceso a varios servicios. Selecciona en cuál quieres entrar.
      </p>
      <ul className="space-y-3">
        {stash.available_tenants.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => pick(t.id)}
              disabled={submitting !== null}
              className="w-full text-left rounded-md border border-gray-300 px-4 py-3 hover:bg-gray-50 disabled:opacity-50"
            >
              <div className="font-medium">{t.name}</div>
              <div className="text-xs text-gray-500">{t.slug}</div>
              {submitting === t.id && (
                <div className="text-xs text-gray-500 mt-1">Entrando…</div>
              )}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <p className="mt-6 text-sm text-gray-600 text-center">
        <a className="underline" href="/login">
          Volver a iniciar sesión
        </a>
      </p>
    </main>
  );
}

"use client";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

// Next 14 requires the useSearchParams() caller to live under a
// Suspense boundary for the static prerender pass.
export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
          <p className="text-sm text-gray-500">Cargando…</p>
        </main>
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}

/**
 * Landing page for the password-reset link. The token in the URL
 * carries the person_id + a fingerprint of the current password
 * hash; submitting a new password sets it server-side and rotates
 * the hash (invalidating the token for re-use).
 *
 * Side effect on the backend: this flow also marks the address
 * email-verified, since clicking a delivered link proves mailbox
 * ownership at least as strongly as the signup verification step.
 */
function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !!token && password.length >= 8 && password === confirm && !loading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      // Send them to /login after a brief beat so they read the
      // success message. (Auto-login via the reset isn't safe —
      // we'd have to issue an access token from a public route.)
      setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se ha podido cambiar",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Image
            src="/logo.jpeg"
            alt="Trivu"
            width={96}
            height={96}
            priority
            className="h-20 w-20 rounded-2xl shadow-soft"
          />
          <div className="mt-3 text-2xl font-bold tracking-tight text-brand-700">
            Trivu
          </div>
        </div>
        <div className="rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6">
          <h1 className="mb-1 text-lg font-semibold text-center text-gray-900">
            Nueva contraseña
          </h1>
          {!token ? (
            <p className="mt-4 text-sm text-rose-700 text-center">
              Falta el token en el enlace. Solicita uno nuevo.
            </p>
          ) : done ? (
            <p className="mt-4 text-sm text-emerald-700 text-center">
              Contraseña actualizada. Te llevamos a iniciar sesión…
            </p>
          ) : (
            <form onSubmit={onSubmit} className="mt-4 space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Nueva contraseña (mínimo 8 caracteres)
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  name="new-password"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Repite la contraseña
                </span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  name="confirm-password"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
                {confirm && confirm !== password && (
                  <span className="mt-1 block text-xs text-rose-600">
                    Las contraseñas no coinciden.
                  </span>
                )}
              </label>
              {error && <p className="text-sm text-rose-600">{error}</p>}
              <button
                type="submit"
                disabled={!canSubmit}
                className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
              >
                {loading ? "Guardando…" : "Cambiar contraseña"}
              </button>
            </form>
          )}
        </div>
        <p className="mt-4 text-center text-sm text-gray-600">
          <Link
            href="/login"
            className="text-brand-700 font-medium hover:underline"
          >
            Volver a iniciar sesión
          </Link>
        </p>
      </div>
    </main>
  );
}

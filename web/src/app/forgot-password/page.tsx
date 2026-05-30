"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";

/**
 * "He olvidado mi contraseña" page. Submits the address to the
 * backend, which silently no-ops if the email isn't registered
 * (avoids enumeration). Either way, we show the same "te hemos
 * enviado un enlace" confirmation — the user can't tell from the
 * UI whether their email exists in our system.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.forgotPassword(email);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se ha podido enviar",
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
            Restablece tu contraseña
          </h1>
          <p className="mb-5 text-sm text-gray-600 text-center">
            Te enviaremos un enlace para elegir una nueva.
          </p>
          {done ? (
            <div className="space-y-4">
              <p className="text-sm text-emerald-700">
                Si esa dirección está registrada, recibirás un enlace
                en unos minutos. Revisa también la carpeta de spam.
              </p>
              <Link
                href="/login"
                className="block text-center text-sm font-medium text-brand-700 hover:underline"
              >
                Volver a iniciar sesión
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                  name="email"
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                />
              </label>
              {error && <p className="text-sm text-rose-600">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
              >
                {loading ? "Enviando…" : "Enviar enlace"}
              </button>
            </form>
          )}
        </div>
        <p className="mt-4 text-center text-sm text-gray-600">
          <Link
            href="/login"
            className="text-brand-700 font-medium hover:underline"
          >
            Volver
          </Link>
        </p>
      </div>
    </main>
  );
}

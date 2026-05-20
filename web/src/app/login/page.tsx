"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, isTenantSelectionResponse } from "@/lib/api";
import { finalizeLogin, PRE_AUTH_KEY } from "./_utils";

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login({ email, password });
      if (isTenantSelectionResponse(res)) {
        // Stash the pre_auth_token + tenant list and let the picker page
        // finish the flow.
        sessionStorage.setItem(
          PRE_AUTH_KEY,
          JSON.stringify({
            pre_auth_token: res.pre_auth_token,
            available_tenants: res.available_tenants,
          }),
        );
        router.push("/login/select-tenant");
        return;
      }
      finalizeLogin(res, router, qc);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido iniciar sesión");
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
            width={112}
            height={112}
            priority
            className="h-24 w-24 rounded-2xl shadow-soft"
          />
        </div>
        <div className="rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6">
          <h1 className="mb-5 text-lg font-semibold text-center text-gray-900">
            Inicia sesión
          </h1>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
            />
            <Field
              label="Contraseña"
              type="password"
              value={password}
              onChange={setPassword}
            />
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? "Entrando…" : "Entrar"}
            </button>
          </form>
          <p className="mt-4 text-center text-sm text-gray-600">
            <a
              className="text-brand-700 font-medium hover:underline"
              href="/forgot-password"
            >
              ¿Has olvidado tu contraseña?
            </a>
          </p>
        </div>
        <p className="mt-4 text-center text-sm text-gray-600">
          ¿No tienes cuenta?{" "}
          <a className="text-brand-700 font-medium hover:underline" href="/signup">
            Crear un servicio
          </a>
        </p>
      </div>
    </main>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        required
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}

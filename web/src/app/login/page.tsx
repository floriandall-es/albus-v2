"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, getToken, isTenantSelectionResponse } from "@/lib/api";
import { finalizeLogin, PRE_AUTH_KEY } from "./_utils";

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // True while we're checking whether an existing token is still
  // valid (PWA launch path). Renders a blank placeholder instead of
  // the login form so users don't see a flash of the form before
  // being routed to /admin or /me.
  const [bootstrapping, setBootstrapping] = useState(true);

  // PWA launch path: if there's already a token in localStorage,
  // resolve who the user is and route them straight to their app
  // home. The manifest's start_url is /login (migration to fix the
  // post-landing-page install regression), so without this every
  // PWA launch would show the login form to a logged-in user.
  // On 401 / network error we just clear the token and show the
  // form — same flow as if they'd been logged out.
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setBootstrapping(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (cancelled) return;
        const isAdmin = me.memberships.some((m) => m.roles.includes("admin"));
        const onboarded = me.current_tenant.onboarding_completed_at != null;
        if (isAdmin && !onboarded) {
          router.replace("/onboarding");
        } else if (isAdmin) {
          router.replace("/admin");
        } else {
          router.replace("/me");
        }
      } catch {
        if (cancelled) return;
        // Token rejected or network blew up — drop into the form.
        setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

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

  if (bootstrapping) {
    // Blank screen during the token-check redirect. Matches the
    // login screen's background so the launch transition reads as
    // "the app is loading" instead of a content flash.
    return (
      <main className="min-h-screen bg-gradient-to-b from-brand-50/50 to-gray-50" />
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Image
            src="/logo.png"
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
              autoComplete="username"
              name="email"
            />
            <Field
              label="Contraseña"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              name="current-password"
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
  autoComplete?: string;
  name?: string;
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
        autoComplete={props.autoComplete}
        name={props.name}
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}

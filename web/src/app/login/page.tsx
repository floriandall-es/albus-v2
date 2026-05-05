"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, isTenantSelectionResponse, setToken, type AuthResponse } from "@/lib/api";

// Stash key for the in-flight tenant picker. Lives only between login → picker
// nav, so sessionStorage (cleared on tab close) is the right scope.
export const PRE_AUTH_KEY = "trivu.preAuth";

export default function LoginPage() {
  const router = useRouter();
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
      finalizeLogin(res, router);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido iniciar sesión");
    } finally {
      setLoading(false);
    }
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
      <h1 className="text-2xl font-semibold mb-6 text-center">Inicia sesión</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field label="Contraseña" type="password" value={password} onChange={setPassword} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
        <p className="text-sm text-gray-600 text-center">
          ¿No tienes cuenta?{" "}
          <a className="underline" href="/signup">
            Crear un servicio
          </a>
        </p>
      </form>
    </main>
  );
}

// Shared post-login redirect. Used both on the single-membership path and
// after the tenant picker exchanges a pre_auth_token for an access token.
export function finalizeLogin(
  res: AuthResponse,
  router: { push: (path: string) => void },
) {
  setToken(res.access_token);
  const isAdmin = res.memberships.some((m) => m.roles.includes("admin"));
  const onboarded = res.tenant.onboarding_completed_at != null;
  if (isAdmin && !onboarded) {
    router.push("/onboarding");
  } else if (isAdmin) {
    router.push("/admin");
  } else {
    router.push("/me");
  }
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
      <span className="text-sm font-medium">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        required
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
      />
    </label>
  );
}

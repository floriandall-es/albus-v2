"use client";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [tenantName, setTenantName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.signup({
        tenant_name: tenantName,
        first_name: firstName,
        last_name: lastName,
        email,
        password,
        accept_terms: acceptTerms,
      });
      setToken(res.access_token);
      // Fresh tenant — always go straight into the onboarding wizard.
      router.push("/onboarding");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido crear el servicio");
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
            Crea tu servicio
          </h1>
          <p className="mb-5 text-sm text-gray-600 text-center">
            Configura Trivu en unos minutos.
          </p>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field
              label="Nombre del servicio"
              value={tenantName}
              onChange={setTenantName}
              placeholder="ej. Hospital Universitario La Paz"
            />
            <Field
              label="Tu nombre"
              value={firstName}
              onChange={setFirstName}
              placeholder="ej. Gabriel"
            />
            <Field
              label="Apellidos"
              value={lastName}
              onChange={setLastName}
              placeholder="ej. Pérez García"
            />
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
            />
            <Field
              label="Contraseña (mínimo 8 caracteres)"
              type="password"
              value={password}
              onChange={setPassword}
            />
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                required
                className="mt-0.5 shrink-0"
              />
              <span>
                Acepto los{" "}
                <Link
                  href="/terms"
                  target="_blank"
                  className="text-brand-700 hover:underline"
                >
                  términos y condiciones
                </Link>{" "}
                y la{" "}
                <Link
                  href="/privacy"
                  target="_blank"
                  className="text-brand-700 hover:underline"
                >
                  política de privacidad
                </Link>
                .
              </span>
            </label>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <button
              type="submit"
              disabled={loading || !acceptTerms}
              className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? "Creando…" : "Crear servicio"}
            </button>
          </form>
        </div>
        <p className="mt-4 text-center text-sm text-gray-600">
          ¿Ya tienes cuenta?{" "}
          <a
            className="text-brand-700 font-medium hover:underline"
            href="/login"
          >
            Inicia sesión
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

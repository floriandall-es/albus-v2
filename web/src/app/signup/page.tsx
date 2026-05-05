"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [tenantName, setTenantName] = useState("");
  const [personName, setPersonName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.signup({
        tenant_name: tenantName,
        person_name: personName,
        email,
        password,
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
      <h1 className="text-2xl font-semibold mb-2 text-center">
        Crea tu servicio
      </h1>
      <p className="text-sm text-gray-600 mb-6 text-center">
        Configura Trivu para tu hospital o departamento en unos minutos.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Nombre del servicio"
          value={tenantName}
          onChange={setTenantName}
          placeholder="ej. Hospital Universitario La Paz"
        />
        <Field label="Tu nombre" value={personName} onChange={setPersonName} />
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field
          label="Contraseña (mínimo 8 caracteres)"
          type="password"
          value={password}
          onChange={setPassword}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Creando…" : "Crear servicio"}
        </button>
        <p className="text-sm text-gray-600 text-center">
          ¿Ya tienes cuenta?{" "}
          <a className="underline" href="/login">
            Inicia sesión
          </a>
        </p>
      </form>
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

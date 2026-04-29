"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
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
        tenant_slug: tenantSlug,
        person_name: personName,
        email,
        password,
      });
      setToken(res.access_token);
      router.push("/me");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-semibold mb-6">Create your hospital workspace</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Hospital name" value={tenantName} onChange={setTenantName} />
        <Field
          label="Subdomain slug (a–z, 0–9, dashes)"
          value={tenantSlug}
          onChange={(v) => setTenantSlug(v.toLowerCase())}
        />
        <Field label="Your name" value={personName} onChange={setPersonName} />
        <Field label="Email" type="email" value={email} onChange={setEmail} />
        <Field label="Password (min 8 chars)" type="password" value={password} onChange={setPassword} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Creating…" : "Create workspace"}
        </button>
        <p className="text-sm text-gray-600">
          Already have one? <a className="underline" href="/login">Sign in</a>
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
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
      />
    </label>
  );
}

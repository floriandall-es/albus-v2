"use client";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api, clearToken, getToken } from "@/lib/api";

export default function MePage() {
  const router = useRouter();

  useEffect(() => {
    if (!getToken()) router.replace("/login");
  }, [router]);

  const q = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

  // Redirect un-onboarded admins straight into the wizard.
  useEffect(() => {
    if (!q.data) return;
    const isAdmin = q.data.memberships.some((m) => m.roles.includes("admin"));
    if (isAdmin && q.data.current_tenant.onboarding_completed_at === null) {
      router.replace("/onboarding");
    }
  }, [q.data, router]);

  if (q.isLoading) return <Centered>Loading…</Centered>;
  if (q.isError) {
    return (
      <Centered>
        <p className="text-red-600 mb-4">{(q.error as Error).message}</p>
        <button
          className="rounded-md border px-3 py-1"
          onClick={() => {
            clearToken();
            router.push("/login");
          }}
        >
          Sign in again
        </button>
      </Centered>
    );
  }

  const me = q.data!;
  return (
    <main className="mx-auto max-w-2xl p-8 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{me.current_tenant.name}</h1>
        <button
          className="text-sm underline"
          onClick={() => {
            clearToken();
            router.push("/login");
          }}
        >
          Sign out
        </button>
      </header>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-medium mb-2">You</h2>
        <dl className="text-sm grid grid-cols-[8rem_1fr] gap-y-1">
          <dt className="text-gray-500">Name</dt><dd>{me.person.name}</dd>
          <dt className="text-gray-500">Email</dt><dd>{me.person.email}</dd>
          <dt className="text-gray-500">Tenant slug</dt><dd>{me.current_tenant.slug}</dd>
        </dl>
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-medium mb-2">Memberships ({me.memberships.length})</h2>
        <ul className="text-sm space-y-1">
          {me.memberships.map((m) => (
            <li key={m.id}>
              tenant #{m.tenant_id} — roles: {m.roles.join(", ") || "(none)"}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-medium mb-2">Departments ({me.departments.length})</h2>
        <ul className="text-sm">
          {me.departments.map((d) => <li key={d.id}>{d.name}</li>)}
          {me.departments.length === 0 && <li className="text-gray-500">None yet.</li>}
        </ul>
      </section>

      <section className="rounded-md border bg-white p-4">
        <h2 className="font-medium mb-2">Role types ({me.role_types.length})</h2>
        <ul className="text-sm">
          {me.role_types.map((r) => <li key={r.id}>{r.name}</li>)}
          {me.role_types.length === 0 && <li className="text-gray-500">None yet.</li>}
        </ul>
      </section>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-md p-8 text-center">{children}</main>;
}

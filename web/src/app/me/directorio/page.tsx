"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import {
  api,
  personLastName,
  type HospitalDirectoryEntry,
} from "@/lib/api";
import { Avatar } from "@/components/schedule/planning-grid";

/**
 * Hospital directory — first cross-tenant feature.
 *
 * Lists every active clinician at the caller's hospital (across
 * all departments / tenants), with search + filter by department
 * and categoría. Hidden when the caller's tenant has no parent
 * hospital — the page renders an empty state pointing back to
 * onboarding instead of 404-ing.
 *
 * Privacy: name + categoría + department only. No emails or
 * phones in P1. Members opt out per-employment via the toggle on
 * /me/settings.
 */
export default function HospitalDirectoryPage() {
  const [q, setQ] = useState("");
  const [tenantId, setTenantId] = useState<number | "">("");
  const [categoryId, setCategoryId] = useState<number | "">("");

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const directory = useQuery({
    queryKey: ["hospital-directory", q, tenantId, categoryId],
    queryFn: () =>
      api.listHospitalDirectory({
        q: q || undefined,
        tenant_id: tenantId === "" ? undefined : tenantId,
        category_id: categoryId === "" ? undefined : categoryId,
      }),
  });

  const hospitalName = me.data?.current_tenant.hospital_name ?? null;
  const hospitalId = me.data?.current_tenant.hospital_id ?? null;

  // Derive filter dropdown options from the unfiltered result set
  // — the dropdown options stay stable as the user types in the
  // search box, and shrinking via category/tenant doesn't blow
  // them away.
  const allRows = directory.data ?? [];
  const tenantOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of allRows) m.set(r.tenant_id, r.tenant_name);
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [allRows]);
  const categoryOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of allRows) {
      if (r.category_id !== null && r.category_name !== null) {
        m.set(r.category_id, r.category_name);
      }
    }
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [allRows]);

  // The empty state when the tenant has no hospital is different
  // from "the hospital has 0 visible members" — render distinct
  // copy so the admin knows which problem to fix.
  if (hospitalId === null) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold">Directorio del hospital</h1>
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
          <div className="mb-2 flex items-center gap-2 text-gray-800 font-medium">
            <Building2 className="h-5 w-5 text-gray-500" />
            Este servicio aún no está vinculado a un hospital.
          </div>
          <p>
            Configura el hospital en{" "}
            <a
              href="/onboarding/preset"
              className="text-brand-700 hover:underline"
            >
              Tipo de equipo
            </a>{" "}
            para activar el directorio compartido entre departamentos.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Directorio del hospital</h1>
        {hospitalName && (
          <p className="mt-1 text-sm text-gray-600">{hospitalName}</p>
        )}
      </div>

      {/* Filter bar — search input + two dropdowns. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-soft">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre…"
            className="rounded-md border border-gray-300 pl-7 pr-3 py-1 text-sm w-56"
          />
        </div>
        <select
          value={tenantId}
          onChange={(e) =>
            setTenantId(e.target.value === "" ? "" : Number(e.target.value))
          }
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="">Todos los servicios</option>
          {tenantOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={categoryId}
          onChange={(e) =>
            setCategoryId(e.target.value === "" ? "" : Number(e.target.value))
          }
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="">Todas las categorías</option>
          {categoryOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-gray-500">
          {allRows.length} {allRows.length === 1 ? "persona" : "personas"}
        </span>
      </div>

      {directory.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}
      {directory.isError && (
        <p className="text-sm text-rose-700">
          {(directory.error as Error).message}
        </p>
      )}
      {directory.data && directory.data.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
          Nadie aparece en el directorio con estos filtros.
        </div>
      )}

      {directory.data && directory.data.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {directory.data.map((r) => (
            <DirectoryCard key={r.membership_id} entry={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DirectoryCard({ entry }: { entry: HospitalDirectoryEntry }) {
  const displayName = personLastName({
    name: entry.person_name,
    last_name: entry.person_last_name,
  });
  return (
    <li className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-soft">
      <Avatar
        name={entry.person_name}
        mine={false}
        imageUrl={entry.person_avatar_url}
      />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-medium text-gray-900">
          {displayName}
        </div>
        <div className="truncate text-xs text-gray-500">
          {[entry.category_name, entry.tenant_name, entry.group_name]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </li>
  );
}

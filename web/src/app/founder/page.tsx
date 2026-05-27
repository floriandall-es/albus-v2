"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow, parseISO } from "date-fns";
import { es } from "date-fns/locale";
import {
  ArrowDownUp,
  Building2,
  Calendar,
  CheckCircle2,
  Mail,
  ShieldCheck,
  Users,
} from "lucide-react";
import { api, type FounderTenantSummary } from "@/lib/api";

/** Columns the founder can sort by. The key matches the field on
 * FounderTenantSummary so the sort comparator is a one-liner. */
type SortKey =
  | "signup_date"
  | "name"
  | "members_count"
  | "admins_count"
  | "last_login_at"
  | "last_schedule_published_at"
  | "pending_invitations_count";

type SortDir = "asc" | "desc";

/** Render an ISO timestamp as "hace 3 días", or em-dash if null.
 * Server returns UTC; date-fns reads the offset so this is correct
 * for any client timezone. */
function relativeOrDash(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(parseISO(iso), {
      addSuffix: true,
      locale: es,
    });
  } catch {
    return "—";
  }
}

/** Same as relativeOrDash but renders the absolute date underneath
 * as a tooltip-style secondary line. Used for the signup column
 * where the exact date matters more than "hace 2 meses". */
function absoluteAndRelative(iso: string | null) {
  if (!iso) return <span className="text-gray-400">—</span>;
  let abs = iso;
  let rel = "";
  try {
    const d = parseISO(iso);
    abs = d.toLocaleDateString("es-ES", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    rel = formatDistanceToNow(d, { addSuffix: true, locale: es });
  } catch {
    // fall through to raw iso
  }
  return (
    <div className="leading-tight">
      <div className="text-gray-900">{abs}</div>
      {rel && <div className="text-[11px] text-gray-400">{rel}</div>}
    </div>
  );
}

export default function FounderDashboardPage() {
  const [sortKey, setSortKey] = useState<SortKey>("signup_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");

  const tenants = useQuery({
    queryKey: ["founder-tenants"],
    queryFn: api.listFounderTenants,
    // Cross-tenant query — moderate cost server-side. Refetch on
    // focus so a re-visit after onboarding a new equipo picks them
    // up without a hard reload.
    refetchOnWindowFocus: true,
  });

  const filteredSorted = useMemo<FounderTenantSummary[]>(() => {
    const data = tenants.data ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? data.filter((t) => {
          const hay = [
            t.name,
            t.slug,
            t.hospital_name ?? "",
            t.servicio_name ?? "",
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : data;
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // Nulls land at the bottom regardless of direction so an
      // ascending sort by last_login still shows the active
      // tenants first.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return sorted;
  }, [tenants.data, query, sortKey, sortDir]);

  const stats = useMemo(() => {
    const data = tenants.data ?? [];
    const totalTenants = data.length;
    const totalMembers = data.reduce((s, t) => s + t.members_count, 0);
    const totalAdmins = data.reduce((s, t) => s + t.admins_count, 0);
    // "Activos" = at least one login in the past 14 days. Cheap
    // pulse-check; refine later if we want a per-week chart.
    const now = Date.now();
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    const activeTenants = data.filter((t) => {
      if (!t.last_login_at) return false;
      try {
        return now - parseISO(t.last_login_at).getTime() < fourteenDays;
      } catch {
        return false;
      }
    }).length;
    const tenantsWithPublished = data.filter(
      (t) => t.last_schedule_published_at != null,
    ).length;
    return {
      totalTenants,
      totalMembers,
      totalAdmins,
      activeTenants,
      tenantsWithPublished,
    };
  }, [tenants.data]);

  function setSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      // Numeric/date columns default to descending (biggest /
      // most-recent first). Name defaults to ascending (A→Z).
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  if (tenants.isLoading) {
    return <div className="text-sm text-gray-500">Cargando equipos…</div>;
  }
  if (tenants.isError) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Error cargando equipos: {(tenants.error as Error).message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">
          Equipos registrados
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Todos los equipos que han completado el signup, con métricas
          de uso. Datos en tiempo real — la consulta cruza tenants
          saltándose el RLS.
        </p>
      </header>

      {/* Stats strip — small, dense, no chart noise. Five cards
          summarising the table below. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          icon={<Building2 className="h-4 w-4 text-brand-600" />}
          label="Equipos"
          value={stats.totalTenants}
        />
        <StatCard
          icon={<Users className="h-4 w-4 text-emerald-600" />}
          label="Miembros activos"
          value={stats.totalMembers}
        />
        <StatCard
          icon={<ShieldCheck className="h-4 w-4 text-violet-600" />}
          label="Admins"
          value={stats.totalAdmins}
        />
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4 text-sky-600" />}
          label="Activos últimos 14 d"
          value={stats.activeTenants}
        />
        <StatCard
          icon={<Calendar className="h-4 w-4 text-amber-600" />}
          label="Con planificación"
          value={stats.tenantsWithPublished}
        />
      </div>

      {/* Filter row */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre, slug, hospital o servicio…"
          className="w-full max-w-md rounded-md border border-gray-200 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <span className="text-xs text-gray-500">
          {filteredSorted.length}{" "}
          {filteredSorted.length === 1 ? "equipo" : "equipos"}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-soft">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500">
              <tr>
                <Th
                  label="Equipo"
                  sortKey="name"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                />
                <Th
                  label="Signup"
                  sortKey="signup_date"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                />
                <Th
                  label="Miembros"
                  sortKey="members_count"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                  align="right"
                />
                <Th
                  label="Admins"
                  sortKey="admins_count"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                  align="right"
                />
                <Th
                  label="Último login"
                  sortKey="last_login_at"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                />
                <Th
                  label="Última planificación"
                  sortKey="last_schedule_published_at"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                />
                <Th
                  label="Invitaciones"
                  sortKey="pending_invitations_count"
                  active={sortKey}
                  dir={sortDir}
                  onClick={setSort}
                  align="right"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredSorted.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{t.name}</div>
                    <div className="text-[11px] text-gray-500">
                      {t.hospital_name ?? (
                        <span className="italic text-gray-400">
                          sin hospital
                        </span>
                      )}
                      {t.servicio_name && (
                        <>
                          {" · "}
                          {t.servicio_name}
                        </>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-400">/{t.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-[12px]">
                    {absoluteAndRelative(t.signup_date)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                    {t.members_count}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                    {t.admins_count}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gray-700">
                    {relativeOrDash(t.last_login_at)}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gray-700">
                    {relativeOrDash(t.last_schedule_published_at)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {t.pending_invitations_count > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        <Mail className="h-3 w-3" />
                        {t.pending_invitations_count}
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                </tr>
              ))}
              {filteredSorted.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-sm text-gray-400"
                  >
                    Sin resultados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-soft">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
        {value}
      </div>
    </div>
  );
}

function Th({
  label,
  sortKey,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = active === sortKey;
  return (
    <th
      scope="col"
      className={
        "px-4 py-2 font-semibold "
        + (align === "right" ? "text-right" : "text-left")
      }
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={
          "inline-flex items-center gap-1 hover:text-gray-700 "
          + (isActive ? "text-gray-900" : "")
        }
      >
        {label}
        <ArrowDownUp
          className={
            "h-3 w-3 "
            + (isActive
              ? dir === "asc"
                ? "rotate-180 text-brand-600"
                : "text-brand-600"
              : "text-gray-300")
          }
        />
      </button>
    </th>
  );
}

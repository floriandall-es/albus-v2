"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Search,
  Star,
} from "lucide-react";
import {
  api,
  personFullName,
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
        <DirectoryGroupedList
          rows={directory.data}
          mePersonId={me.data?.person.id ?? null}
        />
      )}
    </div>
  );
}

/** Cluster the directory by department (tenant) with a header per
 * department, alphabetical by name. Within each department, sort
 * by last name (Spanish convention). The backend already orders
 * by (category, last name) but the categoría sub-grouping is
 * invisible without headers, so it just reads as "not
 * alphabetical" — we override here for a clean alpha list per
 * department.
 *
 * Favorites get their own section at the very top, alphabetical
 * by last name, KEEPING the entries also visible in their
 * department below — Favoritos is a quick-access shortcut, not a
 * "move here" operation.
 *
 * Each card's subtitle drops the tenant name (it would just
 * duplicate the section header). Categoría + sub-equipo stay. */
function DirectoryGroupedList({
  rows,
  mePersonId,
}: {
  rows: HospitalDirectoryEntry[];
  mePersonId: number | null;
}) {
  const { favorites, groups } = useMemo(() => {
    const lastNameSort = (
      a: HospitalDirectoryEntry,
      b: HospitalDirectoryEntry,
    ) => {
      const aName = (a.person_last_name ?? a.person_name).toLowerCase();
      const bName = (b.person_last_name ?? b.person_name).toLowerCase();
      return aName.localeCompare(bName, "es");
    };
    const favs = rows.filter((r) => r.is_favorite).sort(lastNameSort);
    const byDept = new Map<
      number,
      { name: string; rows: HospitalDirectoryEntry[] }
    >();
    for (const r of rows) {
      const existing = byDept.get(r.tenant_id);
      if (existing) {
        existing.rows.push(r);
      } else {
        byDept.set(r.tenant_id, { name: r.tenant_name, rows: [r] });
      }
    }
    const depts = Array.from(byDept.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "es"),
    );
    for (const d of depts) {
      d.rows.sort(lastNameSort);
    }
    return { favorites: favs, groups: depts };
  }, [rows]);

  return (
    <div className="space-y-6">
      {favorites.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-amber-700">
            <Star className="h-3.5 w-3.5 fill-amber-400 stroke-amber-500" />
            Favoritos
            <span className="text-[11px] font-normal normal-case text-gray-400">
              {favorites.length}{" "}
              {favorites.length === 1 ? "persona" : "personas"}
            </span>
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {favorites.map((r) => (
              <DirectoryCard
                // Distinct key from the department render — same
                // entry appears in both places.
                key={`fav-${r.membership_id}`}
                entry={r}
                mePersonId={mePersonId}
              />
            ))}
          </ul>
        </section>
      )}
      {groups.map((dept) => (
        <section key={dept.name}>
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600">
            {dept.name}
            <span className="text-[11px] font-normal normal-case text-gray-400">
              {dept.rows.length}{" "}
              {dept.rows.length === 1 ? "persona" : "personas"}
            </span>
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {dept.rows.map((r) => (
              <DirectoryCard
                key={r.membership_id}
                entry={r}
                mePersonId={mePersonId}
                hideDepartment
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DirectoryCard({
  entry,
  mePersonId,
  hideDepartment = false,
}: {
  entry: HospitalDirectoryEntry;
  mePersonId: number | null;
  /** When the card is rendered inside a per-department section
   * (the default layout now), the tenant_name in the subtitle is
   * redundant with the section header — set this to drop it. */
  hideDepartment?: boolean;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const openDm = useMutation({
    mutationFn: () => api.createOrGetDM(entry.person_id),
    onSuccess: (conv) => {
      router.push(`/me/mensajes?c=${conv.id}`);
    },
  });
  // Star toggle. We optimistically flip the cached entry so the
  // Favoritos section + star icon update instantly, then refetch
  // on settlement to reconcile. Same entry appears in both the
  // Favoritos section and its department — both update because
  // they read from the same query cache.
  const toggleFavorite = useMutation({
    mutationFn: () =>
      entry.is_favorite
        ? api.removeDirectoryFavorite(entry.person_id)
        : api.addDirectoryFavorite(entry.person_id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["hospital-directory"] });
      const prev = qc.getQueriesData<HospitalDirectoryEntry[]>({
        queryKey: ["hospital-directory"],
      });
      for (const [key, value] of prev) {
        if (!value) continue;
        qc.setQueryData<HospitalDirectoryEntry[]>(
          key,
          value.map((r) =>
            r.person_id === entry.person_id
              ? { ...r, is_favorite: !entry.is_favorite }
              : r,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back on failure so the UI stays truthful.
      ctx?.prev.forEach(([key, value]) =>
        qc.setQueryData<HospitalDirectoryEntry[] | undefined>(key, value),
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["hospital-directory"] });
    },
  });
  const isMe = mePersonId !== null && entry.person_id === mePersonId;
  const displayName = personFullName({
    name: entry.person_name,
    first_name: entry.person_first_name,
    last_name: entry.person_last_name,
  });
  // Contact buttons render only when the entry exposes the channel
  // (the backend already gates this on the share_* opt-in flags).
  // WhatsApp uses the wa.me deep link — works without an API key,
  // opens the native app on mobile and web.wa.com on desktop.
  // wa.me wants digits-only; strip whatever formatting the user
  // typed when they saved their personal phone.
  const waDigits = entry.whatsapp_phone?.replace(/[^0-9]/g, "") ?? "";
  const buttons: { key: string; href: string; label: string; Icon: typeof Phone }[]
    = [];
  if (entry.work_phone) {
    buttons.push({
      key: "work-phone",
      href: `tel:${entry.work_phone}`,
      label: "Llamar (trabajo)",
      Icon: Phone,
    });
  }
  if (entry.personal_phone) {
    buttons.push({
      key: "personal-phone",
      href: `tel:${entry.personal_phone}`,
      label: "Llamar (móvil)",
      Icon: Phone,
    });
  }
  if (entry.whatsapp_phone) {
    buttons.push({
      key: "wa",
      href: `https://wa.me/${waDigits}`,
      label: "WhatsApp",
      Icon: MessageCircle,
    });
  }
  if (entry.email) {
    buttons.push({
      key: "email",
      href: `mailto:${entry.email}`,
      label: "Email",
      Icon: Mail,
    });
  }

  return (
    <li className="relative flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-soft">
      {/* Star toggle (top-right). Hidden for the user's own
          card — "favoriting yourself" doesn't make sense (DB
          CHECK rejects it anyway). 44×44 hit target for thumb-
          friendly mobile taps; sits in the corner so it never
          competes with the avatar / name for attention. */}
      {!isMe && (
        <button
          type="button"
          aria-pressed={entry.is_favorite}
          aria-label={
            entry.is_favorite
              ? "Quitar de favoritos"
              : "Añadir a favoritos"
          }
          onClick={() => toggleFavorite.mutate()}
          disabled={toggleFavorite.isPending}
          className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center text-gray-300 hover:text-amber-500 active:text-amber-600 disabled:opacity-60"
        >
          <Star
            className={
              "h-5 w-5 transition-colors "
              + (entry.is_favorite
                ? "fill-amber-400 stroke-amber-500"
                : "fill-transparent")
            }
          />
        </button>
      )}
      <div className="flex items-start gap-4 pr-8">
        <Avatar
          name={entry.person_name}
          mine={false}
          imageUrl={entry.person_avatar_url}
          size="lg"
        />
        <div className="min-w-0 flex-1 leading-tight pt-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="truncate text-base font-semibold text-gray-900">
              {displayName}
            </span>
            {entry.on_guardia_today && (
              <span
                className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800"
                title={`De ${entry.on_guardia_today} hoy`}
              >
                {entry.on_guardia_today}
              </span>
            )}
          </div>
          {/* Cargos as pills when set; otherwise fall back to the
              scheduling categoría as plain text (legacy view for
              users who haven't picked any cargo). */}
          {entry.cargos.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {entry.cargos.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800"
                >
                  {c}
                </span>
              ))}
            </div>
          ) : (
            entry.category_name && (
              <div className="mt-1 truncate text-sm text-gray-600">
                {entry.category_name}
              </div>
            )
          )}
          {/* Department + sub-equipo line (separate from cargos
              so it stays as quiet metadata under the pills). */}
          {(!hideDepartment && entry.tenant_name) || entry.group_name ? (
            <div className="mt-1 truncate text-xs text-gray-500">
              {[
                hideDepartment ? null : entry.tenant_name,
                entry.group_name,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
        </div>
      </div>
      {(buttons.length > 0 || !isMe) && (
        <div className="flex flex-wrap gap-1.5 border-t border-gray-100 pt-3">
          {!isMe && (
            <button
              type="button"
              onClick={() => openDm.mutate()}
              disabled={openDm.isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-100 disabled:opacity-60"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              {openDm.isPending ? "Abriendo…" : "Mensaje"}
            </button>
          )}
          {buttons.map(({ key, href, label, Icon }) => (
            <a
              key={key}
              href={href}
              // Open external in new tab for WhatsApp (web flow);
              // tel: / mailto: stay in-place so the device handler
              // takes over without leaving an empty tab behind.
              target={key === "wa" ? "_blank" : undefined}
              rel={key === "wa" ? "noopener noreferrer" : undefined}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

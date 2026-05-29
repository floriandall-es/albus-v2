"use client";

/**
 * Tenant settings card on /admin/settings.
 *
 * Admin can rewrite the team's display name (shown in the sidebar
 * header, tenant picker, email subjects, DM peer rows…). The slug
 * and parent hospital are surfaced read-only — the slug is
 * URL-stable by design and the hospital is set during Phase D
 * signup, so admins shouldn't tweak either from here.
 *
 * After save we invalidate ["me"] so the sidebar header reads the
 * new name on the next paint without a full reload.
 */

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Building2, Check, X } from "lucide-react";

import { Card } from "@/components/admin/ui";
import { api } from "@/lib/api";

export function TenantSettingsCard() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["admin-tenant-settings"],
    queryFn: api.getAdminTenantSettings,
  });
  // Local draft so the user can cancel without losing other
  // unsaved edits on the page. Seeded from the server value once
  // it lands.
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (settings.data?.name) setDraft(settings.data.name);
  }, [settings.data?.name]);

  const patch = useMutation({
    mutationFn: (name: string) =>
      api.patchAdminTenantSettings({ name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-tenant-settings"] });
      // Sidebar header reads `me.current_tenant.name` — bust that
      // cache too so the rename shows up everywhere immediately.
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo renombrar: ${msg}`);
    },
  });

  if (settings.isLoading) {
    return (
      <div className="mt-6 max-w-xl">
        <Card>
          <p className="px-4 py-3 text-sm text-gray-500">
            Cargando…
          </p>
        </Card>
      </div>
    );
  }
  if (!settings.data) return null;

  const trimmed = draft.trim();
  const dirty = trimmed.length > 0 && trimmed !== settings.data.name;
  const tooShort = trimmed.length < 2;

  return (
    <div className="mt-6 max-w-xl">
      <Card>
        <div className="p-4">
          <div className="flex items-start gap-3">
            <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-gray-500" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-gray-900">
                Tu equipo
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                El nombre se ve en la barra lateral, los emails que
                Trivu envía, el selector cuando un usuario tiene
                varios equipos, y en las cabeceras de las
                conversaciones.
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700">
                Nombre del equipo
              </label>
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={120}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
              {tooShort && draft.length > 0 && (
                <p className="mt-1 text-[11px] text-amber-700">
                  Mínimo 2 caracteres.
                </p>
              )}
            </div>
            <ReadOnlyField
              label="Identificador (slug)"
              value={settings.data.slug}
              hint="Se queda fijo — los enlaces compartidos y la URL de tu equipo siguen funcionando aunque cambies el nombre."
            />
            {settings.data.hospital_name && (
              <ReadOnlyField
                label="Hospital"
                value={settings.data.hospital_name}
                hint="Se configura durante el alta del equipo."
              />
            )}
            {dirty && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setDraft(settings.data!.name)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  <X className="h-3.5 w-3.5" />
                  Descartar
                </button>
                <button
                  type="button"
                  onClick={() => patch.mutate(trimmed)}
                  disabled={tooShort || patch.isPending}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  {patch.isPending ? "Guardando…" : "Guardar"}
                </button>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700">
        {label}
      </label>
      <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
        {value}
      </div>
      <p className="mt-1 text-[11px] text-gray-500">{hint}</p>
    </div>
  );
}

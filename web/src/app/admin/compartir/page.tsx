"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Eye, EyeOff } from "lucide-react";
import { api, type SharePolicy } from "@/lib/api";
import { Card, EmptyState, PageHeader } from "@/components/admin/ui";

/**
 * /admin/compartir — admin-only share-policy configuration.
 *
 * Sits under Configuración in the admin sidebar. The cross-equipo
 * read view (/me/servicio) is open to every member; only the
 * tenant admin can decide what THIS equipo shares with the rest
 * of the Servicio, and that decision lives here.
 *
 * Three options, mutually exclusive:
 *   - Nada              → other equipos see nothing of ours.
 *   - Algunas actividades → only slots flagged shared_with_servicio
 *                          appear (toggle on each slot in /admin/slots).
 *   - Todo el equipo     → every published assignment appears.
 *
 * Server-side: PATCH /api/equipos/me/share-policy. The backend
 * gates on admin role; we render the page entirely for admins and
 * route non-admins back to /me/servicio (where they can read but
 * not edit).
 */

const POLICY_LABEL: Record<SharePolicy, string> = {
  none: "Nada",
  selected: "Algunas actividades",
  full: "Todo el equipo",
};

const POLICY_HELP: Record<SharePolicy, string> = {
  none:
    "Tu equipo no aparece en la vista conjunta del servicio. Es el "
    + "valor por defecto para equipos nuevos.",
  selected:
    "Tu equipo aparece solo en las actividades que marques como "
    + "compartidas en Actividades.",
  full:
    "Tu equipo aparece con toda su planificación publicada en la "
    + "vista conjunta del servicio. Los borradores no se incluyen.",
};

export default function CompartirPage() {
  const qc = useQueryClient();
  const router = useRouter();

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const servicioId = me.data?.current_tenant.servicio_id ?? null;
  const currentPolicy: SharePolicy =
    me.data?.current_tenant.share_policy ?? "none";

  // Non-admins shouldn't even land here — the page itself is
  // admin-only. The admin sidebar only renders the link for admins
  // (the /admin layout already redirects non-admins to /me on
  // load), but direct-URL visitors still need a guard. Bounce
  // them to /me/servicio where they CAN read the joint view.
  const isAdmin =
    me.data?.memberships.some(
      (m) =>
        m.tenant_id === me.data?.current_tenant.id
        && m.roles.includes("admin"),
    ) ?? false;
  useEffect(() => {
    if (me.data && !isAdmin) {
      router.replace("/me/servicio");
    }
  }, [me.data, isAdmin, router]);

  const updatePolicy = useMutation({
    mutationFn: (next: SharePolicy) =>
      api.updateMySharePolicy({ share_policy: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      // Both the equipos badge list AND the timeline filter depend
      // on this policy — invalidate so the changes show up if the
      // admin pops back to /me/servicio in another tab.
      qc.invalidateQueries({ queryKey: ["servicio", servicioId] });
      qc.invalidateQueries({ queryKey: ["servicio-timeline", servicioId] });
    },
  });

  if (me.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }

  if (servicioId === null) {
    return (
      <>
        <PageHeader title="Compartir" />
        <EmptyState
          icon={<Building2 className="h-5 w-5" />}
          title="Sin servicio asignado"
          description={
            "Este equipo no está vinculado a un servicio, así que no "
            + "hay otros equipos con los que compartir."
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Compartir" />
      <p className="-mt-4 mb-6 max-w-2xl text-sm text-gray-600">
        Controla qué ven los otros equipos del servicio en{" "}
        <a
          href="/me/servicio"
          className="text-brand-700 underline-offset-2 hover:underline"
        >
          la vista conjunta
        </a>
        . Lectura solamente — ningún otro equipo puede editar tu
        planificación.
      </p>

      <Card>
        <div className="p-4 space-y-2">
          {(["none", "selected", "full"] as SharePolicy[]).map((p) => (
            <label
              key={p}
              className={
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
                + (currentPolicy === p
                  ? "border-brand-300 bg-brand-50/40"
                  : "border-gray-200 hover:bg-gray-50")
              }
            >
              <input
                type="radio"
                name="share-policy"
                className="mt-1"
                checked={currentPolicy === p}
                disabled={updatePolicy.isPending}
                onChange={() => updatePolicy.mutate(p)}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">
                    {POLICY_LABEL[p]}
                  </span>
                  <PolicyBadge policy={p} />
                </div>
                <div className="mt-0.5 text-xs text-gray-600">
                  {POLICY_HELP[p]}
                </div>
                {p === "selected" && currentPolicy === "selected" && (
                  <div className="mt-1 text-[11px] text-gray-500">
                    Marca las actividades a compartir en{" "}
                    <a
                      href="/admin/slots"
                      className="text-brand-700 underline-offset-2 hover:underline"
                    >
                      Actividades
                    </a>
                    .
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>
      </Card>
    </>
  );
}

function PolicyBadge({ policy }: { policy: SharePolicy }) {
  if (policy === "full") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
        <Eye className="h-3 w-3" />
        Todo
      </span>
    );
  }
  if (policy === "selected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">
        <Eye className="h-3 w-3" />
        Algunas
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
      <EyeOff className="h-3 w-3" />
      Nada
    </span>
  );
}

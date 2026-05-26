"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CheckCircle2, UserPlus, XCircle } from "lucide-react";
import { api, type PendingEquipo } from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";

/**
 * /admin/equipos-pendientes — sibling-equipo approval inbox.
 *
 * Phase D.3. When a new Equipo signs up under an already-populated
 * Servicio, it lands in approval_state='pending' and an email goes
 * out to admins of every approved sibling. This page is where those
 * admins act on it:
 *
 *   - Approve → tenant flips to 'approved' and the new admin can
 *     log in and start using their tenant immediately.
 *   - Decline → tenant is hard-deleted (no data has been entered
 *     yet by definition — the request is pending), the requester's
 *     Person row survives so they can try again, and they get a
 *     polite decline email.
 *
 * Admin-only. Non-admins get bounced to /me/servicio just like the
 * other admin-only configuration pages (/admin/compartir et al).
 *
 * Linked from the /admin Inicio "Pendientes" panel — the 4th card
 * (Equipos por aprobar) only shows when the count is > 0, so most
 * admins will never see this page exists.
 */

export default function EquiposPendientesPage() {
  const router = useRouter();
  const qc = useQueryClient();

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

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

  const pendingList = useQuery({
    queryKey: ["equipos-pendientes"],
    queryFn: api.listPendingEquipos,
    enabled: isAdmin,
  });

  // We track which row is being acted on so we can disable the
  // buttons individually rather than locking the whole page on every
  // mutation. With multiple pending equipos that matters — admin can
  // approve A while still reading B.
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["equipos-pendientes"] });
    qc.invalidateQueries({ queryKey: ["admin-pendientes"] });
    qc.invalidateQueries({ queryKey: ["servicio"] });
    qc.invalidateQueries({ queryKey: ["servicio-timeline"] });
    qc.invalidateQueries({ queryKey: ["servicio-persons"] });
  };

  const approve = useMutation({
    mutationFn: (tenantId: number) => api.approveEquipo(tenantId),
    onSuccess: refresh,
    onSettled: () => setBusyId(null),
  });

  const decline = useMutation({
    mutationFn: (tenantId: number) => api.declineEquipo(tenantId),
    onSuccess: refresh,
    onSettled: () => setBusyId(null),
  });

  if (me.isLoading || pendingList.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }

  if (me.data && me.data.current_tenant.servicio_id === null) {
    return (
      <>
        <PageHeader title="Equipos por aprobar" />
        <EmptyState
          icon={<Building2 className="h-5 w-5" />}
          title="Sin servicio asignado"
          description={
            "Este equipo no está vinculado a un servicio, así que "
            + "no recibe solicitudes de otros equipos."
          }
        />
      </>
    );
  }

  const items = pendingList.data ?? [];

  return (
    <>
      <PageHeader title="Equipos por aprobar" />
      <p className="-mt-4 mb-6 max-w-2xl text-sm text-gray-600">
        Otros equipos han pedido unirse a tu servicio. Aprueba para
        darles acceso, o rechaza si no corresponde — el solicitante
        recibirá un correo en cualquier caso.
      </p>

      {items.length === 0 ? (
        <EmptyState
          icon={<UserPlus className="h-5 w-5" />}
          title="Nada pendiente"
          description="No hay solicitudes para revisar ahora mismo."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((eq) => (
            <PendingRow
              key={eq.tenant_id}
              equipo={eq}
              busy={busyId === eq.tenant_id}
              onApprove={() => {
                setBusyId(eq.tenant_id);
                approve.mutate(eq.tenant_id);
              }}
              onDecline={() => {
                if (
                  !window.confirm(
                    `¿Rechazar la solicitud de "${eq.tenant_name}"? `
                      + "Se eliminará el equipo y se notificará al "
                      + "solicitante.",
                  )
                ) {
                  return;
                }
                setBusyId(eq.tenant_id);
                decline.mutate(eq.tenant_id);
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function PendingRow({
  equipo,
  busy,
  onApprove,
  onDecline,
}: {
  equipo: PendingEquipo;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const fullName =
    [equipo.admin_first_name, equipo.admin_last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || equipo.admin_name;

  // Created date — keep it terse (DD MMM YYYY) so the row stays
  // compact on mobile.
  const created = new Date(equipo.created_at);
  const createdLabel = created.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <li>
      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-gray-900">
                {equipo.tenant_name}
              </span>
              <StatusPill tone="warning">Pendiente</StatusPill>
            </div>
            <div className="mt-1 text-sm text-gray-600">
              Solicitado por{" "}
              <span className="font-medium text-gray-800">{fullName}</span>
              {" — "}
              <a
                href={`mailto:${equipo.admin_email}`}
                className="text-brand-700 underline-offset-2 hover:underline"
              >
                {equipo.admin_email}
              </a>
            </div>
            <div className="mt-0.5 text-xs text-gray-500">
              Creado el {createdLabel}
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              onClick={onDecline}
              disabled={busy}
            >
              <XCircle className="h-4 w-4" />
              Rechazar
            </Button>
            <Button onClick={onApprove} disabled={busy}>
              <CheckCircle2 className="h-4 w-4" />
              Aprobar
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}

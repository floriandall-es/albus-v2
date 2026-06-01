"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AvailabilityBlock,
  type AvailabilityBlockType,
  type ServicioAdminOption,
} from "@/lib/api";
import { DateRangeField } from "@/components/admin/date-range";
import { EmptyState, StatusPill } from "@/components/admin/ui";
import { CalendarOff, MessageSquare, Plus } from "lucide-react";

const TYPE_LABEL: Record<AvailabilityBlockType, string> = {
  vacation: "Vacaciones",
  sick: "Baja médica",
  training: "Formación",
  personal: "Personal",
  other: "Otro",
};

const STATUS_TONE = {
  pending: "warning",
  approved: "success",
  denied: "danger",
} as const;
const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  denied: "Denegada",
};

export default function BloqueosPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const list = useQuery({
    queryKey: ["my-availability"],
    queryFn: api.listMyAvailabilityRequests,
  });
  const [open, setOpen] = useState(false);
  const del = useMutation({
    mutationFn: (id: number) => api.deleteMyAvailabilityRequest(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-availability"] }),
  });
  // "Comentar" → open (or re-use) an in-context DM with the reviewer
  // this bloqueo was sent to, tagged to the bloqueo. Only offered when
  // a reviewer person is known (reviewer_person_id != null).
  const comment = useMutation({
    mutationFn: (b: AvailabilityBlock) =>
      api.createContextDM({
        peer_person_id: b.reviewer_person_id!,
        context_kind: "bloqueo",
        context_id: b.id,
      }),
    onSuccess: (conv) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      router.push(`/me/mensajes?c=${conv.id}`);
    },
    onError: (err) => {
      // Never fail silently — a swallowed error here read as
      // "Comentar does nothing".
      window.alert(
        (err as Error)?.message
          ?? "No se pudo abrir el chat. Inténtalo de nuevo.",
      );
    },
  });

  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Mis bloqueos
        </h1>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-brand-700"
          onClick={() => setOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Nueva solicitud
        </button>
      </div>

      <p className="mb-4 max-w-2xl text-sm text-gray-600">
        Pide bloqueos (vacaciones, baja, formación…) para días en los que
        no puedes trabajar. El admin revisa y aprueba o rechaza.
      </p>

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.data && list.data.length === 0 && (
        <div className="max-w-2xl">
          <EmptyState
            icon={<CalendarOff className="h-5 w-5" />}
            title="Aún no has pedido bloqueos"
            description="Usa “Nueva solicitud” para reservar días libres."
          />
        </div>
      )}
      {list.data && list.data.length > 0 && (
        <div className="max-w-2xl rounded-xl bg-white shadow-soft ring-1 ring-gray-200">
          <ul className="divide-y divide-gray-100">
            {list.data.map((b: AvailabilityBlock) => {
              const tone =
                STATUS_TONE[b.status as keyof typeof STATUS_TONE]
                ?? "neutral";
              return (
                <li
                  key={b.id}
                  className="p-3 flex items-start justify-between gap-3"
                >
                  <div className="text-sm">
                    <div className="font-medium">
                      {b.start_date} → {b.end_date}{" "}
                      <span className="text-gray-500 font-normal">
                        · {TYPE_LABEL[b.block_type] ?? b.block_type}
                      </span>
                    </div>
                    {b.notes && (
                      <div className="text-xs text-gray-600 mt-0.5">
                        {b.notes}
                      </div>
                    )}
                    {b.reviewer_person_name && (
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        {b.status === "pending" ? "Pendiente de" : "Decidida por"}{" "}
                        <span className="font-medium text-gray-700">
                          {b.reviewer_person_name}
                        </span>
                        {b.reviewer_tenant_name && (
                          <span className="text-gray-400">
                            {" "}· {b.reviewer_tenant_name}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Heads-up to the requester: shifts you'd
                        displace if approved. Helps the member
                        plan ahead (e.g. ask a colleague to swap
                        before the bloqueo is approved). */}
                    {b.conflicting_shifts.length > 0 && (
                      <div className="text-[11px] text-amber-700 mt-0.5">
                        ⚠ Tienes{" "}
                        {b.conflicting_shifts.length}
                        {b.conflicting_shifts_truncated && "+"} turno
                        {b.conflicting_shifts.length === 1 ? "" : "s"}{" "}
                        asignado{b.conflicting_shifts.length === 1 ? "" : "s"}{" "}
                        en este rango — tendrán que re-asignarse si se aprueba.
                      </div>
                    )}
                    {b.status === "denied" && b.review_notes && (
                      <div className="text-xs text-rose-700 mt-0.5">
                        Motivo: {b.review_notes}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill tone={tone}>
                      {STATUS_LABEL[b.status] ?? b.status}
                    </StatusPill>
                    {b.reviewer_person_id != null && (
                      <button
                        className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline disabled:opacity-50"
                        onClick={() => comment.mutate(b)}
                        disabled={
                          comment.isPending && comment.variables?.id === b.id
                        }
                        title={`Comentar con ${b.reviewer_person_name ?? "el revisor"}`}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        {comment.isPending && comment.variables?.id === b.id
                          ? "Abriendo…"
                          : "Comentar"}
                      </button>
                    )}
                    {b.status === "pending" && (
                      <button
                        className="text-xs text-rose-700 hover:underline"
                        onClick={() => del.mutate(b.id)}
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {open && <NewRequestModal onClose={() => setOpen(false)} />}
    </>
  );
}

function NewRequestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [type, setType] = useState<AvailabilityBlockType>("vacation");
  const [notes, setNotes] = useState("");
  // Migration 0083. Required servicio-wide reviewer routing —
  // every new bloqueo must name a specific admin who will review it.
  // Empty string means "not yet picked" (initial render before the
  // picker loads, or a deliberately cleared selection); save is
  // gated on a non-empty value below.
  const [reviewerMembershipId, setReviewerMembershipId] = useState<string>("");
  // Picker source. Cached for the modal's lifetime. Returns
  // { mode, admins } — migration 0085 wrapped the old bare array.
  // When mode === 'centralised' AND a Jefe de Servicio is resolved,
  // `admins` collapses to that single membership and we render a
  // read-only "Se enviará a {jefe}" line instead of the dropdown.
  // When the servicio is centralised but no jefe is in place, the
  // server reports mode='delegated' so the full picker still shows.
  const admins = useQuery({
    queryKey: ["my-servicio-admins"],
    queryFn: api.listMyServicioAdmins,
  });
  const adminList = admins.data?.admins ?? [];
  const isCentralised = admins.data?.mode === "centralised";
  // Auto-default to the first admin (which is sorted to be from
  // the user's own equipo) as soon as the picker resolves — so the
  // common case is one click ("Enviar") rather than two. Only fires
  // when the field is still empty so the user's manual selection
  // isn't overwritten by a refetch. Centralised mode also benefits
  // because the single jefe is the first (and only) entry.
  useEffect(() => {
    if (adminList.length > 0 && reviewerMembershipId === "") {
      setReviewerMembershipId(String(adminList[0].membership_id));
    }
  }, [adminList, reviewerMembershipId]);
  const save = useMutation({
    mutationFn: () =>
      api.createMyAvailabilityRequest({
        start_date: start,
        end_date: end,
        block_type: type,
        notes: notes || null,
        reviewer_membership_id: Number(reviewerMembershipId),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-availability"] });
      onClose();
    },
  });

  // Group admins by tenant for the dropdown's optgroup labels.
  // Own equipo first ("Tu equipo"), then sibling equipos by name.
  // Skipped when centralised since the dropdown is replaced by a
  // read-only line.
  const adminGroups = useAdminGroups(adminList);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Nueva solicitud</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DateRangeField
            startDate={start}
            endDate={end}
            onChange={(s, e) => {
              setStart(s);
              setEnd(e);
            }}
            required
          />
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Tipo</span>
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as AvailabilityBlockType)
              }
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="vacation">Vacaciones</option>
              <option value="sick">Baja médica</option>
              <option value="training">Formación</option>
              <option value="personal">Personal</option>
              <option value="other">Otro</option>
            </select>
          </label>
          {/* Reviewer routing. Migration 0083 introduced the picker;
              migration 0085 added the centralised mode where the
              Jefe de Servicio reviews every bloqueo. The shape
              switches based on `mode` from the server:
                - delegated: full dropdown with optgroups
                - centralised: read-only "Se enviará a X" line,
                  the form still submits the (single) jefe id
                  via the hidden state. */}
          {adminList.length > 0 && isCentralised && (
            <div className="block">
              <span className="block text-sm font-medium text-gray-700">
                Enviar a
              </span>
              <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span className="font-medium">
                  {adminList[0].person_name}
                </span>
                <span className="text-amber-700">
                  {" "}· {adminList[0].tenant_name} · Jefe de Servicio
                </span>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                Tu servicio centraliza las solicitudes de bloqueo en el
                Jefe de Servicio.
              </p>
            </div>
          )}
          {adminList.length > 0 && !isCentralised && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Enviar a
              </span>
              <select
                value={reviewerMembershipId}
                onChange={(e) => setReviewerMembershipId(e.target.value)}
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                {adminGroups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.admins.map((a) => (
                      <option
                        key={a.membership_id}
                        value={String(a.membership_id)}
                      >
                        {a.person_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-gray-500">
                Sólo el admin elegido podrá aprobar o denegar esta
                solicitud.
              </p>
            </label>
          )}
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Notas</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          {save.isError && (
            <p className="text-sm text-red-600">
              {(save.error as Error).message}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              // Required reviewer (migration 0083). Don't let the
              // form submit before the picker query has resolved AND
              // a specific admin is selected — otherwise the
              // request would 422 server-side.
              disabled={save.isPending || !reviewerMembershipId}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {save.isPending ? "Enviando…" : "Enviar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Group servicio admins for the dropdown's <optgroup> structure.
 * Own equipo first under "Tu equipo"; sibling equipos appear under
 * their tenant name. Admins within each group are already pre-
 * sorted by the backend, so we just preserve order. */
function useAdminGroups(
  admins: ServicioAdminOption[],
): { label: string; admins: ServicioAdminOption[] }[] {
  return useMemo(() => {
    if (admins.length === 0) return [];
    const own = admins.filter((a) => a.is_own_tenant);
    const cross = admins.filter((a) => !a.is_own_tenant);
    const groups: { label: string; admins: ServicioAdminOption[] }[] = [];
    if (own.length > 0) {
      groups.push({ label: "Tu equipo", admins: own });
    }
    // Sibling equipos: bucket by tenant_name, preserving the
    // alphabetical order the backend hands us.
    const seen = new Set<string>();
    for (const a of cross) {
      if (seen.has(a.tenant_name)) continue;
      seen.add(a.tenant_name);
      groups.push({
        label: a.tenant_name,
        admins: cross.filter((x) => x.tenant_name === a.tenant_name),
      });
    }
    return groups;
  }, [admins]);
}

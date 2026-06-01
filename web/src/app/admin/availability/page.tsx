"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import {
  api,
  personLastName,
  type AvailabilityBlock,
  type AvailabilityBlockType,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  EmptyState,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  StatusPill,
  TextField,
} from "@/components/admin/ui";
import { DateRangeField } from "@/components/admin/date-range";
import { CalendarOff } from "lucide-react";

const TYPES: { value: AvailabilityBlockType; label: string }[] = [
  { value: "vacation", label: "Vacaciones" },
  { value: "sick", label: "Baja médica" },
  { value: "training", label: "Formación" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Otro" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPES.map((t) => [t.value, t.label]),
);

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

/**
 * "Comentar" on a bloqueo from the admin side. Opens (or re-uses) an
 * in-context DM with the *requester* — `peer_person_id` is the person
 * who asked for the leave — tagged to this bloqueo so the thread shows
 * a "Bloqueo de disponibilidad · Ver →" banner. Jumps to /me/mensajes
 * with the conversation pre-selected.
 */
function useCommentOnBloqueo() {
  const router = useRouter();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AvailabilityBlock) =>
      api.createContextDM({
        peer_person_id: b.person_id,
        context_kind: "bloqueo",
        context_id: b.id,
      }),
    onSuccess: (conv) => {
      // Mark the list stale so the new thread (and its context
      // banner) shows immediately on the mensajes page rather than
      // waiting for the 30s poll tick.
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
}

/** Amber warning listing the shifts a pending bloqueo would displace.
 * Shown in the "Pendientes de aprobar" table (migration 0083 follow-up)
 * — that's where the admin decides, so the heads-up belongs next to
 * Aprobar/Denegar. Renders nothing when there are no conflicts (only
 * pending blocks ever carry them). */
function ConflictNote({ block }: { block: AvailabilityBlock }) {
  const n = block.conflicting_shifts.length;
  if (n === 0) return null;
  return (
    <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
      <div className="font-semibold">
        ⚠ Tiene {n}
        {block.conflicting_shifts_truncated && "+"} turno{n === 1 ? "" : "s"}{" "}
        asignado{n === 1 ? "" : "s"} en este rango
      </div>
      <ul className="mt-0.5 space-y-0.5">
        {block.conflicting_shifts.slice(0, 5).map((s, i) => (
          <li key={`${s.date}-${i}`}>
            <span className="tabular-nums">{s.date}</span>
            {" — "}
            {s.slot_name}
            {s.role_label && (
              <span className="text-amber-700">
                {" · "}
                {s.role_label}
              </span>
            )}
          </li>
        ))}
        {n > 5 && (
          <li className="italic text-amber-700">
            … y {n - 5} más
            {block.conflicting_shifts_truncated && "+"}
          </li>
        )}
      </ul>
      <div className="mt-1 text-[10px] text-amber-700">
        Si apruebas, estos turnos quedarán libres y tendrás que
        reasignarlos manualmente.
      </div>
    </div>
  );
}

export default function AvailabilityPage() {
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const [personId, setPersonId] = useState<number | "">("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [editing, setEditing] = useState<AvailabilityBlock | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    queryKey: ["availability", personId, from, to],
    queryFn: () =>
      api.listAvailabilityBlocks({
        person_id: personId === "" ? undefined : personId,
        from: from || undefined,
        to: to || undefined,
      }),
  });

  const qc = useQueryClient();
  const comment = useCommentOnBloqueo();
  const del = useMutation({
    mutationFn: (id: number) => api.deleteAvailabilityBlock(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["availability"] }),
  });

  return (
    <>
      <PageHeader
        title="Bloqueos de disponibilidad"
        action={
          <Button onClick={() => setAdding(true)}>Añadir bloqueo</Button>
        }
      />
      <PendingApprovals />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px]">
          <Select
            label="Persona"
            value={personId}
            onChange={(v) => setPersonId(v === "" ? "" : Number(v))}
            options={[
              { value: "", label: "— Todas —" },
              ...((team.data ?? [])
                .map((m: TeamMember) => ({
                  value: m.person_id,
                  label: personLastName({ name: m.person_name }),
                })) as { value: number | ""; label: string }[]),
            ]}
          />
        </div>
        <div className="flex-1 min-w-[320px]">
          <DateRangeField
            startDate={from}
            endDate={to}
            onChange={(s, e) => {
              setFrom(s);
              setTo(e);
            }}
          />
        </div>
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.data && list.data.length === 0 && (
        <EmptyState
          icon={<CalendarOff className="h-5 w-5" />}
          title="No hay bloqueos en el rango seleccionado"
          description="Ajusta los filtros o añade un bloqueo nuevo."
          action={
            <Button onClick={() => setAdding(true)}>Añadir bloqueo</Button>
          }
        />
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Persona</th>
                <th className="px-4 py-2 font-medium">Desde</th>
                <th className="px-4 py-2 font-medium">Hasta</th>
                <th className="px-4 py-2 font-medium">Tipo</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Notas</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((b: AvailabilityBlock) => {
                return (
                <tr key={b.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">
                    <div className="flex flex-col leading-tight">
                      <span>{b.person_name}</span>
                      {/* Migration 0083. When the block comes from a
                          sibling equipo (cross-tenant routing via
                          reviewer_membership_id), surface the source
                          equipo so the admin knows this isn't one of
                          their own team's members. */}
                      {b.reviewer_tenant_name && b.tenant_id !== undefined && (
                        <span className="text-[10px] text-gray-500">
                          {b.reviewer_person_name
                            ? `Asignada a ${b.reviewer_person_name}`
                            : null}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2">{b.start_date}</td>
                  <td className="px-4 py-2">{b.end_date}</td>
                  <td className="px-4 py-2">
                    {TYPE_LABEL[b.block_type] ?? b.block_type}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill
                      tone={
                        STATUS_TONE[b.status as keyof typeof STATUS_TONE]
                        ?? "neutral"
                      }
                    >
                      {STATUS_LABEL[b.status] ?? b.status}
                    </StatusPill>
                  </td>
                  {/* Conflict heads-up lives only in the
                      "Pendientes de aprobar" table now (where the
                      admin actually decides) — see ConflictNote. */}
                  <td className="px-4 py-2 text-gray-600">{b.notes ?? "—"}</td>
                  <td className="px-4 py-2">
                    {/* Same flex pattern /admin/slots + /admin/trasplantes
                        use — `text-right space-x-2` was wrapping the
                        two Buttons under each other when the row text
                        got long, leaving them vertically stacked and
                        visually overlapping. `whitespace-nowrap` keeps
                        the buttons on one line; the row grows
                        horizontally to fit instead of breaking. */}
                    <div className="flex justify-end gap-2 whitespace-nowrap">
                      <Button
                        variant="secondary"
                        onClick={() => comment.mutate(b)}
                        disabled={
                          comment.isPending && comment.variables?.id === b.id
                        }
                      >
                        <MessageSquare className="h-4 w-4" />
                        {comment.isPending && comment.variables?.id === b.id
                          ? "Abriendo…"
                          : "Comentar"}
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(b)}>
                        Editar
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => del.mutate(b.id)}
                        disabled={del.isPending}
                      >
                        Eliminar
                      </Button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {(adding || editing) && (
        <BlockModal
          team={team.data ?? []}
          existing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function BlockModal({
  team,
  existing,
  onClose,
}: {
  team: TeamMember[];
  existing: AvailabilityBlock | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [personId, setPersonId] = useState<number | "">(
    existing?.person_id ?? team[0]?.person_id ?? "",
  );
  const [start, setStart] = useState(existing?.start_date ?? "");
  const [end, setEnd] = useState(existing?.end_date ?? "");
  const [type, setType] = useState<AvailabilityBlockType>(
    (existing?.block_type ?? "vacation") as AvailabilityBlockType,
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");

  const save = useMutation({
    mutationFn: () => {
      if (personId === "") throw new Error("Selecciona una persona");
      const body = {
        person_id: Number(personId),
        start_date: start,
        end_date: end,
        block_type: type,
        notes: notes || null,
      };
      return existing
        ? api.updateAvailabilityBlock(existing.id, body)
        : api.createAvailabilityBlock(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["availability"] });
      onClose();
    },
  });

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={existing ? "Editar bloqueo" : "Nuevo bloqueo"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select
          label="Persona"
          value={personId}
          onChange={(v) => setPersonId(v === "" ? "" : Number(v))}
          options={team.map((m) => ({
            value: m.person_id,
            label: personLastName({ name: m.person_name }),
          }))}
        />
        <DateRangeField
          startDate={start}
          endDate={end}
          onChange={(s, e) => {
            setStart(s);
            setEnd(e);
          }}
          required
        />
        <Select
          label="Tipo"
          value={type}
          onChange={(v) => setType(v as AvailabilityBlockType)}
          options={TYPES.map((t) => ({ value: t.value, label: t.label }))}
        />
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Notas</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            rows={3}
          />
        </label>
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PendingApprovals() {
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ["availability", "pending"],
    queryFn: () => api.listAvailabilityBlocks({ status: "pending" }),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api.approveAvailabilityBlock(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["availability"] }),
  });
  const deny = useMutation({
    mutationFn: ({ id, notes }: { id: number; notes: string }) =>
      api.denyAvailabilityBlock(id, notes || null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["availability"] }),
  });
  const comment = useCommentOnBloqueo();

  if (pending.isLoading) return null;
  const rows = pending.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-lg font-semibold">Pendientes de aprobar</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-2 font-medium">Persona</th>
              <th className="px-4 py-2 font-medium">Desde</th>
              <th className="px-4 py-2 font-medium">Hasta</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Notas</th>
              <th className="px-4 py-2 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b: AvailabilityBlock) => {
              return (
              <tr key={b.id} className="border-b last:border-b-0">
                <td className="px-4 py-2">
                  <span>{b.person_name}</span>
                </td>
                <td className="px-4 py-2">{b.start_date}</td>
                <td className="px-4 py-2">{b.end_date}</td>
                <td className="px-4 py-2">
                  {TYPE_LABEL[b.block_type] ?? b.block_type}
                </td>
                <td className="px-4 py-2 text-gray-600">
                  {b.notes ?? "—"}
                  <ConflictNote block={b} />
                </td>
                <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                  <Button
                    variant="secondary"
                    onClick={() => comment.mutate(b)}
                    disabled={
                      comment.isPending && comment.variables?.id === b.id
                    }
                  >
                    <MessageSquare className="h-4 w-4" />
                    {comment.isPending && comment.variables?.id === b.id
                      ? "Abriendo…"
                      : "Comentar"}
                  </Button>
                  <Button
                    onClick={() => approve.mutate(b.id)}
                    disabled={approve.isPending}
                  >
                    Aprobar
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      const notes = window.prompt(
                        "Motivo del rechazo (opcional):",
                        "",
                      );
                      if (notes === null) return; // cancelled
                      deny.mutate({ id: b.id, notes });
                    }}
                    disabled={deny.isPending}
                  >
                    Denegar
                  </Button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AvailabilityBlock,
  type AvailabilityBlockType,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  TextField,
} from "@/components/admin/ui";

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
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Select
          label="Persona"
          value={personId}
          onChange={(v) => setPersonId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "— Todas —" },
            ...((team.data ?? []).map((m: TeamMember) => ({
              value: m.person_id,
              label: m.person_name,
            })) as { value: number | ""; label: string }[]),
          ]}
        />
        <TextField label="Desde" type="date" value={from} onChange={setFrom} />
        <TextField label="Hasta" type="date" value={to} onChange={setTo} />
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.data && list.data.length === 0 && (
        <Empty>No hay bloqueos en el rango seleccionado.</Empty>
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
                <th className="px-4 py-2 font-medium">Notas</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((b: AvailabilityBlock) => (
                <tr key={b.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{b.person_name}</td>
                  <td className="px-4 py-2">{b.start_date}</td>
                  <td className="px-4 py-2">{b.end_date}</td>
                  <td className="px-4 py-2">
                    {TYPE_LABEL[b.block_type] ?? b.block_type}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{b.notes ?? "—"}</td>
                  <td className="px-4 py-2 text-right space-x-2">
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
                  </td>
                </tr>
              ))}
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
          options={team.map((m) => ({ value: m.person_id, label: m.person_name }))}
        />
        <TextField label="Desde" type="date" value={start} onChange={setStart} />
        <TextField label="Hasta" type="date" value={end} onChange={setEnd} />
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

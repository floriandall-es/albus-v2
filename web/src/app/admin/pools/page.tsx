"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MembershipMode, type Pool, type TeamMember } from "@/lib/api";
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

const MODE_OPTIONS: { value: MembershipMode; label: string }[] = [
  { value: "dedicated", label: "Dedicado" },
  { value: "rotational", label: "Rotacional" },
  { value: "mixed", label: "Mixto" },
];

export default function PoolsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["pools"], queryFn: api.listPools });
  const [editing, setEditing] = useState<Pool | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deletePool(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pools"] }),
  });

  return (
    <>
      <PageHeader
        title="Unidades"
        action={<Button onClick={() => setEditing("new")}>Nueva unidad</Button>}
      />
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay unidades.</Empty>}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Modo</th>
                <th className="px-4 py-2 font-medium">Equidad propia</th>
                <th className="px-4 py-2 font-medium">Miembros</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2 capitalize">{p.membership_mode}</td>
                  <td className="px-4 py-2">{p.equity_independent ? "Sí" : "No"}</td>
                  <td className="px-4 py-2">{p.member_count}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(p)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`¿Eliminar unidad "${p.name}"?`)) del.mutate(p.id);
                      }}
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
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <PoolDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function PoolDialog({ initial, onClose }: { initial: Pool | null; onClose: () => void }) {
  const qc = useQueryClient();
  // Tracks the pool we're working with. Starts as `initial` (null for create);
  // after a successful create we promote it to the returned Pool so the same
  // dialog flips into "edit" mode and the member picker appears.
  const [currentPool, setCurrentPool] = useState<Pool | null>(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [mode, setMode] = useState<MembershipMode>(initial?.membership_mode ?? "dedicated");
  const [equityIndep, setEquityIndep] = useState<boolean>(
    initial?.equity_independent ?? true,
  );

  const detail = useQuery({
    queryKey: ["pool", currentPool?.id],
    queryFn: () => (currentPool ? api.getPool(currentPool.id) : Promise.resolve(null)),
    enabled: !!currentPool,
  });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  const save = useMutation({
    mutationFn: () => {
      const body = { name, membership_mode: mode, equity_independent: equityIndep };
      return currentPool
        ? api.updatePool(currentPool.id, body)
        : api.createPool(body);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["pools"] });
      // Promote the freshly-created (or just-saved) pool into edit mode so the
      // user can immediately add members without re-opening the dialog.
      setCurrentPool(data);
    },
  });

  const addMember = useMutation({
    mutationFn: (person_id: number) =>
      api.addPoolMember(currentPool!.id, person_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pool", currentPool?.id] });
      qc.invalidateQueries({ queryKey: ["pools"] });
    },
  });
  const removeMember = useMutation({
    mutationFn: (person_id: number) =>
      api.removePoolMember(currentPool!.id, person_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pool", currentPool?.id] });
      qc.invalidateQueries({ queryKey: ["pools"] });
    },
  });

  const memberIds = new Set((detail.data?.members ?? []).map((m) => m.person_id));
  const candidates: TeamMember[] = (team.data ?? []).filter(
    (t) => !memberIds.has(t.person_id),
  );

  const isNew = !currentPool;

  return (
    <Modal open={true} onClose={onClose} title={isNew ? "Nueva unidad" : "Editar unidad"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Nombre" value={name} onChange={setName} required />
        <Select
          label="Modo de pertenencia"
          value={mode}
          onChange={(v) => v && setMode(v as MembershipMode)}
          options={MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={equityIndep}
            onChange={(e) => setEquityIndep(e.target.checked)}
          />
          Equidad propia (esta unidad se reparte sus turnos por separado)
        </label>
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        {!isNew && save.isSuccess && (
          <p className="text-xs text-green-700">Cambios guardados.</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {isNew ? "Cancelar" : "Cerrar"}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending
              ? "Guardando…"
              : isNew
                ? "Crear"
                : "Guardar"}
          </Button>
        </div>
      </form>

      {currentPool && (
        <div className="mt-6 border-t pt-4">
          <h3 className="text-sm font-semibold mb-2">Miembros</h3>
          {detail.isLoading && <p className="text-xs text-gray-500">Cargando…</p>}
          {detail.data && detail.data.members.length === 0 && (
            <p className="text-xs text-gray-500">Aún sin miembros.</p>
          )}
          <ul className="space-y-1 mb-3">
            {detail.data?.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between text-sm">
                <span>
                  {m.person_name}{" "}
                  <span className="text-gray-500">({m.person_email})</span>
                </span>
                <button
                  type="button"
                  className="text-xs text-red-700 hover:underline"
                  onClick={() => removeMember.mutate(m.person_id)}
                >
                  Quitar
                </button>
              </li>
            ))}
          </ul>
          {candidates.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v) addMember.mutate(v);
                  e.currentTarget.value = "";
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  Añadir miembro…
                </option>
                {candidates.map((c) => (
                  <option key={c.person_id} value={c.person_id}>
                    {c.person_name} ({c.person_email})
                  </option>
                ))}
              </select>
            </div>
          )}
          {addMember.isError && (
            <ErrorText>{(addMember.error as Error).message}</ErrorText>
          )}
          {removeMember.isError && (
            <ErrorText>{(removeMember.error as Error).message}</ErrorText>
          )}
        </div>
      )}
    </Modal>
  );
}

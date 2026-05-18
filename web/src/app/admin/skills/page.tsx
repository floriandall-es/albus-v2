"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Skill } from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  InfoHint,
  Modal,
  PageHeader,
  TextField,
} from "@/components/admin/ui";

export default function SkillsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["skills"], queryFn: api.listSkills });
  const [editing, setEditing] = useState<Skill | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteSkill(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });

  return (
    <>
      <PageHeader
        title={
          <>
            Competencias
            <InfoHint position="below">
              Habilidades específicas que un turno puede requerir
              (ecografía, laparoscopia, neonatos…). Asigna competencias
              a las personas y márcalas como necesarias en los turnos
              que las requieran; el solver solo asignará a quien las
              tenga.
            </InfoHint>
          </>
        }
        action={<Button onClick={() => setEditing("new")}>Nueva competencia</Button>}
      />

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay competencias.</Empty>}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Descripción</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">{s.name}</td>
                  <td className="px-4 py-2 text-gray-600">{s.description ?? ""}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(s)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`¿Eliminar competencia "${s.name}"?`)) del.mutate(s.id);
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
        <SkillDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function SkillDialog({ initial, onClose }: { initial: Skill | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description === "" ? null : description };
      return initial ? api.updateSkill(initial.id, body) : api.createSkill(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      onClose();
    },
  });

  return (
    <Modal open={true} onClose={onClose} title={initial ? "Editar competencia" : "Nueva competencia"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Nombre" value={name} onChange={setName} required />
        <TextField label="Descripción" value={description} onChange={setDescription} />
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
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

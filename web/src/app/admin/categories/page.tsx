"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Category } from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  TextField,
} from "@/components/admin/ui";

export default function CategoriesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const [editing, setEditing] = useState<Category | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteCategory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  return (
    <>
      <PageHeader
        title="Categorías"
        action={<Button onClick={() => setEditing("new")}>Nueva categoría</Button>}
      />

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && (
        <Empty>Aún no hay categorías. Crea la primera.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Nivel</th>
                <th className="px-4 py-2 font-medium">Descripción</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{c.name}</td>
                  <td className="px-4 py-2">{c.level ?? "—"}</td>
                  <td className="px-4 py-2 text-gray-600">{c.description ?? ""}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(c)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`¿Eliminar categoría "${c.name}"?`)) del.mutate(c.id);
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
        <CategoryDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function CategoryDialog({
  initial,
  onClose,
}: {
  initial: Category | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [level, setLevel] = useState<string>(initial?.level?.toString() ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        level: level === "" ? null : Number(level),
        description: description === "" ? null : description,
      };
      return initial ? api.updateCategory(initial.id, body) : api.createCategory(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      onClose();
    },
  });

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar categoría" : "Nueva categoría"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Nombre" value={name} onChange={setName} required />
        <TextField
          label="Nivel (más bajo = más senior, opcional)"
          value={level}
          onChange={setLevel}
          type="number"
        />
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

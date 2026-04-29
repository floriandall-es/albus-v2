"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, ErrorText, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";

const DEFAULTS = [
  "Jefe de servicio",
  "Adjunto",
  "Residente R5",
  "Residente R4",
  "Residente R3",
];

export default function CategoriesStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (n: string) => api.createCategory({ name: n }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteCategory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  const existingNames = new Set((list.data ?? []).map((c) => c.name));
  const missingDefaults = DEFAULTS.filter((d) => !existingNames.has(d));

  async function addAllDefaults() {
    for (const d of missingDefaults) {
      // Sequential — keeps the UI strictly correct and the network volume is tiny.
      // eslint-disable-next-line no-await-in-loop
      await create.mutateAsync(d);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 1 — Categorías</h2>
      <p className="text-sm text-gray-600 mb-6">
        Las categorías describen los niveles de tu equipo (Adjunto, Residente, etc.).
        Las usaremos más adelante para asignar slots y calcular equidad.
      </p>

      {missingDefaults.length > 0 && (
        <div className="mb-4 rounded-md border bg-amber-50 p-3 text-sm">
          <p className="mb-2 text-amber-900">¿Quieres usar los valores predefinidos?</p>
          <ul className="text-xs text-amber-900 mb-2 list-disc pl-5">
            {missingDefaults.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <Button onClick={addAllDefaults} disabled={create.isPending}>
            Añadir todos los predefinidos
          </Button>
        </div>
      )}

      <form
        className="flex gap-2 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            create.mutate(name.trim());
            setName("");
          }
        }}
      >
        <div className="flex-1">
          <TextField label="" value={name} onChange={setName} placeholder="Nombre de la categoría" />
        </div>
        <div className="self-end">
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Añadir
          </Button>
        </div>
      </form>
      {create.isError && <ErrorText>{(create.error as Error).message}</ErrorText>}

      <ul className="rounded-md border bg-white divide-y">
        {(list.data ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span>{c.name}</span>
            <button
              className="text-xs text-red-600 underline"
              onClick={() => del.mutate(c.id)}
            >
              Eliminar
            </button>
          </li>
        ))}
        {(list.data ?? []).length === 0 && (
          <li className="px-4 py-3 text-sm text-gray-500">Aún no hay categorías.</li>
        )}
      </ul>

      <StepNav currentSlug="categories" />
    </div>
  );
}

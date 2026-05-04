"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Category } from "@/lib/api";
import { Button, ErrorText, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";

// Common roles across Spanish hospital departments, grouped so the
// checklist stays scannable. Each row toggles independently — admins
// keep what applies to their service, drop what doesn't, and add custom
// ones at the bottom.
const DEFAULT_GROUPS: { title: string; items: string[] }[] = [
  {
    title: "Médicos",
    items: [
      "Jefe de servicio",
      "Jefe de sección",
      "Adjunto",
      "Residente R5",
      "Residente R4",
      "Residente R3",
      "Residente R2",
      "Residente R1",
    ],
  },
  {
    title: "Enfermería",
    items: [
      "Supervisor/a de enfermería",
      "Enfermero/a",
      "Auxiliar de enfermería (TCAE)",
      "Matrona",
    ],
  },
  {
    title: "Otros",
    items: [
      "Técnico (laboratorio / radiología)",
      "Celador/a",
      "Administrativo/a",
    ],
  },
];

const ALL_DEFAULTS = new Set(DEFAULT_GROUPS.flatMap((g) => g.items));

export default function CategoriesStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const [customName, setCustomName] = useState("");

  const create = useMutation({
    mutationFn: (n: string) => api.createCategory({ name: n }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteCategory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  const existing: Category[] = list.data ?? [];
  const byName = new Map(existing.map((c) => [c.name, c]));
  const customCategories = existing.filter((c) => !ALL_DEFAULTS.has(c.name));

  async function toggleDefault(name: string, checked: boolean) {
    if (checked) {
      await create.mutateAsync(name);
    } else {
      const cat = byName.get(name);
      if (cat) await del.mutateAsync(cat.id);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 1 — Categorías</h2>
      <p className="text-sm text-gray-600 mb-6">
        Las categorías describen los niveles de tu equipo. Las usaremos más adelante
        para asignar turnos y calcular equidad. Marca las que apliquen a tu
        servicio y añade las que falten.
      </p>

      <div className="rounded-md border bg-white mb-4 divide-y">
        {DEFAULT_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="px-4 py-2 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-600">
              {group.title}
            </div>
            <ul className="divide-y">
              {group.items.map((d) => {
                const checked = byName.has(d);
                const isPending =
                  (create.isPending && create.variables === d) ||
                  (del.isPending && del.variables === byName.get(d)?.id);
                return (
                  <li key={d} className="flex items-center px-4 py-2 text-sm">
                    <input
                      type="checkbox"
                      id={`cat-${d}`}
                      className="mr-3 h-4 w-4"
                      checked={checked}
                      disabled={isPending}
                      onChange={(e) => toggleDefault(d, e.target.checked)}
                    />
                    <label htmlFor={`cat-${d}`} className="flex-1 cursor-pointer">
                      {d}
                    </label>
                    {isPending && (
                      <span className="text-xs text-gray-400">guardando…</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="rounded-md border bg-white mb-4">
        <div className="px-4 py-2 border-b bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-600">
          Otras categorías
        </div>
        {customCategories.length === 0 && (
          <p className="px-4 py-3 text-sm text-gray-500">
            Aún no has añadido categorías personalizadas.
          </p>
        )}
        {customCategories.length > 0 && (
          <ul className="divide-y">
            {customCategories.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>{c.name}</span>
                <button
                  type="button"
                  className="text-xs text-red-600 underline"
                  onClick={() => del.mutate(c.id)}
                  disabled={del.isPending}
                >
                  Eliminar
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2 px-4 py-3 border-t"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = customName.trim();
            if (!trimmed) return;
            create.mutate(trimmed);
            setCustomName("");
          }}
        >
          <div className="flex-1">
            <TextField
              label=""
              value={customName}
              onChange={setCustomName}
              placeholder="Ej. Farmacéutico/a, Fisioterapeuta, Becario…"
            />
          </div>
          <div className="self-end">
            <Button type="submit" disabled={!customName.trim() || create.isPending}>
              Añadir
            </Button>
          </div>
        </form>
      </div>

      {create.isError && <ErrorText>{(create.error as Error).message}</ErrorText>}
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      <StepNav currentSlug="categories" />
    </div>
  );
}

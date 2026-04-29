"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, ErrorText, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";

export default function SkillsStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["skills"], queryFn: api.listSkills });
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (n: string) => api.createSkill({ name: n }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteSkill(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 2 — Skills</h2>
      <p className="text-sm text-gray-600 mb-6">
        Añade habilidades clave de tu equipo (ej. Cirugía mínimamente invasiva,
        Trasplante…). Puedes saltar este paso si todos hacen lo mismo.
      </p>

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
          <TextField label="" value={name} onChange={setName} placeholder="Nombre de la skill" />
        </div>
        <div className="self-end">
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Añadir
          </Button>
        </div>
      </form>
      {create.isError && <ErrorText>{(create.error as Error).message}</ErrorText>}

      <ul className="rounded-md border bg-white divide-y">
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span>{s.name}</span>
            <button
              className="text-xs text-red-600 underline"
              onClick={() => del.mutate(s.id)}
            >
              Eliminar
            </button>
          </li>
        ))}
        {(list.data ?? []).length === 0 && (
          <li className="px-4 py-3 text-sm text-gray-500">Aún no hay skills.</li>
        )}
      </ul>

      <StepNav currentSlug="skills" />
    </div>
  );
}

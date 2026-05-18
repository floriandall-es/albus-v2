"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MembershipMode } from "@/lib/api";
import { Button, ErrorText, Select, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";

export default function PoolsStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["pools"], queryFn: api.listPools });
  const [hasSubteams, setHasSubteams] = useState<"yes" | "no" | null>(null);

  const [name, setName] = useState("");
  const [mode, setMode] = useState<MembershipMode>("dedicated");

  const create = useMutation({
    mutationFn: () =>
      api.createPool({
        name,
        membership_mode: mode,
        equity_independent: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pools"] });
      setName("");
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deletePool(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pools"] }),
  });

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 4 — Unidades</h2>
      <p className="text-sm text-gray-600 mb-6">
        ¿Tu servicio se divide en unidades? (ej. REA, Trasplantes). Si todo el equipo
        funciona como una sola unidad, puedes saltar este paso.
      </p>

      <div className="flex gap-2 mb-6">
        <Button
          variant={hasSubteams === "yes" ? "primary" : "secondary"}
          onClick={() => setHasSubteams("yes")}
        >
          Sí, tiene varias unidades
        </Button>
        <Button
          variant={hasSubteams === "no" ? "primary" : "secondary"}
          onClick={() => setHasSubteams("no")}
        >
          No, todo el equipo es una sola unidad
        </Button>
      </div>

      {hasSubteams === "yes" && (
        <>
          <form
            className="grid grid-cols-[1fr_auto_auto] gap-2 mb-4 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <TextField label="Nombre de la unidad" value={name} onChange={setName} />
            <Select<MembershipMode>
              label="Modo"
              value={mode}
              onChange={(v) => v && setMode(v as MembershipMode)}
              options={[
                { value: "dedicated", label: "Dedicado" },
                { value: "rotational", label: "Rotacional" },
                { value: "mixed", label: "Mixto" },
              ]}
            />
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Añadir
            </Button>
          </form>
          {create.isError && <ErrorText>{(create.error as Error).message}</ErrorText>}

          <ul className="rounded-md border bg-white divide-y">
            {(list.data ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>
                  {p.name}{" "}
                  <span className="text-xs text-gray-500">({p.membership_mode})</span>
                </span>
                <button
                  className="text-xs text-red-600 underline"
                  onClick={() => del.mutate(p.id)}
                >
                  Eliminar
                </button>
              </li>
            ))}
            {(list.data ?? []).length === 0 && (
              <li className="px-4 py-3 text-sm text-gray-500">Aún no hay unidades.</li>
            )}
          </ul>
        </>
      )}

      {hasSubteams === "no" && (
        <p className="text-sm text-gray-600">
          Perfecto — no necesitas crear unidades. Pulsa Siguiente.
        </p>
      )}

      <StepNav currentSlug="pools" />
    </div>
  );
}

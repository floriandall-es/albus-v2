"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DaysApplied, type StaffingMode } from "@/lib/api";
import { Button, ErrorText, Select, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";

export default function SlotsStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });

  const [name, setName] = useState("");
  const [days, setDays] = useState<DaysApplied>("all");
  const [mode, setMode] = useState<StaffingMode>("single");
  const [headcount, setHeadcount] = useState("1");

  const create = useMutation({
    mutationFn: () =>
      api.createSlot({
        name,
        days_applied: days,
        staffing_mode: mode,
        headcount: mode === "multiple_same" ? Math.max(1, Number(headcount)) : 1,
        post_slot_rest: false,
        counts_for_equity: true,
        team_roles: [],
        skills_required: [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      setName("");
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteSlot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 4 — Turnos</h2>
      <p className="text-sm text-gray-600 mb-6">
        Define los turnos típicos de tu día (Mañana, Guardia 24h, etc.). Para
        configuraciones avanzadas (composición de equipo, competencias requeridas)
        usa la sección de Turnos en Admin después.
      </p>

      <form
        className="space-y-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <TextField label="Nombre del turno" value={name} onChange={setName} />
        <div className="grid grid-cols-2 gap-3">
          <Select<DaysApplied>
            label="Días"
            value={days}
            onChange={(v) => v && setDays(v as DaysApplied)}
            options={[
              { value: "all", label: "Todos los días" },
              { value: "weekdays", label: "Días laborables" },
              { value: "weekends_holidays", label: "Fines de semana y festivos" },
              { value: "custom", label: "Personalizado" },
            ]}
          />
          <Select<StaffingMode>
            label="Modo de staffing"
            value={mode}
            onChange={(v) => v && setMode(v as StaffingMode)}
            options={[
              { value: "single", label: "Una persona" },
              { value: "multiple_same", label: "Varias personas (mismo rol)" },
            ]}
          />
        </div>
        {mode === "multiple_same" && (
          <TextField
            label="Número de personas"
            type="number"
            value={headcount}
            onChange={setHeadcount}
          />
        )}
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          Añadir turno
        </Button>
        {create.isError && <ErrorText>{(create.error as Error).message}</ErrorText>}
      </form>

      <ul className="rounded-md border bg-white divide-y">
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span>
              {s.name}{" "}
              <span className="text-xs text-gray-500">
                ({s.days_applied} · {s.staffing_mode}
                {s.headcount > 1 ? ` × ${s.headcount}` : ""})
              </span>
            </span>
            <button
              className="text-xs text-red-600 underline"
              onClick={() => del.mutate(s.id)}
            >
              Eliminar
            </button>
          </li>
        ))}
        {(list.data ?? []).length === 0 && (
          <li className="px-4 py-3 text-sm text-gray-500">Aún no hay turnos.</li>
        )}
      </ul>

      <StepNav currentSlug="slots" />
    </div>
  );
}

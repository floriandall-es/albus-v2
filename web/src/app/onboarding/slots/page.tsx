"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type DaysApplied,
  type Slot,
  type SlotInput,
  type StaffingMode,
} from "@/lib/api";
import { Button, ErrorText, Select, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";

// Quick-pick templates grouped by typical use. Times follow Spanish
// hospital convention (8h windows). Ticking creates the corresponding
// Slot row; unticking deletes it. Admins can fine-tune the slot via
// /admin/slots after the wizard if they need to adjust headcount,
// post-shift rest, team composition, etc.
type TemplateSlot = Pick<
  SlotInput,
  | "name"
  | "start_time"
  | "end_time"
  | "days_applied"
  | "staffing_mode"
  | "headcount"
  | "post_slot_rest"
  | "counts_for_equity"
>;

// Single flat list of actividades habituales for a Spanish hospital
// service. Times are sensible defaults; admins can edit each slot
// inline below or fine-tune later in /admin/slots (headcount,
// post-guardia rest, team composition, etc.). The list is
// intentionally broad — admins tick the ones their service does
// and leave the rest unchecked.
const SLOT_TEMPLATES: { items: TemplateSlot[] } = {
  items: [
    {
      name: "Guardia presencial",
      start_time: "08:00:00",
      end_time: "08:00:00",
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: true,
      counts_for_equity: true,
    },
    {
      name: "Guardia localizada",
      start_time: null,
      end_time: null,
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Consulta",
      start_time: "08:00:00",
      end_time: "14:00:00",
      days_applied: "weekdays",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Quirófano programado",
      start_time: "08:00:00",
      end_time: "15:00:00",
      days_applied: "weekdays",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Quirófano urgente",
      start_time: "08:00:00",
      end_time: "20:00:00",
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Planta",
      start_time: "08:00:00",
      end_time: "15:00:00",
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Urgencias",
      start_time: "08:00:00",
      end_time: "08:00:00",
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: true,
      counts_for_equity: true,
    },
    {
      name: "UCI",
      start_time: "08:00:00",
      end_time: "15:00:00",
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Trasplante",
      start_time: null,
      end_time: null,
      days_applied: "all",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: true,
      counts_for_equity: true,
    },
    {
      name: "Hospital de día",
      start_time: "08:00:00",
      end_time: "15:00:00",
      days_applied: "weekdays",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Interconsulta",
      start_time: "08:00:00",
      end_time: "15:00:00",
      days_applied: "weekdays",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
    {
      name: "Pruebas / técnicas",
      start_time: "08:00:00",
      end_time: "15:00:00",
      days_applied: "weekdays",
      staffing_mode: "single",
      headcount: 1,
      post_slot_rest: false,
      counts_for_equity: true,
    },
  ],
};

const ALL_TEMPLATE_NAMES = new Set(SLOT_TEMPLATES.items.map((i) => i.name));

function formatTimeRange(s: Slot): string {
  if (!s.start_time || !s.end_time) return "sin horario";
  const fmt = (t: string) => t.slice(0, 5);
  return `${fmt(s.start_time)}–${fmt(s.end_time)}${s.crosses_midnight ? " (+1d)" : ""}`;
}

export default function SlotsStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });

  // Manual form state.
  const [name, setName] = useState("");
  const [days, setDays] = useState<DaysApplied>("all");
  const [mode, setMode] = useState<StaffingMode>("single");
  const [headcount, setHeadcount] = useState("1");

  const createTemplate = useMutation({
    mutationFn: (t: TemplateSlot) =>
      api.createSlot({
        ...t,
        team_roles: [],
        allowed_person_ids: [],
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });

  const createCustom = useMutation({
    mutationFn: () =>
      api.createSlot({
        name,
        days_applied: days,
        staffing_mode: mode,
        headcount: mode === "multiple_same" ? Math.max(1, Number(headcount)) : 1,
        post_slot_rest: false,
        counts_for_equity: true,
        team_roles: [],
        allowed_person_ids: [],
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

  const existing: Slot[] = list.data ?? [];
  const byName = new Map(existing.map((s) => [s.name, s]));
  const customSlots = existing.filter((s) => !ALL_TEMPLATE_NAMES.has(s.name));

  async function toggleTemplate(template: TemplateSlot, checked: boolean) {
    if (checked) {
      // Skip if a slot with this exact name already exists; the API would
      // reject it with 409 otherwise (slot create isn't idempotent yet).
      if (!byName.has(template.name)) {
        await createTemplate.mutateAsync(template);
      }
    } else {
      const slot = byName.get(template.name);
      if (slot) await del.mutateAsync(slot.id);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 3 — Actividades</h2>
      <p className="text-sm text-gray-600 mb-3">
        Define las actividades típicas de tu servicio. Marca las habituales y/o
        añade las tuyas abajo. Por defecto cada actividad se asigna
        automáticamente, repartiendo el reparto equitativamente entre el
        equipo.
      </p>
      <p className="text-xs text-gray-500 mb-6">
        ¿Necesitas rotaciones, días fijos o asignación manual? Termina la
        configuración básica aquí y luego edita cada actividad en{" "}
        <strong>Admin → Actividades</strong>: cada actividad admite reglas
        distintas para diferentes días de la semana (p. ej. rotación L–J +
        asignación automática los fines de semana). También puedes ajustar
        composición de equipo, descanso post-guardia y grupo de equidad.
      </p>

      <div className="rounded-md border bg-white mb-4">
        <ul className="divide-y">
          {SLOT_TEMPLATES.items.map((t) => {
            const existingSlot = byName.get(t.name);
            const checked = !!existingSlot;
            const isPending =
              (createTemplate.isPending && createTemplate.variables?.name === t.name) ||
              (del.isPending && del.variables === existingSlot?.id);
            const subtitle =
              t.start_time && t.end_time
                ? `${t.start_time.slice(0, 5)}–${t.end_time.slice(0, 5)}`
                : "sin horario fijo";
            return (
              <li key={t.name} className="px-4 py-2 text-sm">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id={`slot-${t.name}`}
                    className="mr-3 h-4 w-4"
                    checked={checked}
                    disabled={isPending}
                    onChange={(e) => toggleTemplate(t, e.target.checked)}
                  />
                  <label
                    htmlFor={`slot-${t.name}`}
                    className="flex-1 cursor-pointer"
                  >
                    {t.name}{" "}
                    <span className="text-xs text-gray-500">({subtitle})</span>
                  </label>
                  {isPending && (
                    <span className="text-xs text-gray-400">guardando…</span>
                  )}
                </div>
                {existingSlot && (
                  <SlotInlineEditor slot={existingSlot} />
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rounded-md border bg-white mb-4">
        <div className="px-4 py-2 border-b bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-600">
          Otras actividades
        </div>
        {customSlots.length === 0 && (
          <p className="px-4 py-3 text-sm text-gray-500">
            Aún no has añadido actividades personalizadas.
          </p>
        )}
        {customSlots.length > 0 && (
          <ul className="divide-y">
            {customSlots.map((s) => {
              const isPending = del.isPending && del.variables === s.id;
              return (
                <li key={s.id} className="px-4 py-2 text-sm">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id={`slot-custom-${s.id}`}
                      className="mr-3 h-4 w-4"
                      checked
                      disabled={isPending}
                      onChange={(e) => {
                        if (!e.target.checked) del.mutate(s.id);
                      }}
                    />
                    <label
                      htmlFor={`slot-custom-${s.id}`}
                      className="flex-1 cursor-pointer"
                    >
                      {s.name}{" "}
                      <span className="text-xs text-gray-500">
                        ({formatTimeRange(s)})
                      </span>
                    </label>
                    {isPending && (
                      <span className="text-xs text-gray-400">guardando…</span>
                    )}
                  </div>
                  <SlotInlineEditor slot={s} />
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="space-y-3 px-4 py-3 border-t"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createCustom.mutate();
          }}
        >
          <TextField label="Nombre de la actividad" value={name} onChange={setName} />
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
          <Button type="submit" disabled={!name.trim() || createCustom.isPending}>
            Añadir actividad
          </Button>
        </form>
      </div>

      {createTemplate.isError && (
        <ErrorText>{(createTemplate.error as Error).message}</ErrorText>
      )}
      {createCustom.isError && (
        <ErrorText>{(createCustom.error as Error).message}</ErrorText>
      )}
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      <StepNav currentSlug="slots" />
    </div>
  );
}

function SlotInlineEditor({ slot }: { slot: Slot }) {
  // Inline editors for the most-used slot fields. Auto-save on change.
  // The full editor (team composition, skills, equity group, post-rest)
  // lives in /admin/slots — this is just enough to avoid making admins
  // leave the wizard for the common case of "Mañana but only laborables"
  // or "Mañana with 4 people".
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (body: Partial<SlotInput>) => api.updateSlot(slot.id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });

  return (
    <div className="ml-7 mt-2 grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
      <Select<DaysApplied>
        label="Días"
        value={slot.days_applied}
        onChange={(v) =>
          v && update.mutate({ days_applied: v as DaysApplied })
        }
        options={[
          { value: "all", label: "Todos los días" },
          { value: "weekdays", label: "Días laborables" },
          { value: "weekends_holidays", label: "Findes y festivos" },
          { value: "custom", label: "Personalizado" },
        ]}
      />
      <Select<StaffingMode>
        label="Modo"
        value={slot.staffing_mode}
        onChange={(v) =>
          v && update.mutate({ staffing_mode: v as StaffingMode })
        }
        options={[
          { value: "single", label: "Una persona" },
          { value: "multiple_same", label: "Varias (mismo perfil)" },
          { value: "team_composition", label: "Equipo" },
        ]}
      />
      {slot.staffing_mode === "multiple_same" ? (
        <input
          type="number"
          min={1}
          value={slot.headcount}
          onChange={(e) => {
            const n = Math.max(1, Number(e.target.value) || 1);
            update.mutate({ headcount: n });
          }}
          className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
          aria-label="Personas"
        />
      ) : (
        <span />
      )}
    </div>
  );
}

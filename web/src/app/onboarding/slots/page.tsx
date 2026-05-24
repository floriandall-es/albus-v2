"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Info, Layers, Plus } from "lucide-react";
import {
  api,
  type Slot,
  type SlotInput,
} from "@/lib/api";
import { Button, ErrorText, TextField } from "@/components/admin/ui";
import { StepNav } from "../_nav";
import { StepHeader } from "../_step-header";

// Quick-pick templates. Onboarding intentionally only asks "which
// activities exist?" — días, horario, equipo and reglas are all
// configured later in /admin/slots + /admin/rules. Keeping the
// wizard a single decision per row makes it fast to walk through
// and prevents getting stuck because you don't know the times yet.
type TemplateSlot = Pick<
  SlotInput,
  | "name"
  | "start_time"
  | "end_time"
  | "days_applied"
  | "staffing_mode"
  | "headcount"
  | "counts_for_equity"
>;

// Single flat list of actividades habituales for a Spanish hospital
// service. Defaults are deliberately bland — no horario, todos los
// días, single occupant. Each service does these activities very
// differently (Consulta might be L–V mañanas in one place, lunes
// solo en otro), so pre-baking times would be wrong more often than
// not. Admins tick the ones their service does and set the horario
// inline below the checkbox if it matters; otherwise the activity
// runs "todos los días, sin horario fijo" which is the safest
// no-information default.
const TEMPLATE_NAMES = [
  "Guardia presencial",
  "Guardia localizada",
  "Consulta",
  "Quirófano programado",
  "Quirófano urgente",
  "Planta",
  "Urgencias",
  "UCI",
  "Trasplante",
  "Hospital de día",
  "Interconsulta",
  "Pruebas / técnicas",
];

const SLOT_TEMPLATES: { items: TemplateSlot[] } = {
  items: TEMPLATE_NAMES.map((name) => ({
    name,
    start_time: null,
    end_time: null,
    days_applied: "all",
    staffing_mode: "single",
    headcount: 1,
    counts_for_equity: true,
  })),
};

const ALL_TEMPLATE_NAMES = new Set(SLOT_TEMPLATES.items.map((i) => i.name));

export default function SlotsStep() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["slots"], queryFn: () => api.listSlots() });
  // Used to surface the sub-equipo note: when the tenant has
  // sub-teams, we want admins to know that this step is about
  // the MAIN team's activities — the sub-team lead will pick
  // their own later from /lead/actividades.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const hasSubteams = me.data?.current_tenant.has_subteams === true;

  // Manual form state. Custom slots get the same minimal defaults
  // as the template ones: no horario, todos los días, una persona.
  // The admin tweaks days/hours/team-composition later in
  // /admin/slots once they want to.
  const [name, setName] = useState("");

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
        days_applied: "all",
        staffing_mode: "single",
        headcount: 1,
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
      <StepHeader
        icon={Clock}
        title="Paso 3 — Actividades"
        subtitle={
          hasSubteams
            ? "Marca las actividades del equipo principal. El líder de cada sub-equipo configurará las suyas más tarde."
            : "Marca las que se hacen en tu servicio. Cada actividad se asigna luego automáticamente y de forma equitativa."
        }
      />

      {hasSubteams && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 flex items-start gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-amber-700 ring-1 ring-amber-200 shrink-0">
            <Layers className="h-4 w-4" />
          </span>
          <p className="text-sm text-amber-900/80 leading-relaxed">
            <strong>Sólo equipo principal.</strong> Las actividades
            de los sub-equipos (residentes, becarios) las añade
            cada líder desde <strong>Sub-equipo → Actividades</strong>
            cuando entre por primera vez.
          </p>
        </div>
      )}

      <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50/60 p-4 flex items-start gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-brand-700 ring-1 ring-brand-200 shrink-0">
          <Info className="h-4 w-4" />
        </span>
        <p className="text-sm text-brand-900/80 leading-relaxed">
          De momento sólo seleccionamos los nombres de las
          actividades. Los días, el horario, la composición de
          equipo y las reglas (rotación, días fijos, asignación
          manual…) se configuran después en{" "}
          <strong>Admin → Actividades</strong> y{" "}
          <strong>Admin → Reglas</strong>.
        </p>
      </div>

      <div className="mb-4 rounded-xl border border-gray-200 bg-white shadow-soft overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/60 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Habituales
        </div>
        <ul className="divide-y divide-gray-100">
          {SLOT_TEMPLATES.items.map((t) => {
            const existingSlot = byName.get(t.name);
            const checked = !!existingSlot;
            const isPending =
              (createTemplate.isPending && createTemplate.variables?.name === t.name) ||
              (del.isPending && del.variables === existingSlot?.id);
            return (
              <li
                key={t.name}
                className={
                  "px-4 py-2.5 text-sm transition-colors "
                  + (checked ? "bg-brand-50/40" : "hover:bg-gray-50/60")
                }
              >
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id={`slot-${t.name}`}
                    className="mr-3 h-4 w-4 accent-brand-600"
                    checked={checked}
                    disabled={isPending}
                    onChange={(e) => toggleTemplate(t, e.target.checked)}
                  />
                  <label
                    htmlFor={`slot-${t.name}`}
                    className={
                      "flex-1 cursor-pointer "
                      + (checked
                        ? "font-medium text-gray-900"
                        : "text-gray-800")
                    }
                  >
                    {t.name}
                  </label>
                  {isPending && (
                    <span className="text-xs text-gray-400">guardando…</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mb-4 rounded-xl border border-gray-200 bg-white shadow-soft overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/60 text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
          <Plus className="h-3.5 w-3.5 text-brand-600" />
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
                      {s.name}
                    </label>
                    {isPending && (
                      <span className="text-xs text-gray-400">guardando…</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="flex items-end gap-2 px-4 py-3 border-t"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createCustom.mutate();
          }}
        >
          <div className="flex-1">
            <TextField
              label="Nombre de la actividad"
              value={name}
              onChange={setName}
              placeholder="ej. Comité de tumores"
            />
          </div>
          <Button
            type="submit"
            disabled={!name.trim() || createCustom.isPending}
          >
            Añadir
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


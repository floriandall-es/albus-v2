"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Info, Plus } from "lucide-react";
import {
  api,
  type DaysApplied,
  type Slot,
  type SlotInput,
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
  const list = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });

  // Manual form state. Custom slots are created as "una persona" by
  // default; the staffing mode picker lives in the inline editor that
  // appears under each ticked / created row (it shows all three modes,
  // including team_composition which has its own role-definition UI).
  const [name, setName] = useState("");
  const [days, setDays] = useState<DaysApplied>("all");
  // Bitmap: bit 0 = Lunes … bit 6 = Domingo. Only sent to the server
  // when days === "custom"; ignored otherwise. Same convention as
  // /admin/slots so the rule editor and this form stay in sync.
  const [customDaysBitmap, setCustomDaysBitmap] = useState<number>(0);

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
        custom_days_bitmap: days === "custom" ? customDaysBitmap : null,
        staffing_mode: "single",
        headcount: 1,
        counts_for_equity: true,
        team_roles: [],
        allowed_person_ids: [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      setName("");
      setCustomDaysBitmap(0);
    },
  });

  // The submit button is disabled when "Personalizado" is chosen but
  // no day is ticked — saving an empty bitmap would create a slot
  // that never runs.
  const customDaysMissing = days === "custom" && customDaysBitmap === 0;

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
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700 shrink-0">
          <Clock className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">
            Paso 3 — Actividades
          </h2>
          <p className="text-sm text-gray-600">
            Marca las que se hacen en tu servicio. Cada actividad se
            asigna luego automáticamente y de forma equitativa.
          </p>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50/60 p-4 flex items-start gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-brand-700 ring-1 ring-brand-200 shrink-0">
          <Info className="h-4 w-4" />
        </span>
        <p className="text-sm text-brand-900/80 leading-relaxed">
          ¿Necesitas rotaciones, días fijos o asignación manual?
          Termina la configuración básica aquí y luego edita cada
          actividad en <strong>Admin → Actividades</strong>: cada
          una admite reglas distintas por día de la semana
          (p. ej. rotación L–J + asignación automática los fines
          de semana), composición de equipo y grupo de equidad.
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
                {existingSlot && (
                  <SlotInlineEditor slot={existingSlot} />
                )}
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
          {days === "custom" && (
            <WeekdayPicker
              value={customDaysBitmap}
              onChange={setCustomDaysBitmap}
            />
          )}
          <Button
            type="submit"
            disabled={
              !name.trim() || createCustom.isPending || customDaysMissing
            }
          >
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

  // Horario mode is derived from whether the slot has times set on
  // the server. We keep a local copy so a user who picks
  // "Personalizado" but hasn't yet entered the times sees the input
  // fields immediately (instead of waiting for the first onChange
  // to round-trip through the server).
  const serverScheduleMode: "all_day" | "ranged" =
    slot.start_time && slot.end_time ? "ranged" : "all_day";
  const [scheduleMode, setScheduleMode] = useState<"all_day" | "ranged">(
    serverScheduleMode,
  );
  // Local edits for the time inputs. Start blank when the slot has no
  // horario yet — committing them only happens once both are filled.
  const [startTime, setStartTime] = useState<string>(
    slot.start_time ? slot.start_time.slice(0, 5) : "",
  );
  const [endTime, setEndTime] = useState<string>(
    slot.end_time ? slot.end_time.slice(0, 5) : "",
  );

  // Commit a complete (start, end) pair to the server. Empty values
  // mean the user is still typing — don't save half a horario.
  const commitTimes = (s: string, e: string) => {
    if (!s || !e) return;
    update.mutate({ start_time: `${s}:00`, end_time: `${e}:00` });
  };

  return (
    <div className="ml-7 mt-2 space-y-2">
      <div className="max-w-md grid grid-cols-2 gap-2">
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
        <Select<"all_day" | "ranged">
          label="Horario"
          value={scheduleMode}
          onChange={(v) => {
            if (!v) return;
            const next = v as "all_day" | "ranged";
            setScheduleMode(next);
            // Switching back to "todo el día" clears the times on
            // the server. Switching to "personalizado" doesn't save
            // anything until the user fills both inputs — that's
            // handled by commitTimes below.
            if (next === "all_day") {
              setStartTime("");
              setEndTime("");
              if (slot.start_time || slot.end_time) {
                update.mutate({ start_time: null, end_time: null });
              }
            }
          }}
          options={[
            { value: "all_day", label: "Todo el día" },
            { value: "ranged", label: "Personalizado" },
          ]}
        />
      </div>
      {scheduleMode === "ranged" && (
        <div className="max-w-md grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Desde</span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => {
                const v = e.target.value;
                setStartTime(v);
                commitTimes(v, endTime);
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Hasta</span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => {
                const v = e.target.value;
                setEndTime(v);
                commitTimes(startTime, v);
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      )}
      {slot.days_applied === "custom" && (
        <WeekdayPicker
          value={slot.custom_days_bitmap ?? 0}
          onChange={(bm) => update.mutate({ custom_days_bitmap: bm })}
        />
      )}
    </div>
  );
}

// Small reusable weekday-toggle row. Bit 0 = Lunes … bit 6 = Domingo,
// matching the convention used by /admin/slots and the back-end
// `Slot.custom_days_bitmap` column. Renders inline (no label header
// — the surrounding context tells you what you're picking days for)
// and warns when nothing is selected so the slot isn't quietly
// configured to never run.
const ONBOARDING_DAY_LABELS: { bit: number; short: string; long: string }[] = [
  { bit: 0, short: "L", long: "Lunes" },
  { bit: 1, short: "M", long: "Martes" },
  { bit: 2, short: "X", long: "Miércoles" },
  { bit: 3, short: "J", long: "Jueves" },
  { bit: 4, short: "V", long: "Viernes" },
  { bit: 5, short: "S", long: "Sábado" },
  { bit: 6, short: "D", long: "Domingo" },
];

function WeekdayPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const toggle = (bit: number) => {
    const mask = 1 << bit;
    onChange(value & mask ? value & ~mask : value | mask);
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {ONBOARDING_DAY_LABELS.map(({ bit, short, long }) => {
          const active = (value & (1 << bit)) !== 0;
          return (
            <button
              key={bit}
              type="button"
              onClick={() => toggle(bit)}
              aria-pressed={active}
              title={long}
              className={
                "flex h-9 w-9 items-center justify-center rounded-md border text-sm font-medium transition "
                + (active
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50")
              }
            >
              {short}
            </button>
          );
        })}
      </div>
      {value === 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Selecciona al menos un día.
        </p>
      )}
    </div>
  );
}

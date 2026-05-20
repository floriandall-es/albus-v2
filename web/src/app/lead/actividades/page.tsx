"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Slot,
  type SlotInput,
  type DaysApplied,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  TextField,
} from "@/components/admin/ui";

/**
 * Sub-team lead's activity list. Deliberately stripped down vs.
 * /admin/slots — leads don't deal with:
 *   - team_composition mode (their slots are always single or
 *     multiple_same headcount)
 *   - rules (their slots are manual-only; the default rule
 *     created by the server uses strategy="manual")
 *   - equity / categories / sub-equipo selectors (their group
 *     is implicit; counts_for_equity defaults to true and isn't
 *     surfaced)
 *   - the allow-list picker (lead's slots are auto-restricted to
 *     their group via the server-side filter — opening eligibility
 *     wider would require tenant-admin access anyway)
 *
 * What they DO control: name, horario, days of week, number of
 * plazas. That's enough to model "Guardia residentes", "Sesión
 * clínica", etc.
 */

const DAYS: { value: DaysApplied; label: string }[] = [
  { value: "all", label: "Todos los días" },
  { value: "weekdays", label: "Días laborables" },
  { value: "weekends_holidays", label: "Fines de semana / festivos" },
  { value: "custom", label: "Personalizado" },
];

const DAY_LABELS: { bit: number; short: string }[] = [
  { bit: 0, short: "L" },
  { bit: 1, short: "M" },
  { bit: 2, short: "X" },
  { bit: 3, short: "J" },
  { bit: 4, short: "V" },
  { bit: 5, short: "S" },
  { bit: 6, short: "D" },
];

export default function LeadActividadesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const [editing, setEditing] = useState<Slot | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteSlot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });

  return (
    <>
      <PageHeader
        title="Actividades"
        action={<Button onClick={() => setEditing("new")}>Nueva actividad</Button>}
      />
      <p className="-mt-4 mb-6 text-sm text-gray-600">
        Define los turnos que hace tu sub-equipo (guardias,
        sesiones, consultas…). Más adelante asignas a tu equipo a
        cada día en Planificación.
      </p>

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && (
        <Empty>Aún no hay actividades.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Horario</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Plazas</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors"
                >
                  <td className="px-4 py-2 font-medium text-gray-900">
                    {s.name}
                  </td>
                  <td className="px-4 py-2">
                    {s.start_time && s.end_time ? (
                      `${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}${s.crosses_midnight ? " (+1d)" : ""}`
                    ) : (
                      <span className="text-gray-500">Todo el día</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {labelForDays(s.days_applied, s.custom_days_bitmap)}
                  </td>
                  <td className="px-4 py-2">{s.headcount}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(s)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (
                          confirm(`¿Eliminar actividad "${s.name}"?`)
                        ) {
                          del.mutate(s.id);
                        }
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

      {editing && (
        <ActivityDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function labelForDays(days: DaysApplied, bitmap: number | null): string {
  if (days === "all") return "Todos";
  if (days === "weekdays") return "L–V";
  if (days === "weekends_holidays") return "Fines de semana / festivos";
  if (days === "custom") {
    return DAY_LABELS.map((d) =>
      (bitmap ?? 0) & (1 << d.bit) ? d.short : "·",
    ).join(" ");
  }
  return days;
}

function ActivityDialog({
  initial,
  onClose,
}: {
  initial: Slot | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [startTime, setStartTime] = useState(
    initial?.start_time?.slice(0, 5) ?? "",
  );
  const [endTime, setEndTime] = useState(initial?.end_time?.slice(0, 5) ?? "");
  const [scheduleMode, setScheduleMode] = useState<"ranged" | "all_day">(
    initial?.start_time && initial?.end_time ? "ranged" : "all_day",
  );
  const [days, setDays] = useState<DaysApplied>(initial?.days_applied ?? "all");
  const [customDaysBitmap, setCustomDaysBitmap] = useState<number>(
    initial?.custom_days_bitmap ?? 0,
  );
  const [headcount, setHeadcount] = useState<string>(
    initial?.headcount?.toString() ?? "1",
  );

  const save = useMutation({
    mutationFn: async () => {
      const body: SlotInput = {
        name,
        days_applied: days,
        custom_days_bitmap: days === "custom" ? customDaysBitmap : null,
        // Leads always use the simple staffing model — no team
        // composition. headcount is the only knob.
        staffing_mode: "multiple_same",
        headcount: Math.max(1, Number(headcount) || 1),
        counts_for_equity: true,
        team_roles: [],
        allowed_person_ids: [],
        // group_id is set server-side from the lead's scope; we
        // don't send it from here (and the server would reject
        // a mismatched value anyway).
        start_time:
          scheduleMode === "ranged" && startTime ? `${startTime}:00` : null,
        end_time:
          scheduleMode === "ranged" && endTime ? `${endTime}:00` : null,
      };
      return initial
        ? api.updateSlot(initial.id, body)
        : api.createSlot(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      onClose();
    },
  });

  function toggleDay(bit: number) {
    setCustomDaysBitmap((cur) => cur ^ (1 << bit));
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar actividad" : "Nueva actividad"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          placeholder="Ej. Guardia residentes"
          required
        />

        <div>
          <span className="text-sm font-medium text-gray-700">Horario</span>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={scheduleMode === "ranged"}
                onChange={() => setScheduleMode("ranged")}
              />
              Horario específico
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={scheduleMode === "all_day"}
                onChange={() => setScheduleMode("all_day")}
              />
              Todo el día / sin hora fija
            </label>
          </div>
          {scheduleMode === "ranged" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <TextField
                label="Desde"
                type="time"
                value={startTime}
                onChange={setStartTime}
              />
              <TextField
                label="Hasta"
                type="time"
                value={endTime}
                onChange={setEndTime}
              />
            </div>
          )}
        </div>

        <Select
          label="Días"
          value={days}
          onChange={(v) => v && setDays(v as DaysApplied)}
          options={DAYS.map((d) => ({ value: d.value, label: d.label }))}
        />

        {days === "custom" && (
          <div>
            <span className="text-xs font-medium text-gray-700">
              Selecciona los días
            </span>
            <div className="mt-1 flex gap-1.5">
              {DAY_LABELS.map(({ bit, short }) => {
                const active = (customDaysBitmap & (1 << bit)) !== 0;
                return (
                  <button
                    key={bit}
                    type="button"
                    onClick={() => toggleDay(bit)}
                    className={
                      "h-9 w-9 rounded-lg border text-sm font-semibold transition-colors "
                      + (active
                        ? "border-brand-500 bg-brand-100 text-brand-700"
                        : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50")
                    }
                  >
                    {short}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <TextField
          label="Plazas"
          hint="Cuántas personas se necesitan cada día para cubrir esta actividad."
          type="number"
          value={headcount}
          onChange={setHeadcount}
        />

        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending || !name.trim()}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

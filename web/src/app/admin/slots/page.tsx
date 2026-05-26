"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type DaysApplied,
  type Slot,
  type StaffingMode,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  PageHeader,
} from "@/components/admin/ui";
import { SetupBanner } from "@/components/admin/SetupBanner";
import { SlotDialog } from "@/components/admin/SlotDialog";

const DAYS: { value: DaysApplied; label: string }[] = [
  { value: "all", label: "Todos los días" },
  { value: "weekdays", label: "Días laborables" },
  { value: "weekends_holidays", label: "Fines de semana / festivos" },
  { value: "custom", label: "Personalizado" },
];

const STAFFING: { value: StaffingMode; label: string }[] = [
  { value: "single", label: "Una persona" },
  { value: "multiple_same", label: "Varias del mismo perfil" },
  { value: "team_composition", label: "Equipo (varios roles)" },
];

// Mirror of the DAY_LABELS table used inside SlotDialog. Kept local
// here because the list view's "custom days" column expands the
// bitmap into short letters — a feature unique to the table.
const DAY_LABELS_SHORT: { bit: number; short: string }[] = [
  { bit: 0, short: "L" },
  { bit: 1, short: "M" },
  { bit: 2, short: "X" },
  { bit: 3, short: "J" },
  { bit: 4, short: "V" },
  { bit: 5, short: "S" },
  { bit: 6, short: "D" },
];

export default function SlotsPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["slots"],
    queryFn: () => api.listSlots(),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const [editing, setEditing] = useState<Slot | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteSlot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });
  // Sprint 17: admin-controlled ordering. The endpoint returns
  // the full reordered list (across the whole tenant). The
  // active query here is filtered to main-team only, and other
  // pages may use the unfiltered ["slots"] key — invalidate the
  // prefix so every variant refetches with fresh positions
  // rather than chosing the wrong cache shape via setQueryData.
  const move = useMutation({
    mutationFn: ({ id, direction }: { id: number; direction: "up" | "down" }) =>
      api.moveSlot(id, direction),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      // The planning grid also needs the new positions next time it
      // refetches the schedule (slot_position is on Assignment now).
      qc.invalidateQueries({ queryKey: ["schedule"] });
    },
  });

  return (
    <>
      <PageHeader
        title="Actividades"
        action={<Button onClick={() => setEditing("new")}>Nueva actividad</Button>}
      />
      <SetupBanner
        area="activities"
        title="Define las actividades de tu servicio"
        description="Cada actividad es un tipo de turno: consulta, guardia, quirófano, planta. Para cada una eliges nombre, horario, qué días aplica y cómo se reparte (automática, rotación, días fijos o manual). Una misma actividad puede tener varias reglas para grupos de días distintos (p. ej. automática de lunes a viernes y rotación los fines de semana) y dividirse en varias posiciones cuando necesita más de una persona con rol distinto (p. ej. Cirujano 1 + Cirujano 2 dentro de Quirófano)."
      />
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay actividades.</Empty>}
      {list.data && list.data.length > 0 && (() => {
        // Only show the #id suffix when two slots share a name — keeps the
        // list clean while still letting admins distinguish duplicates.
        const nameCounts = new Map<string, number>();
        for (const s of list.data) {
          nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
        }
        return (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Horario</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Modo</th>
                <th className="px-4 py-2 font-medium">Plazas</th>
                <th className="px-4 py-2 font-medium">Equipo autorizado</th>
                <th className="px-4 py-2 font-medium">Orden</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s, idx) => (
                <tr key={s.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {s.name}
                    {(nameCounts.get(s.name) ?? 0) > 1 && (
                      <span className="ml-1 text-xs text-gray-400">#{s.id}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {s.start_time && s.end_time ? (
                      `${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}${s.crosses_midnight ? " (+1d)" : ""}`
                    ) : (
                      <span className="text-gray-500">Todo el día</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {(() => {
                      // For "custom" expand the bitmap into the
                      // selected short day letters (e.g. "L M J")
                      // — readable at a glance and matches the
                      // picker the admin used. For the other
                      // presets fall back to the Spanish label
                      // already defined in DAYS.
                      if (
                        s.days_applied === "custom"
                        && typeof s.custom_days_bitmap === "number"
                      ) {
                        const bits = s.custom_days_bitmap;
                        const picked = DAY_LABELS_SHORT
                          .filter((d) => (bits & (1 << d.bit)) !== 0)
                          .map((d) => d.short)
                          .join(" ");
                        return picked || "—";
                      }
                      return (
                        DAYS.find((d) => d.value === s.days_applied)?.label
                        ?? s.days_applied
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {STAFFING.find((m) => m.value === s.staffing_mode)?.label
                      ?? s.staffing_mode}
                  </td>
                  <td className="px-4 py-2">
                    {s.staffing_mode === "single"
                      ? 1
                      : s.staffing_mode === "team_composition"
                        ? s.team_roles.reduce((a, r) => a + r.headcount, 0)
                          || s.headcount
                        : s.headcount}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {s.allowed_person_ids.length === 0 ? (
                      <span className="text-gray-400">Todo el equipo</span>
                    ) : (
                      <span>{s.allowed_person_ids.length} personas</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        aria-label="Subir"
                        title="Subir"
                        disabled={idx === 0 || move.isPending}
                        onClick={() => move.mutate({ id: s.id, direction: "up" })}
                        className="h-6 w-6 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="Bajar"
                        title="Bajar"
                        disabled={
                          idx === (list.data?.length ?? 0) - 1
                          || move.isPending
                        }
                        onClick={() => move.mutate({ id: s.id, direction: "down" })}
                        className="h-6 w-6 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        ↓
                      </button>
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2 whitespace-nowrap">
                      <Button variant="secondary" onClick={() => setEditing(s)}>
                        Editar
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (confirm(`¿Eliminar actividad "${s.name}"?`)) del.mutate(s.id);
                        }}
                      >
                        Eliminar
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        );
      })()}

      {editing && (
        <SlotDialog
          mode="default"
          initial={editing === "new" ? null : editing}
          categories={cats.data ?? []}
          team={team.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

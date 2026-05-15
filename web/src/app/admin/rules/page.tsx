"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type DependencySeverity,
  type FrequencyPeriod,
  type Slot,
  type SlotFrequencyCap,
  type SlotSuccessionRule,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  NumberField,
  PageHeader,
  Select,
} from "@/components/admin/ui";

const PERIOD_LABEL: Record<FrequencyPeriod, string> = {
  rolling_7: "Móvil 7 días",
  rolling_14: "Móvil 14 días",
  rolling_28: "Móvil 28 días",
  iso_week: "Semana ISO",
  calendar_month: "Mes natural",
};

const SEVERITY_LABEL: Record<DependencySeverity, string> = {
  hard: "Estricta",
  soft: "Blanda",
};

export default function RulesPage() {
  const slots = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const slotById = useMemo(() => {
    const m: Record<number, Slot> = {};
    (slots.data ?? []).forEach((s) => {
      m[s.id] = s;
    });
    return m;
  }, [slots.data]);

  return (
    <>
      <PageHeader title="Reglas" />
      <p className="-mt-4 mb-6 text-sm text-gray-600">
        Incompatibilidades del mismo día, sucesión entre turnos y límites de
        frecuencia por persona.
      </p>
      <SameDaySection slots={slots.data ?? []} slotById={slotById} />
      <div className="h-8" />
      <SuccessionSection slots={slots.data ?? []} slotById={slotById} />
      <div className="h-8" />
      <FrequencySection slots={slots.data ?? []} slotById={slotById} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Succession rules
// ---------------------------------------------------------------------------

function SuccessionSection({
  slots,
  slotById,
}: {
  slots: Slot[];
  slotById: Record<number, Slot>;
}) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["succession-rules"],
    queryFn: api.listSuccessionRules,
  });
  const [editing, setEditing] = useState<SlotSuccessionRule | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => api.deleteSuccessionRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["succession-rules"] }),
  });

  // Same data table, but the days_after=0 rows belong to the
  // "Incompatibilidades del mismo día" section above. Filter them out
  // here so each section shows only its own rule type.
  const successionRules = (list.data ?? []).filter((r) => r.days_after >= 1);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Sucesión de turnos</h2>
        <Button onClick={() => setEditing("new")}>+ Añadir regla</Button>
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && successionRules.length === 0 && (
        <Empty>Aún no hay reglas de sucesión.</Empty>
      )}
      {successionRules.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Después de</th>
                <th className="px-4 py-2 font-medium">No se puede</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Aplica a</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Peso</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {successionRules.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {slotById[r.after_slot_id]?.name ?? `#${r.after_slot_id}`}
                  </td>
                  <td className="px-4 py-2">
                    {slotById[r.forbid_slot_id]?.name ?? `#${r.forbid_slot_id}`}
                  </td>
                  <td className="px-4 py-2">{r.days_after}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {r.applies_to === "same_person" ? "Misma persona" : "Equipo"}
                  </td>
                  <td className="px-4 py-2">{SEVERITY_LABEL[r.severity]}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {r.severity === "soft" ? r.weight : "—"}
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(r)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm("¿Eliminar esta regla?")) del.mutate(r.id);
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
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <SuccessionDialog
          initial={editing === "new" ? null : editing}
          slots={slots}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function SuccessionDialog({
  initial,
  slots,
  onClose,
}: {
  initial: SlotSuccessionRule | null;
  slots: Slot[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [afterSlotId, setAfterSlotId] = useState<number | "">(
    initial?.after_slot_id ?? "",
  );
  const [forbidSlotId, setForbidSlotId] = useState<number | "">(
    initial?.forbid_slot_id ?? "",
  );
  const [daysAfter, setDaysAfter] = useState<number>(initial?.days_after ?? 1);
  const [severity, setSeverity] = useState<DependencySeverity>(
    initial?.severity ?? "hard",
  );
  const [weight, setWeight] = useState<number>(initial?.weight ?? 5);

  const save = useMutation({
    mutationFn: () => {
      if (initial) {
        return api.updateSuccessionRule(initial.id, {
          days_after: daysAfter,
          severity,
          weight,
        });
      }
      if (afterSlotId === "" || forbidSlotId === "") {
        throw new Error("Selecciona los turnos");
      }
      return api.createSuccessionRule({
        after_slot_id: afterSlotId,
        forbid_slot_id: forbidSlotId,
        days_after: daysAfter,
        applies_to: "same_person",
        severity,
        weight,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["succession-rules"] });
      onClose();
    },
  });

  const slotOptions = slots.map((s) => ({ value: s.id, label: s.name }));

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar regla de sucesión" : "Nueva regla de sucesión"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select
          label="Después del turno"
          value={afterSlotId}
          onChange={(v) => setAfterSlotId(v === "" ? "" : Number(v))}
          options={[{ value: "", label: "—" }, ...slotOptions]}
        />
        <Select
          label="No se puede asignar"
          value={forbidSlotId}
          onChange={(v) => setForbidSlotId(v === "" ? "" : Number(v))}
          options={[{ value: "", label: "—" }, ...slotOptions]}
        />
        <NumberField
          label="Durante (días, 1-14)"
          value={daysAfter}
          onChange={(v) => setDaysAfter(typeof v === "number" ? v : 1)}
          min={1}
          max={14}
        />
        <Select
          label="Aplica a"
          value="same_person"
          onChange={() => {
            /* whole_team disabled in v1 */
          }}
          options={[
            { value: "same_person", label: "Misma persona" },
            { value: "whole_team", label: "Todo el equipo (próximamente)" },
          ]}
        />
        <Select
          label="Severidad"
          value={severity}
          onChange={(v) => setSeverity((v || "hard") as DependencySeverity)}
          options={[
            { value: "hard", label: SEVERITY_LABEL.hard },
            { value: "soft", label: SEVERITY_LABEL.soft },
          ]}
        />
        {severity === "soft" && (
          <NumberField
            label="Peso (penalización en blandas)"
            value={weight}
            onChange={(v) => setWeight(typeof v === "number" ? v : 5)}
            min={0}
            max={1000}
          />
        )}
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Frequency caps
// ---------------------------------------------------------------------------

function FrequencySection({
  slots,
  slotById,
}: {
  slots: Slot[];
  slotById: Record<number, Slot>;
}) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["frequency-caps"],
    queryFn: api.listFrequencyCaps,
  });
  const [editing, setEditing] = useState<SlotFrequencyCap | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => api.deleteFrequencyCap(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["frequency-caps"] }),
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Límites de frecuencia</h2>
        <Button onClick={() => setEditing("new")}>+ Añadir límite</Button>
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && (
        <Empty>Aún no hay límites de frecuencia.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Turno</th>
                <th className="px-4 py-2 font-medium">Periodo</th>
                <th className="px-4 py-2 font-medium">Máx por persona</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Peso</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {slotById[c.slot_id]?.name ?? `#${c.slot_id}`}
                  </td>
                  <td className="px-4 py-2">{PERIOD_LABEL[c.period]}</td>
                  <td className="px-4 py-2">{c.max_count}</td>
                  <td className="px-4 py-2">{SEVERITY_LABEL[c.severity]}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {c.severity === "soft" ? c.weight : "—"}
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(c)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm("¿Eliminar este límite?")) del.mutate(c.id);
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
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <FrequencyDialog
          initial={editing === "new" ? null : editing}
          slots={slots}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function FrequencyDialog({
  initial,
  slots,
  onClose,
}: {
  initial: SlotFrequencyCap | null;
  slots: Slot[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [slotId, setSlotId] = useState<number | "">(initial?.slot_id ?? "");
  const [period, setPeriod] = useState<FrequencyPeriod>(
    initial?.period ?? "rolling_7",
  );
  const [maxCount, setMaxCount] = useState<number>(initial?.max_count ?? 1);
  const [severity, setSeverity] = useState<DependencySeverity>(
    initial?.severity ?? "hard",
  );
  const [weight, setWeight] = useState<number>(initial?.weight ?? 5);

  const save = useMutation({
    mutationFn: () => {
      if (initial) {
        return api.updateFrequencyCap(initial.id, {
          max_count: maxCount,
          severity,
          weight,
        });
      }
      if (slotId === "") throw new Error("Selecciona un turno");
      return api.createFrequencyCap({
        slot_id: slotId,
        period,
        max_count: maxCount,
        severity,
        weight,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["frequency-caps"] });
      onClose();
    },
  });

  const slotOptions = slots.map((s) => ({ value: s.id, label: s.name }));

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar límite" : "Nuevo límite de frecuencia"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {!initial && (
          <Select
            label="Turno"
            value={slotId}
            onChange={(v) => setSlotId(v === "" ? "" : Number(v))}
            options={[{ value: "", label: "—" }, ...slotOptions]}
          />
        )}
        {!initial && (
          <Select
            label="Periodo"
            value={period}
            onChange={(v) => setPeriod((v || "rolling_7") as FrequencyPeriod)}
            options={(
              [
                "rolling_7",
                "rolling_14",
                "rolling_28",
                "iso_week",
                "calendar_month",
              ] as FrequencyPeriod[]
            ).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
          />
        )}
        <NumberField
          label="Máximo por persona"
          value={maxCount}
          onChange={(v) => setMaxCount(typeof v === "number" ? v : 0)}
          min={0}
          max={1000}
        />
        <Select
          label="Severidad"
          value={severity}
          onChange={(v) => setSeverity((v || "hard") as DependencySeverity)}
          options={[
            { value: "hard", label: SEVERITY_LABEL.hard },
            { value: "soft", label: SEVERITY_LABEL.soft },
          ]}
        />
        {severity === "soft" && (
          <NumberField
            label="Peso (penalización en blandas)"
            value={weight}
            onChange={(v) => setWeight(typeof v === "number" ? v : 5)}
            min={0}
            max={1000}
          />
        )}
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Same-day incompatibility — succession rules with days_after = 0.
// Surfaces as a distinct rule type because the UX is simpler (no day
// count, no "next-day" semantics) and the use case is conceptually
// different ("these two slots can't both happen on the same day for the
// same person").
// ---------------------------------------------------------------------------

function SameDaySection({
  slots,
  slotById,
}: {
  slots: Slot[];
  slotById: Record<number, Slot>;
}) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["succession-rules"],
    queryFn: api.listSuccessionRules,
  });
  const [editing, setEditing] = useState<SlotSuccessionRule | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => api.deleteSuccessionRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["succession-rules"] }),
  });

  const sameDay = (list.data ?? []).filter((r) => r.days_after === 0);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">
          Incompatibilidades del mismo día
        </h2>
        <Button onClick={() => setEditing("new")}>+ Añadir regla</Button>
      </div>
      <p className="-mt-2 mb-3 text-xs text-gray-500">
        Dos turnos que no pueden coincidir el mismo día para la misma persona,
        aunque sus horarios no se solapen. (Para conflictos de horario solapado
        no necesitas regla — el solver los detecta automáticamente.)
      </p>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && sameDay.length === 0 && (
        <Empty>Aún no hay incompatibilidades del mismo día.</Empty>
      )}
      {sameDay.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Turno</th>
                <th className="px-4 py-2 font-medium">No se puede combinar con</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Peso</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sameDay.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {slotById[r.after_slot_id]?.name ?? `#${r.after_slot_id}`}
                  </td>
                  <td className="px-4 py-2">
                    {slotById[r.forbid_slot_id]?.name ?? `#${r.forbid_slot_id}`}
                  </td>
                  <td className="px-4 py-2">{SEVERITY_LABEL[r.severity]}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {r.severity === "soft" ? r.weight : "—"}
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(r)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm("¿Eliminar esta incompatibilidad?"))
                          del.mutate(r.id);
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
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <SameDayDialog
          initial={editing === "new" ? null : editing}
          slots={slots}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function SameDayDialog({
  initial,
  slots,
  onClose,
}: {
  initial: SlotSuccessionRule | null;
  slots: Slot[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [afterSlotId, setAfterSlotId] = useState<number | "">(
    initial?.after_slot_id ?? "",
  );
  const [forbidSlotId, setForbidSlotId] = useState<number | "">(
    initial?.forbid_slot_id ?? "",
  );
  const [severity, setSeverity] = useState<DependencySeverity>(
    initial?.severity ?? "hard",
  );
  const [weight, setWeight] = useState<number>(initial?.weight ?? 5);

  const save = useMutation({
    mutationFn: () => {
      if (initial) {
        return api.updateSuccessionRule(initial.id, {
          days_after: 0,
          severity,
          weight,
        });
      }
      if (afterSlotId === "" || forbidSlotId === "") {
        throw new Error("Selecciona los dos turnos");
      }
      if (afterSlotId === forbidSlotId) {
        throw new Error("Los dos turnos deben ser diferentes");
      }
      return api.createSuccessionRule({
        after_slot_id: afterSlotId,
        forbid_slot_id: forbidSlotId,
        days_after: 0,
        applies_to: "same_person",
        severity,
        weight,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["succession-rules"] });
      onClose();
    },
  });

  const slotOptions = slots.map((s) => ({ value: s.id, label: s.name }));

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={
        initial
          ? "Editar incompatibilidad del mismo día"
          : "Nueva incompatibilidad del mismo día"
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select
          label="Turno"
          value={afterSlotId}
          onChange={(v) => setAfterSlotId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "Selecciona un turno" },
            ...slotOptions,
          ]}
        />
        <Select
          label="No se puede combinar con"
          value={forbidSlotId}
          onChange={(v) => setForbidSlotId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "Selecciona un turno" },
            ...slotOptions,
          ]}
        />
        <Select
          label="Severidad"
          value={severity}
          onChange={(v) => v && setSeverity(v as DependencySeverity)}
          options={[
            { value: "hard", label: "Estricta (el solver no lo permitirá)" },
            { value: "soft", label: "Blanda (penaliza, pero permite)" },
          ]}
        />
        {severity === "soft" && (
          <NumberField
            label="Peso de la penalización"
            value={weight}
            onChange={(v) => setWeight(typeof v === "number" ? v : 5)}
            min={0}
            max={1000}
          />
        )}
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

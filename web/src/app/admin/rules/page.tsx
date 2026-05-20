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
  Empty,
  ErrorText,
  InfoHint,
  Modal,
  NumberField,
  PageHeader,
  Select,
} from "@/components/admin/ui";
import { SetupBanner } from "@/components/admin/SetupBanner";

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

/**
 * Three-tier picker for soft-rule weight. Replaces a 0–1000
 * NumberField that admins had no way to calibrate. The tier values
 * are set against the built-in objective weights in scheduler.py
 * (fairness=10, weekend=5, role-balance=5, guardia-spread=3) so the
 * labels are meaningful relative to the rest of the system:
 *  - Baja (2)  → barely affects the result; gentle preference
 *  - Media (5) → matches the weekend/role objectives; default
 *  - Alta (15) → clearly outweighs fairness, but still soft
 *
 * Power users / API callers can still POST arbitrary weights — the
 * schema accepts 0–1000. If an existing rule has a custom weight
 * that doesn't match a tier, the picker highlights the closest one
 * without auto-mutating the stored value (it stays whatever it was
 * unless the admin clicks a tier).
 */
const SOFT_WEIGHT_TIERS: { value: number; label: string; desc: string }[] = [
  { value: 2, label: "Baja", desc: "Trivu lo intenta pero la equidad pesa más." },
  { value: 5, label: "Media", desc: "Mismo peso que la equidad." },
  { value: 15, label: "Alta", desc: "Trivu lo prioriza sobre el reparto." },
];

function SoftWeightPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  // Snap to closest tier for display only; don't mutate the stored
  // value until the admin actually clicks one.
  const selected = SOFT_WEIGHT_TIERS.reduce((best, t) =>
    Math.abs(t.value - value) < Math.abs(best.value - value) ? t : best,
  );
  return (
    <div>
      <span className="text-sm font-medium text-gray-700">
        Peso de la regla
      </span>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {SOFT_WEIGHT_TIERS.map((t) => {
          const checked = t.value === selected.value && t.value === value;
          // When the stored value doesn't equal any tier (custom
          // import / API write), no tier is "checked" but `selected`
          // still highlights the visually-closest one with a softer
          // ring so admins see roughly where they sit.
          const isClosest =
            !checked && t.value === selected.value && t.value !== value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => onChange(t.value)}
              className={
                "rounded-lg border px-3 py-2 text-left transition-colors "
                + (checked
                  ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200"
                  : isClosest
                    ? "border-gray-300 bg-white ring-1 ring-gray-200"
                    : "border-gray-300 bg-white hover:border-gray-400")
              }
            >
              <div className="text-sm font-semibold text-gray-900">
                {t.label}
              </div>
              <div className="mt-0.5 text-xs text-gray-500 leading-snug">
                {t.desc}
              </div>
            </button>
          );
        })}
      </div>
      {!SOFT_WEIGHT_TIERS.some((t) => t.value === value) && (
        <p className="mt-1 text-[11px] text-gray-500">
          Valor personalizado: {value}. Haz click en un nivel para cambiarlo.
        </p>
      )}
    </div>
  );
}

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
        Incompatibilidades del mismo día, sucesión entre actividades y límites
        de frecuencia por persona.
      </p>
      <SetupBanner
        area="rules"
        title="Reglas para el solver"
        description="Define cómo se reparten las actividades: qué actividades no pueden coincidir en el mismo día (p. ej. no doblar guardia + consulta), qué actividad debe seguir a otra (sucesión) y cuántas veces como máximo puede hacer una persona una actividad en un periodo. Si no necesitas ninguna, marca como completado."
      />
      {/* Each section lives in its own card so the visual boundary is
          obvious. Without cards three "+ Añadir regla" buttons next to
          each other made it ambiguous which section the click belonged
          to. Vertical rhythm via space-y replaces the manual spacer
          divs we used before. */}
      <div className="space-y-6">
        <SameDaySection slots={slots.data ?? []} slotById={slotById} />
        <SuccessionSection slots={slots.data ?? []} slotById={slotById} />
        <FrequencySection slots={slots.data ?? []} slotById={slotById} />
      </div>
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
    <section className="rounded-xl bg-white p-5 ring-1 ring-gray-200 shadow-soft">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center">
          Sucesión entre actividades
          <InfoHint position="below">
            Reglas del tipo &quot;después de X, no Y&quot;. Ej: tras una
            guardia de 24h, la misma persona no puede tener consulta al
            día siguiente.
          </InfoHint>
        </h2>
        <Button onClick={() => setEditing("new")}>+ Añadir regla</Button>
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && successionRules.length === 0 && (
        <Empty>Aún no hay reglas de sucesión.</Empty>
      )}
      {successionRules.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Después de</th>
                <th className="px-4 py-2 font-medium">No se puede</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Peso</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {successionRules.map((r) => {
                const afterRoleLabel =
                  r.after_team_role_id != null
                    ? slotById[r.after_slot_id]?.team_roles.find(
                        (tr) => tr.id === r.after_team_role_id,
                      )?.role_label
                    : null;
                const forbidRoleLabel =
                  r.forbid_team_role_id != null
                    ? slotById[r.forbid_slot_id]?.team_roles.find(
                        (tr) => tr.id === r.forbid_team_role_id,
                      )?.role_label
                    : null;
                return (
                <tr key={r.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {slotById[r.after_slot_id]?.name ?? `#${r.after_slot_id}`}
                    {afterRoleLabel && (
                      <span className="ml-1 text-xs text-gray-500">
                        · {afterRoleLabel}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {slotById[r.forbid_slot_id]?.name ?? `#${r.forbid_slot_id}`}
                    {forbidRoleLabel && (
                      <span className="ml-1 text-xs text-gray-500">
                        · {forbidRoleLabel}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{r.days_after}</td>
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
                );
              })}
            </tbody>
          </table>
        </div>
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
  // Sprint 17: optional sub-role filters. Stored as number | "" so the
  // Select<number> component is happy; "" means "todos los roles".
  const [afterRoleId, setAfterRoleId] = useState<number | "">(
    initial?.after_team_role_id ?? "",
  );
  const [forbidRoleId, setForbidRoleId] = useState<number | "">(
    initial?.forbid_team_role_id ?? "",
  );
  const [daysAfter, setDaysAfter] = useState<number>(initial?.days_after ?? 1);
  const [severity, setSeverity] = useState<DependencySeverity>(
    initial?.severity ?? "hard",
  );
  const [weight, setWeight] = useState<number>(initial?.weight ?? 5);

  // Helper: the slot object for a given id (for looking up team_roles
  // and staffing_mode in the role selects below).
  const slotById = (id: number | "") =>
    id === "" ? null : slots.find((s) => s.id === id) ?? null;

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
        throw new Error("Selecciona las actividades");
      }
      return api.createSuccessionRule({
        after_slot_id: afterSlotId,
        forbid_slot_id: forbidSlotId,
        after_team_role_id: afterRoleId === "" ? null : afterRoleId,
        forbid_team_role_id: forbidRoleId === "" ? null : forbidRoleId,
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

  // Build the sub-role options for each side. Only relevant when the
  // slot is team_composition and actually has roles defined.
  const afterSlot = slotById(afterSlotId);
  const forbidSlot = slotById(forbidSlotId);
  const afterRoleOptions =
    afterSlot && afterSlot.staffing_mode === "team_composition"
      ? afterSlot.team_roles
      : [];
  const forbidRoleOptions =
    forbidSlot && forbidSlot.staffing_mode === "team_composition"
      ? forbidSlot.team_roles
      : [];

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
          label="Después de la actividad"
          value={afterSlotId}
          onChange={(v) => {
            const next = v === "" ? "" : Number(v);
            // Reset the sub-role filter when the slot changes — the
            // role id wouldn't belong to the new slot.
            if (next !== afterSlotId) setAfterRoleId("");
            setAfterSlotId(next);
          }}
          options={[{ value: "", label: "—" }, ...slotOptions]}
        />
        {afterRoleOptions.length > 0 && (
          <Select
            label="Sub-actividad (opcional)"
            value={afterRoleId}
            onChange={(v) => setAfterRoleId(v === "" ? "" : Number(v))}
            options={[
              { value: "", label: "— Todos los roles —" },
              ...afterRoleOptions.map((r) => ({
                value: r.id,
                label: r.role_label,
              })),
            ]}
          />
        )}
        <Select
          label="No se puede asignar"
          value={forbidSlotId}
          onChange={(v) => {
            const next = v === "" ? "" : Number(v);
            if (next !== forbidSlotId) setForbidRoleId("");
            setForbidSlotId(next);
          }}
          options={[{ value: "", label: "—" }, ...slotOptions]}
        />
        {forbidRoleOptions.length > 0 && (
          <Select
            label="Sub-actividad (opcional)"
            value={forbidRoleId}
            onChange={(v) => setForbidRoleId(v === "" ? "" : Number(v))}
            options={[
              { value: "", label: "— Todos los roles —" },
              ...forbidRoleOptions.map((r) => ({
                value: r.id,
                label: r.role_label,
              })),
            ]}
          />
        )}
        <NumberField
          label="Durante (días, 1-14)"
          value={daysAfter}
          onChange={(v) => setDaysAfter(typeof v === "number" ? v : 1)}
          min={1}
          max={14}
        />
        {/*
          "Aplica a" select removed: the only valid value here is
          "same_person" — the rule says "if THIS person does after_slot,
          THIS person can't do forbid_slot for N days". The "whole_team"
          option was a stub that never got built ("if anyone on the team
          does X, no one on the team does Y") and would be a weird policy
          even if it existed. The model column still defaults to
          same_person server-side so old data continues to work.
        */}
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
          <SoftWeightPicker value={weight} onChange={setWeight} />
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
    <section className="rounded-xl bg-white p-5 ring-1 ring-gray-200 shadow-soft">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center">
          Límites de frecuencia
          <InfoHint position="below">
            Tope de cuántas veces alguien hace una actividad en un periodo.
            Ej: máximo 4 guardias al mes por persona, o máximo 2
            quirófanos por semana.
          </InfoHint>
        </h2>
        <Button onClick={() => setEditing("new")}>+ Añadir límite</Button>
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && (
        <Empty>Aún no hay límites de frecuencia.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Actividad</th>
                <th className="px-4 py-2 font-medium">Periodo</th>
                <th className="px-4 py-2 font-medium">Máx por persona</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Peso</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => {
                const roleLabel =
                  c.team_role_id != null
                    ? slotById[c.slot_id]?.team_roles.find(
                        (tr) => tr.id === c.team_role_id,
                      )?.role_label
                    : null;
                return (
                <tr key={c.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {slotById[c.slot_id]?.name ?? `#${c.slot_id}`}
                    {roleLabel && (
                      <span className="ml-1 text-xs text-gray-500">
                        · {roleLabel}
                      </span>
                    )}
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
                );
              })}
            </tbody>
          </table>
        </div>
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
  const [roleId, setRoleId] = useState<number | "">(
    initial?.team_role_id ?? "",
  );
  const [period, setPeriod] = useState<FrequencyPeriod>(
    initial?.period ?? "rolling_7",
  );
  const [maxCount, setMaxCount] = useState<number>(initial?.max_count ?? 1);
  const [severity, setSeverity] = useState<DependencySeverity>(
    initial?.severity ?? "hard",
  );
  const [weight, setWeight] = useState<number>(initial?.weight ?? 5);

  const slotById = (id: number | "") =>
    id === "" ? null : slots.find((s) => s.id === id) ?? null;
  const currentSlot = slotById(slotId);
  const roleOptions =
    currentSlot && currentSlot.staffing_mode === "team_composition"
      ? currentSlot.team_roles
      : [];

  const save = useMutation({
    mutationFn: () => {
      if (initial) {
        return api.updateFrequencyCap(initial.id, {
          max_count: maxCount,
          severity,
          weight,
        });
      }
      if (slotId === "") throw new Error("Selecciona una actividad");
      return api.createFrequencyCap({
        slot_id: slotId,
        team_role_id: roleId === "" ? null : roleId,
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
            label="Actividad"
            value={slotId}
            onChange={(v) => {
              const next = v === "" ? "" : Number(v);
              if (next !== slotId) setRoleId("");
              setSlotId(next);
            }}
            options={[{ value: "", label: "—" }, ...slotOptions]}
          />
        )}
        {!initial && roleOptions.length > 0 && (
          <Select
            label="Sub-actividad (opcional)"
            value={roleId}
            onChange={(v) => setRoleId(v === "" ? "" : Number(v))}
            options={[
              { value: "", label: "— Todos los roles —" },
              ...roleOptions.map((r) => ({
                value: r.id,
                label: r.role_label,
              })),
            ]}
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
          <SoftWeightPicker value={weight} onChange={setWeight} />
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
    <section className="rounded-xl bg-white p-5 ring-1 ring-gray-200 shadow-soft">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center">
          Incompatibilidades del mismo día
          <InfoHint position="below">
            Dos actividades que no pueden coincidir el mismo día para la
            misma persona, aunque sus horarios no se solapen. (Para
            conflictos de horario solapado no necesitas regla — Trivu
            los detecta automáticamente.)
          </InfoHint>
        </h2>
        <Button onClick={() => setEditing("new")}>+ Añadir regla</Button>
      </div>
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && sameDay.length === 0 && (
        <Empty>Aún no hay incompatibilidades del mismo día.</Empty>
      )}
      {sameDay.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Actividad</th>
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
        </div>
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
        throw new Error("Selecciona las dos actividades");
      }
      if (afterSlotId === forbidSlotId) {
        throw new Error("Las dos actividades deben ser diferentes");
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
          label="Actividad"
          value={afterSlotId}
          onChange={(v) => setAfterSlotId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "Selecciona una actividad" },
            ...slotOptions,
          ]}
        />
        <Select
          label="No se puede combinar con"
          value={forbidSlotId}
          onChange={(v) => setForbidSlotId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "Selecciona una actividad" },
            ...slotOptions,
          ]}
        />
        <Select
          label="Severidad"
          value={severity}
          onChange={(v) => v && setSeverity(v as DependencySeverity)}
          options={[
            { value: "hard", label: "Estricta (Trivu no lo permitirá)" },
            { value: "soft", label: "Blanda (penaliza, pero permite)" },
          ]}
        />
        {severity === "soft" && (
          <SoftWeightPicker value={weight} onChange={setWeight} />
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

"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Category,
  type DaysApplied,
  type Skill,
  type SkillStrength,
  type Slot,
  type SlotInput,
  type SlotRule,
  type SlotRuleInput,
  type SlotRuleStrategy,
  type StaffingMode,
  type TeamMember,
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

export default function SlotsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.listSkills });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const [editing, setEditing] = useState<Slot | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteSlot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });

  return (
    <>
      <PageHeader
        title="Turnos"
        action={<Button onClick={() => setEditing("new")}>Nuevo turno</Button>}
      />
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay turnos.</Empty>}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Horario</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Modo</th>
                <th className="px-4 py-2 font-medium">Plazas</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{s.name}</td>
                  <td className="px-4 py-2">
                    {s.start_time && s.end_time
                      ? `${s.start_time}–${s.end_time}${s.crosses_midnight ? " (+1d)" : ""}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{s.days_applied}</td>
                  <td className="px-4 py-2 text-gray-600">{s.staffing_mode}</td>
                  <td className="px-4 py-2">{s.headcount}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(s)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`¿Eliminar turno "${s.name}"?`)) del.mutate(s.id);
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
        <SlotDialog
          initial={editing === "new" ? null : editing}
          categories={cats.data ?? []}
          skills={skills.data ?? []}
          team={team.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

type TeamRoleDraft = { role_label: string; headcount: number; category_ids: number[] };
type SkillDraft = { skill_id: number; strength: SkillStrength };

function SlotDialog({
  initial,
  categories,
  skills,
  team,
  onClose,
}: {
  initial: Slot | null;
  categories: Category[];
  skills: Skill[];
  team: TeamMember[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [startTime, setStartTime] = useState(initial?.start_time?.slice(0, 5) ?? "");
  const [endTime, setEndTime] = useState(initial?.end_time?.slice(0, 5) ?? "");
  const [days, setDays] = useState<DaysApplied>(initial?.days_applied ?? "all");
  // Bitmap convention: bit 0 = Monday … bit 6 = Sunday. Mirrors the
  // back-end check in the scheduler (Slot.custom_days_bitmap).
  const [customDaysBitmap, setCustomDaysBitmap] = useState<number>(
    initial?.custom_days_bitmap ?? 0,
  );
  const [mode, setMode] = useState<StaffingMode>(initial?.staffing_mode ?? "single");
  const [headcount, setHeadcount] = useState<string>(
    initial?.headcount?.toString() ?? "1",
  );
  const [postRest, setPostRest] = useState<boolean>(initial?.post_slot_rest ?? false);
  const [countsEquity, setCountsEquity] = useState<boolean>(
    initial?.counts_for_equity ?? true,
  );
  const [guardiaType, setGuardiaType] = useState<string>(
    initial?.guardia_type ?? "",
  );
  const [equityGroupKey, setEquityGroupKey] = useState<string>(
    initial?.equity_group_key ?? "",
  );
  const [teamRoles, setTeamRoles] = useState<TeamRoleDraft[]>(
    initial?.team_roles.map((r) => ({
      role_label: r.role_label,
      headcount: r.headcount,
      category_ids: r.category_ids,
    })) ?? [],
  );
  const [skillsRequired, setSkillsRequired] = useState<SkillDraft[]>(
    initial?.skills_required.map((s) => ({
      skill_id: s.skill_id,
      strength: s.strength,
    })) ?? [],
  );
  const [rules, setRules] = useState<RuleDraft[]>(
    initial?.rules.map(ruleToDraft) ?? [
      {
        days_bitmap: 0b1111111,
        strategy: "solver",
        anchor_date: null,
        weekly_pins: [],
        rotation_blocks: [],
        rotation_members: [],
      },
    ],
  );

  const save = useMutation({
    mutationFn: async () => {
      const body: SlotInput = {
        name,
        days_applied: days,
        // Only send the bitmap when in custom mode; otherwise null
        // (the back-end validates this and ignores it for non-custom days).
        custom_days_bitmap: days === "custom" ? customDaysBitmap : null,
        staffing_mode: mode,
        headcount: Number(headcount),
        post_slot_rest: postRest,
        counts_for_equity: countsEquity,
        guardia_type: guardiaType.trim() || null,
        equity_group_key: equityGroupKey.trim() || null,
        start_time: startTime ? `${startTime}:00` : null,
        end_time: endTime ? `${endTime}:00` : null,
        team_roles: mode === "team_composition" ? teamRoles : [],
        skills_required: skillsRequired,
      };
      const slot = initial
        ? await api.updateSlot(initial.id, body)
        : await api.createSlot(body);
      // Atomic rule replacement always runs after slot core is saved.
      // For new slots the API created a default solver rule; we overwrite
      // it with whatever the admin configured (which often is exactly the
      // same default rule, so this is a cheap no-op).
      const ruleInputs: SlotRuleInput[] = rules.map(draftToInput);
      await api.replaceSlotRules(slot.id, ruleInputs);
      return slot;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      onClose();
    },
  });

  // Validation: rules must not have empty bitmaps and must collectively
  // cover the slot's days_applied days. The back-end enforces overlap
  // and rotation completeness; this banner is just an early-warning.
  const ruleValidationError = validateRulesClient(rules, days, customDaysBitmap);

  function addTeamRole() {
    setTeamRoles((cur) => [
      ...cur,
      { role_label: "", headcount: 1, category_ids: [] },
    ]);
  }
  function updateTeamRole(i: number, patch: Partial<TeamRoleDraft>) {
    setTeamRoles((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeTeamRole(i: number) {
    setTeamRoles((cur) => cur.filter((_, idx) => idx !== i));
  }
  function toggleCategory(i: number, cid: number) {
    setTeamRoles((cur) =>
      cur.map((r, idx) =>
        idx === i
          ? {
              ...r,
              category_ids: r.category_ids.includes(cid)
                ? r.category_ids.filter((x) => x !== cid)
                : [...r.category_ids, cid],
            }
          : r,
      ),
    );
  }

  function addSkill() {
    const used = new Set(skillsRequired.map((s) => s.skill_id));
    const next = skills.find((s) => !used.has(s.id));
    if (next) setSkillsRequired((cur) => [...cur, { skill_id: next.id, strength: "hard" }]);
  }
  function updateSkill(i: number, patch: Partial<SkillDraft>) {
    setSkillsRequired((cur) =>
      cur.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }
  function removeSkill(i: number) {
    setSkillsRequired((cur) => cur.filter((_, idx) => idx !== i));
  }

  return (
    <Modal open={true} onClose={onClose} title={initial ? "Editar turno" : "Nuevo turno"}>
      <form
        className="space-y-3 max-h-[70vh] overflow-y-auto pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Nombre" value={name} onChange={setName} required />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Hora inicio" type="time" value={startTime} onChange={setStartTime} />
          <TextField label="Hora fin" type="time" value={endTime} onChange={setEndTime} />
        </div>
        <Select
          label="Días aplicados"
          value={days}
          onChange={(v) => v && setDays(v as DaysApplied)}
          options={DAYS.map((d) => ({ value: d.value, label: d.label }))}
        />
        {days === "custom" && (
          <CustomDaysPicker value={customDaysBitmap} onChange={setCustomDaysBitmap} />
        )}
        <Select
          label="Modo de plantilla"
          value={mode}
          onChange={(v) => v && setMode(v as StaffingMode)}
          options={STAFFING.map((s) => ({ value: s.value, label: s.label }))}
        />
        <TextField label="Plazas" type="number" value={headcount} onChange={setHeadcount} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={postRest}
            onChange={(e) => setPostRest(e.target.checked)}
          />
          Genera descanso post-guardia
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={countsEquity}
            onChange={(e) => setCountsEquity(e.target.checked)}
          />
          Cuenta para equidad
        </label>
        <div>
          <TextField
            label="Tipo de guardia"
            value={guardiaType}
            onChange={setGuardiaType}
            placeholder="presencial_24h"
          />
          <p className="mt-1 text-xs text-gray-500">
            Si este turno es una guardia, indica el tipo (presencial_24h,
            localizada, findes_festivos…). Solo personas con ese tipo en su
            perfil podrán cubrirlo. Déjalo vacío si no es una guardia.
          </p>
        </div>
        {countsEquity && (
          <div>
            <TextField
              label="Grupo de equidad"
              value={equityGroupKey}
              onChange={setEquityGroupKey}
              placeholder="guardia"
            />
            <p className="mt-1 text-xs text-gray-500">
              Turnos con el mismo grupo se balancean entre sí (ej. todas las
              guardias se reparten equitativamente, todos los quirófanos se
              reparten equitativamente, sin mezclar). Déjalo vacío para usar
              el grupo por defecto.
            </p>
          </div>
        )}

        {mode === "team_composition" ? (
          <div className="border-t pt-3">
            <h3 className="text-sm font-semibold mb-1">Reglas de asignación</h3>
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              Las reglas por día (rotación, día fijo, manual) no se aplican a
              turnos con composición de equipo. Para este turno la asignación
              se hace siempre con el solver, respetando los roles definidos
              abajo. Si necesitas estrategias por día para un turno con
              equipo, créalo como dos turnos separados o pide la mejora de
              reglas-por-rol.
            </p>
          </div>
        ) : (
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Reglas de asignación</h3>
              <Button
                variant="secondary"
                onClick={() =>
                  setRules((cur) => [
                    ...cur,
                    {
                      days_bitmap: 0,
                      strategy: "solver",
                      anchor_date: null,
                      weekly_pins: [],
                      rotation_blocks: [],
                      rotation_members: [],
                    },
                  ])
                }
              >
                + Añadir regla
              </Button>
            </div>
            {ruleValidationError && (
              <p className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                {ruleValidationError}
              </p>
            )}
            {rules.map((r, i) => (
              <RuleCard
                key={i}
                rule={r}
                team={team}
                onChange={(patch) =>
                  setRules((cur) =>
                    cur.map((rr, idx) => (idx === i ? { ...rr, ...patch } : rr)),
                  )
                }
                onDelete={() =>
                  setRules((cur) => cur.filter((_, idx) => idx !== i))
                }
              />
            ))}
          </div>
        )}

        {mode === "team_composition" && (
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Roles del equipo</h3>
              <Button variant="secondary" onClick={addTeamRole}>
                + Añadir rol
              </Button>
            </div>
            {teamRoles.length === 0 && (
              <p className="text-xs text-gray-500">Sin roles. Añade al menos uno.</p>
            )}
            {teamRoles.map((r, i) => (
              <div
                key={i}
                className="rounded-md border bg-gray-50 p-2 mb-2 space-y-2"
              >
                <div className="grid grid-cols-[1fr_5rem_auto] gap-2 items-end">
                  <TextField
                    label="Etiqueta"
                    value={r.role_label}
                    onChange={(v) => updateTeamRole(i, { role_label: v })}
                  />
                  <TextField
                    label="Plazas"
                    type="number"
                    value={String(r.headcount)}
                    onChange={(v) => updateTeamRole(i, { headcount: Number(v) || 1 })}
                  />
                  <button
                    type="button"
                    onClick={() => removeTeamRole(i)}
                    className="text-xs text-red-700 hover:underline pb-2"
                  >
                    Quitar
                  </button>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-700">
                    Categorías que pueden cubrir este rol
                  </span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {categories.length === 0 && (
                      <span className="text-xs text-gray-500">
                        Crea categorías primero.
                      </span>
                    )}
                    {categories.map((c) => (
                      <label key={c.id} className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={r.category_ids.includes(c.id)}
                          onChange={() => toggleCategory(i, c.id)}
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Competencias requeridas</h3>
            <Button variant="secondary" onClick={addSkill} disabled={skills.length === 0}>
              + Añadir competencia
            </Button>
          </div>
          {skills.length === 0 && (
            <p className="text-xs text-gray-500">Crea competencias primero.</p>
          )}
          {skillsRequired.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2 items-end mb-2">
              <Select
                label="Competencia"
                value={s.skill_id}
                onChange={(v) => v !== "" && updateSkill(i, { skill_id: Number(v) })}
                options={skills.map((sk) => ({ value: sk.id, label: sk.name }))}
              />
              <Select
                label="Fuerza"
                value={s.strength}
                onChange={(v) => v && updateSkill(i, { strength: v as SkillStrength })}
                options={[
                  { value: "hard", label: "Obligatoria" },
                  { value: "soft", label: "Preferida" },
                ]}
              />
              <button
                type="button"
                onClick={() => removeSkill(i)}
                className="text-xs text-red-700 hover:underline pb-2"
              >
                Quitar
              </button>
            </div>
          ))}
        </div>

        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-white">
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

// Bitmap day picker for slots with `days_applied = "custom"`. The bitmap
// uses bit 0 = Monday … bit 6 = Sunday, matching how the scheduler reads
// Slot.custom_days_bitmap on the server side.
const DAY_LABELS: { bit: number; short: string; long: string }[] = [
  { bit: 0, short: "L", long: "Lunes" },
  { bit: 1, short: "M", long: "Martes" },
  { bit: 2, short: "X", long: "Miércoles" },
  { bit: 3, short: "J", long: "Jueves" },
  { bit: 4, short: "V", long: "Viernes" },
  { bit: 5, short: "S", long: "Sábado" },
  { bit: 6, short: "D", long: "Domingo" },
];

function CustomDaysPicker({
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
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-700">
        Días concretos
      </label>
      <div className="flex flex-wrap gap-1">
        {DAY_LABELS.map(({ bit, short, long }) => {
          const active = (value & (1 << bit)) !== 0;
          return (
            <button
              key={bit}
              type="button"
              onClick={() => toggle(bit)}
              aria-pressed={active}
              title={long}
              className={
                "flex h-9 w-9 items-center justify-center rounded-md border text-sm font-medium transition " +
                (active
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50")
              }
            >
              {short}
            </button>
          );
        })}
      </div>
      {value === 0 && (
        <p className="text-xs text-amber-700">
          Selecciona al menos un día para activar la regla personalizada.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules editor
// ---------------------------------------------------------------------------

type RuleDraft = {
  days_bitmap: number;
  strategy: SlotRuleStrategy;
  anchor_date: string | null;
  weekly_pins: { weekday: number; person_id: number }[];
  rotation_blocks: { position: number; days_bitmap: number }[];
  rotation_members: { position: number; person_id: number }[];
};

function ruleToDraft(r: SlotRule): RuleDraft {
  return {
    days_bitmap: r.days_bitmap,
    strategy: r.strategy,
    anchor_date: r.anchor_date,
    weekly_pins: r.weekly_pins.map((p) => ({
      weekday: p.weekday,
      person_id: p.person_id,
    })),
    rotation_blocks: r.rotation_blocks.map((b) => ({
      position: b.position,
      days_bitmap: b.days_bitmap,
    })),
    rotation_members: r.rotation_members.map((m) => ({
      position: m.position,
      person_id: m.person_id,
    })),
  };
}

function draftToInput(r: RuleDraft): SlotRuleInput {
  return {
    days_bitmap: r.days_bitmap,
    strategy: r.strategy,
    anchor_date: r.strategy === "rotation" ? r.anchor_date : null,
    weekly_pins:
      r.strategy === "fixed_weekly"
        ? r.weekly_pins.filter((p) => r.days_bitmap & (1 << p.weekday))
        : [],
    rotation_blocks: r.strategy === "rotation" ? r.rotation_blocks : [],
    rotation_members: r.strategy === "rotation" ? r.rotation_members : [],
  };
}

function validateRulesClient(
  rules: RuleDraft[],
  days: DaysApplied,
  customBitmap: number,
): string | null {
  let combined = 0;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.days_bitmap === 0) return `Regla ${i + 1}: selecciona al menos un día.`;
    if (combined & r.days_bitmap)
      return `Regla ${i + 1}: solapa con otra regla en los mismos días.`;
    combined |= r.days_bitmap;
  }
  // Check coverage against the slot's days_applied target.
  const target =
    days === "all"
      ? 0b1111111
      : days === "weekdays"
        ? 0b0011111
        : days === "weekends_holidays"
          ? 0b1100000
          : customBitmap;
  if (target && (combined & target) !== target) {
    return "Las reglas no cubren todos los días del turno. Las fechas sin regla quedarán vacías.";
  }
  return null;
}

const ROT_PRESETS: { value: string; label: string }[] = [
  { value: "daily", label: "Diaria" },
  { value: "weekdays", label: "Solo laborables" },
  { value: "weekdays_weekend_grouped", label: "Laborables + finde agrupado" },
  { value: "weekly", label: "Semanal" },
  { value: "custom", label: "Personalizado" },
];

function blocksFromPreset(
  preset: string,
  bitmap: number,
): { position: number; days_bitmap: number }[] {
  if (preset === "weekly") {
    return [{ position: 0, days_bitmap: bitmap }];
  }
  if (preset === "daily") {
    const out: { position: number; days_bitmap: number }[] = [];
    let pos = 0;
    for (let bit = 0; bit < 7; bit++) {
      const mask = 1 << bit;
      if (bitmap & mask) out.push({ position: pos++, days_bitmap: mask });
    }
    return out;
  }
  if (preset === "weekdays") {
    const out: { position: number; days_bitmap: number }[] = [];
    let pos = 0;
    for (let bit = 0; bit < 5; bit++) {
      const mask = 1 << bit;
      if (bitmap & mask) out.push({ position: pos++, days_bitmap: mask });
    }
    return out;
  }
  if (preset === "weekdays_weekend_grouped") {
    const out: { position: number; days_bitmap: number }[] = [];
    let pos = 0;
    for (let bit = 0; bit < 4; bit++) {
      const mask = 1 << bit;
      if (bitmap & mask) out.push({ position: pos++, days_bitmap: mask });
    }
    const we = bitmap & 0b1110000;
    if (we) out.push({ position: pos++, days_bitmap: we });
    return out;
  }
  return [];
}

function bitmapDescription(bitmap: number): string {
  return DAY_LABELS.map((d) => (bitmap & (1 << d.bit) ? d.short : "·")).join(" ");
}

function RuleCard({
  rule,
  team,
  onChange,
  onDelete,
}: {
  rule: RuleDraft;
  team: TeamMember[];
  onChange: (patch: Partial<RuleDraft>) => void;
  onDelete: () => void;
}) {
  const toggleDay = (bit: number) => {
    const mask = 1 << bit;
    const next = rule.days_bitmap & mask
      ? rule.days_bitmap & ~mask
      : rule.days_bitmap | mask;
    onChange({ days_bitmap: next });
  };

  const setStrategy = (s: SlotRuleStrategy) => onChange({ strategy: s });

  const summary = (() => {
    if (rule.strategy === "solver") return "Asignación automática (solver)";
    if (rule.strategy === "manual") return "Asignación manual";
    if (rule.strategy === "fixed_weekly")
      return `${rule.weekly_pins.length} pin(s) por día de la semana`;
    return `${rule.rotation_blocks.length} bloque(s) · ${rule.rotation_members.length} persona(s)`;
  })();

  return (
    <div className="rounded-md border bg-gray-50 p-2 mb-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-700">
          <span className="font-mono">{bitmapDescription(rule.days_bitmap)}</span>
          <span className="ml-2 text-gray-500">· {summary}</span>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-red-700 hover:underline"
        >
          Quitar
        </button>
      </div>

      <div>
        <span className="text-xs font-medium text-gray-700">Días que cubre</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {DAY_LABELS.map(({ bit, short, long }) => {
            const active = (rule.days_bitmap & (1 << bit)) !== 0;
            return (
              <button
                key={bit}
                type="button"
                onClick={() => toggleDay(bit)}
                aria-pressed={active}
                title={long}
                className={
                  "flex h-8 w-8 items-center justify-center rounded-md border text-xs font-medium transition " +
                  (active
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50")
                }
              >
                {short}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        {(
          [
            { v: "solver", label: "Solver" },
            { v: "fixed_weekly", label: "Día fijo" },
            { v: "rotation", label: "Rotación" },
            { v: "manual", label: "Manual" },
          ] as { v: SlotRuleStrategy; label: string }[]
        ).map((opt) => (
          <label key={opt.v} className="flex items-center gap-1">
            <input
              type="radio"
              checked={rule.strategy === opt.v}
              onChange={() => setStrategy(opt.v)}
            />
            {opt.label}
          </label>
        ))}
      </div>

      {rule.strategy === "fixed_weekly" && (
        <FixedWeeklyEditor rule={rule} team={team} onChange={onChange} />
      )}
      {rule.strategy === "rotation" && (
        <RotationEditor rule={rule} team={team} onChange={onChange} />
      )}
    </div>
  );
}

function FixedWeeklyEditor({
  rule,
  team,
  onChange,
}: {
  rule: RuleDraft;
  team: TeamMember[];
  onChange: (patch: Partial<RuleDraft>) => void;
}) {
  const setPin = (weekday: number, person_id: number | null) => {
    const cleaned = rule.weekly_pins.filter((p) => p.weekday !== weekday);
    if (person_id !== null) cleaned.push({ weekday, person_id });
    onChange({ weekly_pins: cleaned });
  };
  const days = DAY_LABELS.filter((d) => rule.days_bitmap & (1 << d.bit));
  if (!days.length) {
    return <p className="text-xs text-gray-500">Activa días en la regla para fijar pines.</p>;
  }
  return (
    <div className="space-y-1">
      {days.map((d) => {
        const pin = rule.weekly_pins.find((p) => p.weekday === d.bit);
        return (
          <div key={d.bit} className="grid grid-cols-[5rem_1fr] items-center gap-2 text-xs">
            <span className="text-gray-700">{d.long}</span>
            <Select
              label=""
              value={pin?.person_id ?? ""}
              onChange={(v) =>
                setPin(d.bit, v === "" || v === null ? null : Number(v))
              }
              options={[
                { value: "", label: "—" },
                ...team.map((m) => ({
                  value: m.person_id,
                  label: m.person_name,
                })),
              ]}
            />
          </div>
        );
      })}
    </div>
  );
}

function RotationEditor({
  rule,
  team,
  onChange,
}: {
  rule: RuleDraft;
  team: TeamMember[];
  onChange: (patch: Partial<RuleDraft>) => void;
}) {
  const applyPreset = (preset: string) => {
    onChange({ rotation_blocks: blocksFromPreset(preset, rule.days_bitmap) });
  };
  const addMember = () => {
    const used = new Set(rule.rotation_members.map((m) => m.person_id));
    const next = team.find((t) => !used.has(t.person_id));
    if (next)
      onChange({
        rotation_members: [
          ...rule.rotation_members,
          { position: rule.rotation_members.length, person_id: next.person_id },
        ],
      });
  };
  const moveMember = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= rule.rotation_members.length) return;
    const arr = [...rule.rotation_members];
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    onChange({
      rotation_members: arr.map((m, i) => ({ ...m, position: i })),
    });
  };
  const removeMember = (idx: number) => {
    const arr = rule.rotation_members
      .filter((_, i) => i !== idx)
      .map((m, i) => ({ ...m, position: i }));
    onChange({ rotation_members: arr });
  };
  return (
    <div className="space-y-2 rounded border border-gray-200 bg-white p-2">
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label="Fecha ancla"
          type="date"
          value={rule.anchor_date ?? ""}
          onChange={(v) => onChange({ anchor_date: v || null })}
        />
        <Select
          label="Forma de la rotación"
          value=""
          onChange={(v) => v && applyPreset(String(v))}
          options={[
            { value: "", label: "Aplicar plantilla…" },
            ...ROT_PRESETS.map((p) => ({ value: p.value, label: p.label })),
          ]}
        />
      </div>
      <div>
        <span className="text-xs font-medium text-gray-700">Bloques</span>
        <div className="mt-1 space-y-1">
          {rule.rotation_blocks.length === 0 && (
            <p className="text-xs text-gray-500">
              Aplica una plantilla o añade bloques personalizados.
            </p>
          )}
          {rule.rotation_blocks.map((b, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-12 text-gray-500">#{i + 1}</span>
              <span className="font-mono">{bitmapDescription(b.days_bitmap)}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700">Miembros (orden = ciclo)</span>
          <Button variant="secondary" onClick={addMember} disabled={team.length === 0}>
            + Añadir
          </Button>
        </div>
        {rule.rotation_members.length === 0 && (
          <p className="text-xs text-gray-500">Añade al menos un miembro.</p>
        )}
        {rule.rotation_members.map((m, i) => {
          const tm = team.find((t) => t.person_id === m.person_id);
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-6 text-gray-500">{i + 1}.</span>
              <span className="flex-1">{tm?.person_name ?? `Persona ${m.person_id}`}</span>
              <button
                type="button"
                className="text-gray-500 hover:text-gray-800"
                onClick={() => moveMember(i, -1)}
                disabled={i === 0}
              >
                ↑
              </button>
              <button
                type="button"
                className="text-gray-500 hover:text-gray-800"
                onClick={() => moveMember(i, 1)}
                disabled={i === rule.rotation_members.length - 1}
              >
                ↓
              </button>
              <button
                type="button"
                className="text-red-700 hover:underline"
                onClick={() => removeMember(i)}
              >
                Quitar
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

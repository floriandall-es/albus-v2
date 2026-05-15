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
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    {s.name}
                    {(nameCounts.get(s.name) ?? 0) > 1 && (
                      <span className="ml-1 text-xs text-gray-400">#{s.id}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {s.start_time && s.end_time
                      ? `${s.start_time}–${s.end_time}${s.crosses_midnight ? " (+1d)" : ""}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{s.days_applied}</td>
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
        );
      })()}

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
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
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
        days_bitmap: slotAllowedDaysBitmap(
          initial?.days_applied ?? "all",
          initial?.custom_days_bitmap ?? 0,
        ),
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
      // Derive the slot-level headcount from the mode so the list view
      // (which renders slot.headcount as "Plazas") never disagrees with
      // what the editor showed.
      // - single: always 1
      // - multiple_same: what the admin typed
      // - team_composition: sum of role plazas (the per-role headcounts
      //   are the source of truth; the solver ignores slot.headcount in
      //   this mode anyway, this is purely a display sync).
      let derivedHeadcount: number;
      if (mode === "single") {
        derivedHeadcount = 1;
      } else if (mode === "team_composition") {
        derivedHeadcount = Math.max(
          1,
          teamRoles.reduce((acc, r) => acc + (r.headcount || 0), 0),
        );
      } else {
        derivedHeadcount = Math.max(1, Number(headcount) || 1);
      }

      const body: SlotInput = {
        name,
        days_applied: days,
        // Only send the bitmap when in custom mode; otherwise null
        // (the back-end validates this and ignores it for non-custom days).
        custom_days_bitmap: days === "custom" ? customDaysBitmap : null,
        staffing_mode: mode,
        headcount: derivedHeadcount,
        post_slot_rest: postRest,
        counts_for_equity: countsEquity,
        guardia_type: guardiaType.trim() || null,
        equity_group_key: equityGroupKey.trim() || null,
        color: color,
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
        <div>
          <Select
            label="Modo de plantilla"
            value={mode}
            onChange={(v) => {
              if (!v) return;
              const next = v as StaffingMode;
              setMode(next);
              // Keep headcount consistent with the mode so /admin/slots
              // doesn't show stale numbers. Single → always 1.
              // Team composition → the per-role plazas are the truth;
              // we keep slot.headcount in sync with their sum below.
              if (next === "single") setHeadcount("1");
            }}
            options={STAFFING.map((s) => ({ value: s.value, label: s.label }))}
          />
          <p className="mt-1 text-xs text-gray-500">
            {mode === "single" &&
              "Una sola persona cubre el turno (1 plaza)."}
            {mode === "multiple_same" &&
              "Varias personas con el mismo perfil cubren el turno. Indica cuántas plazas."}
            {mode === "team_composition" &&
              "Equipo con varios roles. Define los roles abajo; cada uno tiene su propia plaza y categoría."}
          </p>
        </div>
        {mode === "multiple_same" && (
          <TextField
            label="Plazas"
            type="number"
            value={headcount}
            onChange={setHeadcount}
          />
        )}
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

        <div>
          <span className="text-sm font-medium text-gray-700">Color</span>
          <SlotColorPicker value={color} onChange={setColor} />
          <p className="mt-1 text-xs text-gray-500">
            Punto coloreado junto al nombre del turno en la planificación.
            Opcional.
          </p>
        </div>

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
                headcount={Math.max(1, Number(headcount) || 1)}
                allowedDaysBitmap={slotAllowedDaysBitmap(days, customDaysBitmap)}
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

// Mirror of the back-end `_default_rule_bitmap` helper: the days a rule
// can possibly cover, derived from the slot's days_applied. For
// weekends_holidays we still return all 7 bits because holidays can fall
// on any weekday — the slot itself filters to weekend ∪ holiday at solve
// time.
function slotAllowedDaysBitmap(
  days: DaysApplied,
  customDaysBitmap: number,
): number {
  if (days === "weekdays") return 0b0011111;
  if (days === "custom") return customDaysBitmap || 0b1111111;
  return 0b1111111;
}

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
  headcount,
  allowedDaysBitmap,
  onChange,
  onDelete,
}: {
  rule: RuleDraft;
  team: TeamMember[];
  headcount: number;
  allowedDaysBitmap: number;
  onChange: (patch: Partial<RuleDraft>) => void;
  onDelete: () => void;
}) {
  const toggleDay = (bit: number) => {
    const mask = 1 << bit;
    if (!(allowedDaysBitmap & mask)) return;
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
      return `${rule.weekly_pins.length} pin(s) en total`;
    const positions = new Set(rule.rotation_members.map((m) => m.position)).size;
    return `${rule.rotation_blocks.length} bloque(s) · ${positions} posición(es) · ${rule.rotation_members.length} persona(s)`;
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
            const inScope = (allowedDaysBitmap & (1 << bit)) !== 0;
            const active = (rule.days_bitmap & (1 << bit)) !== 0;
            const disabled = !inScope;
            return (
              <button
                key={bit}
                type="button"
                onClick={() => toggleDay(bit)}
                aria-pressed={active}
                disabled={disabled}
                title={
                  disabled
                    ? `${long} — fuera del alcance del turno`
                    : long
                }
                className={
                  "flex h-8 w-8 items-center justify-center rounded-md border text-xs font-medium transition " +
                  (disabled
                    ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-300"
                    : active
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
        <FixedWeeklyEditor
          rule={rule}
          team={team}
          headcount={headcount}
          onChange={onChange}
        />
      )}
      {rule.strategy === "rotation" && (
        <RotationEditor
          rule={rule}
          team={team}
          headcount={headcount}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function FixedWeeklyEditor({
  rule,
  team,
  headcount,
  onChange,
}: {
  rule: RuleDraft;
  team: TeamMember[];
  headcount: number;
  onChange: (patch: Partial<RuleDraft>) => void;
}) {
  // Sprint 15: each weekday can hold a TEAM of pinned people. Pins are
  // identified by index within the (rule, weekday) sub-list — we don't
  // care about insertion order, only that the same person isn't pinned
  // twice in the same weekday (the API enforces this).
  const setPinAt = (weekday: number, idx: number, person_id: number | null) => {
    const all = [...rule.weekly_pins];
    // Find the absolute index of the idx-th pin for this weekday.
    let seen = -1;
    let absIdx = -1;
    for (let i = 0; i < all.length; i++) {
      if (all[i].weekday === weekday) {
        seen += 1;
        if (seen === idx) {
          absIdx = i;
          break;
        }
      }
    }
    if (person_id === null) {
      if (absIdx >= 0) all.splice(absIdx, 1);
    } else if (absIdx >= 0) {
      all[absIdx] = { weekday, person_id };
    } else {
      all.push({ weekday, person_id });
    }
    onChange({ weekly_pins: all });
  };
  const addPin = (weekday: number) => {
    const used = new Set(
      rule.weekly_pins.filter((p) => p.weekday === weekday).map((p) => p.person_id),
    );
    const next = team.find((t) => !used.has(t.person_id));
    if (!next) return;
    onChange({
      weekly_pins: [...rule.weekly_pins, { weekday, person_id: next.person_id }],
    });
  };
  const removePin = (weekday: number, idx: number) => setPinAt(weekday, idx, null);

  const days = DAY_LABELS.filter((d) => rule.days_bitmap & (1 << d.bit));
  if (!days.length) {
    return <p className="text-xs text-gray-500">Activa días en la regla para fijar pines.</p>;
  }
  return (
    <div className="space-y-2">
      {days.map((d) => {
        const pinsForDay = rule.weekly_pins.filter((p) => p.weekday === d.bit);
        const mismatch = pinsForDay.length !== headcount;
        return (
          <div key={d.bit} className="rounded border bg-white p-2 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium text-gray-700">
                {d.long}
                <span className="ml-1 text-gray-400 font-normal">
                  ({pinsForDay.length}/{headcount})
                </span>
              </span>
              <button
                type="button"
                onClick={() => addPin(d.bit)}
                disabled={
                  team.length === 0
                  || pinsForDay.length >= team.length
                  // Same cap as rotation positions: a 1-person turno
                  // gets 1 pinned person per weekday. To assign different
                  // people across weekdays use one row per weekday; a
                  // turno needing N people uses headcount=N.
                  || pinsForDay.length >= headcount
                }
                title={
                  pinsForDay.length >= headcount
                    ? `Este día ya tiene ${headcount} persona${headcount === 1 ? "" : "s"} (el máximo del turno).`
                    : undefined
                }
                className="text-blue-700 hover:underline disabled:text-gray-400 disabled:no-underline"
              >
                + Añadir persona
              </button>
            </div>
            {pinsForDay.length === 0 && (
              <p className="text-gray-500">Sin personas asignadas a este día.</p>
            )}
            {pinsForDay.map((pin, idx) => (
              <div
                key={`${d.bit}-${idx}-${pin.person_id}`}
                className="mb-1 flex items-center gap-2"
              >
                <div className="flex-1">
                  <Select
                    label=""
                    value={pin.person_id}
                    onChange={(v) =>
                      v !== "" && setPinAt(d.bit, idx, Number(v))
                    }
                    options={team.map((m) => ({
                      value: m.person_id,
                      label: m.person_name,
                    }))}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removePin(d.bit, idx)}
                  className="text-red-700 hover:underline"
                >
                  Eliminar
                </button>
              </div>
            ))}
            {mismatch && (
              <p className="mt-1 text-amber-700">
                {d.long}: {pinsForDay.length} persona{pinsForDay.length === 1 ? "" : "s"}
                {" "}asignada{pinsForDay.length === 1 ? "" : "s"} (el turno requiere{" "}
                {headcount}).
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RotationEditor({
  rule,
  team,
  headcount,
  onChange,
}: {
  rule: RuleDraft;
  team: TeamMember[];
  headcount: number;
  onChange: (patch: Partial<RuleDraft>) => void;
}) {
  // Sprint 15: each position is a "team card" holding 1..N people. The
  // cycle math is unchanged — position index still drives which team is
  // on duty for a given (date, block).
  const applyPreset = (preset: string) => {
    onChange({ rotation_blocks: blocksFromPreset(preset, rule.days_bitmap) });
  };

  // Compute distinct positions present, in ascending order. Empty
  // positions (no members yet) are not represented in the data — we
  // expose them via "+ Añadir posición" which appends position=max+1.
  const positions = Array.from(
    new Set(rule.rotation_members.map((m) => m.position)),
  ).sort((a, b) => a - b);

  const allUsedPersonIds = new Set(rule.rotation_members.map((m) => m.person_id));

  const addPosition = () => {
    const nextPos = positions.length === 0 ? 0 : positions[positions.length - 1] + 1;
    const next = team.find((t) => !allUsedPersonIds.has(t.person_id));
    if (!next) return;
    onChange({
      rotation_members: [
        ...rule.rotation_members,
        { position: nextPos, person_id: next.person_id },
      ],
    });
  };

  const addMemberToPosition = (pos: number) => {
    const next = team.find((t) => !allUsedPersonIds.has(t.person_id));
    if (!next) return;
    onChange({
      rotation_members: [
        ...rule.rotation_members,
        { position: pos, person_id: next.person_id },
      ],
    });
  };

  const removeMember = (pos: number, personId: number) => {
    const arr = rule.rotation_members.filter(
      (m) => !(m.position === pos && m.person_id === personId),
    );
    // If this was the only member of `pos`, renumber subsequent positions
    // down so we keep them dense (0..P-1). Solver tolerates sparse, but
    // the UI is clearer with dense numbering.
    const stillUsed = new Set(arr.map((m) => m.position));
    const sorted = Array.from(stillUsed).sort((a, b) => a - b);
    const remap = new Map<number, number>();
    sorted.forEach((p, i) => remap.set(p, i));
    onChange({
      rotation_members: arr.map((m) => ({
        ...m,
        position: remap.get(m.position) ?? m.position,
      })),
    });
  };

  const setMemberPerson = (
    pos: number,
    oldPersonId: number,
    newPersonId: number,
  ) => {
    if (newPersonId === oldPersonId) return;
    if (allUsedPersonIds.has(newPersonId)) return; // already in rotation
    onChange({
      rotation_members: rule.rotation_members.map((m) =>
        m.position === pos && m.person_id === oldPersonId
          ? { ...m, person_id: newPersonId }
          : m,
      ),
    });
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
          <span className="text-xs font-medium text-gray-700">
            Posiciones (orden = ciclo)
          </span>
          <Button
            variant="secondary"
            onClick={addPosition}
            disabled={team.length === 0 || allUsedPersonIds.size >= team.length}
          >
            + Añadir posición
          </Button>
        </div>
        {positions.length === 0 && (
          <p className="text-xs text-gray-500">
            Añade al menos una posición.
          </p>
        )}
        {positions.map((pos, posIdx) => {
          const members = rule.rotation_members.filter((m) => m.position === pos);
          const mismatch = members.length !== headcount;
          return (
            <div
              key={pos}
              className="mb-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-gray-700">
                  Posición {posIdx + 1}
                  <span className="ml-1 text-gray-400 font-normal">
                    ({members.length}/{headcount})
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => addMemberToPosition(pos)}
                  disabled={
                    team.length === 0
                    || allUsedPersonIds.size >= team.length
                    // A position can hold at most `headcount` persons —
                    // a 1-person turno gets one person per position. To
                    // add more people, add another POSITION (rotation
                    // cycles through positions).
                    || members.length >= headcount
                  }
                  title={
                    members.length >= headcount
                      ? `Esta posición ya tiene ${headcount} persona${headcount === 1 ? "" : "s"} (el máximo del turno). Añade otra posición para más personas en la rotación.`
                      : undefined
                  }
                  className="text-blue-700 hover:underline disabled:text-gray-400 disabled:no-underline"
                >
                  + Añadir persona
                </button>
              </div>
              {members.length === 0 && (
                <p className="text-gray-500">Sin personas en esta posición.</p>
              )}
              {members.map((m) => {
                const otherPersonsInRule = new Set(
                  rule.rotation_members
                    .filter((mm) => mm.person_id !== m.person_id)
                    .map((mm) => mm.person_id),
                );
                const options = team
                  .filter((t) =>
                    t.person_id === m.person_id ||
                    !otherPersonsInRule.has(t.person_id),
                  )
                  .map((t) => ({ value: t.person_id, label: t.person_name }));
                return (
                  <div
                    key={`${pos}-${m.person_id}`}
                    className="mb-1 flex items-center gap-2"
                  >
                    <div className="flex-1">
                      <Select
                        label=""
                        value={m.person_id}
                        onChange={(v) =>
                          v !== "" && setMemberPerson(pos, m.person_id, Number(v))
                        }
                        options={options}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeMember(pos, m.person_id)}
                      className="text-red-700 hover:underline"
                    >
                      Eliminar
                    </button>
                  </div>
                );
              })}
              {mismatch && (
                <p className="mt-1 text-amber-700">
                  Posición {posIdx + 1}: {members.length} persona
                  {members.length === 1 ? "" : "s"} (el turno requiere {headcount}).
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Curated swatch palette. Bigger range than the auto-pastels — admins
// can group slots by their own logic (all guardias rose, all consultas
// blue, etc.). "None" clears the colour back to null.
const SLOT_COLORS = [
  "#0d9488", // teal
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f43f5e", // rose
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#64748b", // slate
];

function SlotColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={() => onChange(null)}
        title="Sin color"
        aria-label="Sin color"
        className={
          "relative h-6 w-6 rounded-full border bg-white "
          + (value === null
            ? "border-gray-900 ring-2 ring-offset-1 ring-brand-300"
            : "border-gray-300")
        }
      >
        <span
          className="absolute inset-1 rounded-full border border-gray-300"
          aria-hidden
        />
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 h-px w-full bg-gray-400 rotate-45"
          aria-hidden
        />
      </button>
      {SLOT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          aria-label={`Color ${c}`}
          className={
            "h-6 w-6 rounded-full border transition-transform "
            + (value === c
              ? "ring-2 ring-offset-1 ring-brand-400 border-gray-900 scale-110"
              : "border-gray-300 hover:scale-110")
          }
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

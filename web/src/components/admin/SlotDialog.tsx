"use client";

// Shared modal for editing a slot's full configuration. Used in two
// places:
//
//  - /admin/slots             default slot CRUD (mode='default').
//  - /admin/schedule          per-(period, slot) snapshot inside
//                             the vacation card (mode='period-
//                             snapshot') — admin redefines the slot
//                             for the period without touching the
//                             default config.
//
// The visual language is identical in both modes so admins don't have
// to learn a second form for vacation periods. The mode discriminator
// just controls (a) the title, (b) whether the name input is shown,
// (c) the save mutation (api.updateSlot+replaceSlotRules vs
// api.upsertSlotPeriodSnapshot), and (d) the extra "dismissed" toggle
// + "Restablecer valores por defecto" button in period-snapshot mode.
//
// Everything else — RuleCard, FixedWeeklyEditor, RotationEditor,
// AllowedCategoriesSection, AllowedPersonsSection, the color picker,
// the custom-days picker, the rules-coverage warning, the
// allow-list cascade confirm — is shared verbatim.

import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  personLastName,
  type Category,
  type DaysApplied,
  type Slot,
  type SlotInput,
  type SlotPeriodSnapshot,
  type SlotPeriodSnapshotUpsert,
  type SlotRule,
  type SlotRuleInput,
  type SlotRuleStrategy,
  type StaffingMode,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  ErrorText,
  InfoHint,
  Modal,
  Select,
  TextField,
} from "@/components/admin/ui";

// ---------------------------------------------------------------------------
// Constants shared between SlotDialog and its sub-components.
// ---------------------------------------------------------------------------

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

// Bitmap day picker: bit 0 = Monday … bit 6 = Sunday, matching how
// the scheduler reads Slot.custom_days_bitmap on the server.
const DAY_LABELS: { bit: number; short: string; long: string }[] = [
  { bit: 0, short: "L", long: "Lunes" },
  { bit: 1, short: "M", long: "Martes" },
  { bit: 2, short: "X", long: "Miércoles" },
  { bit: 3, short: "J", long: "Jueves" },
  { bit: 4, short: "V", long: "Viernes" },
  { bit: 5, short: "S", long: "Sábado" },
  { bit: 6, short: "D", long: "Domingo" },
];

const ROT_PRESETS: { value: string; label: string }[] = [
  { value: "daily", label: "Diaria" },
  { value: "weekdays", label: "Solo laborables" },
  { value: "weekdays_weekend_grouped", label: "Laborables + finde" },
  { value: "weekly", label: "Semanal" },
  { value: "custom", label: "Personalizado" },
];

// Curated swatch palette for the color picker.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TeamRoleDraft = {
  role_label: string;
  headcount: number;
  category_ids: number[];
};

type RuleDraft = {
  days_bitmap: number;
  strategy: SlotRuleStrategy;
  anchor_date: string | null;
  /** Multi-week rotation: each position holds for this many weeks
   * before advancing. Default 1 (one position per week step). Only
   * meaningful for strategy='rotation'. */
  weeks_per_position: number;
  weekly_pins: { weekday: number; person_id: number }[];
  rotation_blocks: { position: number; days_bitmap: number }[];
  rotation_members: { position: number; person_id: number }[];
};

/** Discriminated union: the props you pass change which save flow
 * the dialog runs and which fields it shows. Keep them aligned so
 * the form state hooks below can grab the right initial values
 * without prop-drilling a giant "config" object. */
export type SlotDialogProps =
  | {
      mode: "default";
      /** Existing slot (edit) or null (new slot). */
      initial: Slot | null;
      categories: Category[];
      team: TeamMember[];
      onClose: () => void;
    }
  | {
      mode: "period-snapshot";
      /** The underlying default slot — used for its name + as the
       * fallback for any field the snapshot doesn't override.
       * Required because we want to seed the form with sensible
       * defaults even on the first open (when no snapshot exists
       * yet). */
      baseSlot: Slot;
      /** Existing snapshot if any. Null = no snapshot yet; on save
       * we create one. Non-null = on save we replace it; the
       * "Restablecer" button deletes it. */
      snapshot: SlotPeriodSnapshot | null;
      periodId: number;
      categories: Category[];
      team: TeamMember[];
      onClose: () => void;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slotAllowedDaysBitmap(
  days: DaysApplied,
  customDaysBitmap: number,
): number {
  if (days === "weekdays") return 0b0011111;
  if (days === "custom") return customDaysBitmap || 0b1111111;
  return 0b1111111;
}

function ruleToDraft(r: SlotRule): RuleDraft {
  return {
    days_bitmap: r.days_bitmap,
    strategy: r.strategy,
    anchor_date: r.anchor_date,
    weeks_per_position: r.weeks_per_position ?? 1,
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
    weeks_per_position:
      r.strategy === "rotation" ? r.weeks_per_position : 1,
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
  const target =
    days === "all"
      ? 0b1111111
      : days === "weekdays"
        ? 0b0011111
        : days === "weekends_holidays"
          ? 0b1100000
          : customBitmap;
  if (target && (combined & target) !== target) {
    return "Las reglas no cubren todos los días de la actividad. Las fechas sin regla quedarán vacías.";
  }
  return null;
}

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

function detectRotationPreset(
  blocks: { position: number; days_bitmap: number }[],
  bitmap: number,
): string {
  if (blocks.length === 0) return "";
  for (const preset of [
    "weekly",
    "daily",
    "weekdays",
    "weekdays_weekend_grouped",
  ]) {
    const expected = blocksFromPreset(preset, bitmap);
    if (expected.length === 0) continue;
    if (rotationBlocksEqual(expected, blocks)) return preset;
  }
  return "custom";
}

function rotationBlocksEqual(
  a: { position: number; days_bitmap: number }[],
  b: { position: number; days_bitmap: number }[],
): boolean {
  if (a.length !== b.length) return false;
  const sorted = (xs: { position: number; days_bitmap: number }[]) =>
    [...xs].sort(
      (p, q) => p.position - q.position || p.days_bitmap - q.days_bitmap,
    );
  const aS = sorted(a);
  const bS = sorted(b);
  return aS.every(
    (v, i) => v.position === bS[i].position && v.days_bitmap === bS[i].days_bitmap,
  );
}

// ---------------------------------------------------------------------------
// SlotDialog — the main modal
// ---------------------------------------------------------------------------

export function SlotDialog(props: SlotDialogProps) {
  const { mode, categories, team, onClose } = props;
  const qc = useQueryClient();

  // The "seed" object below is the source of truth for initial field
  // values. In default mode it's `initial` (the Slot row being
  // edited, or null for "new"). In period-snapshot mode it's the
  // existing snapshot OR the base slot — snapshot fields take
  // precedence so opening an already-customised slot pre-fills with
  // its current overrides.
  //
  // Kept in a ref because the seed only matters at mount-time
  // (useState ignores future changes to the initial value). The ref
  // dodges the useMemo + complex-deps lint headache from the
  // discriminated-union access pattern.
  const seedRef = useRef<Slot | SlotPeriodSnapshot | null>(
    mode === "default" ? props.initial : (props.snapshot ?? props.baseSlot),
  );
  const seed = seedRef.current;

  // Name only matters in default mode; in period-snapshot mode the
  // slot keeps its name across periods (no per-period rename).
  const [name, setName] = useState(
    mode === "default" ? (seed as Slot | null)?.name ?? "" : "",
  );

  const [startTime, setStartTime] = useState(seed?.start_time?.slice(0, 5) ?? "");
  const [endTime, setEndTime] = useState(seed?.end_time?.slice(0, 5) ?? "");
  // Two-mode schedule: "ranged" sends real times; "all_day" sends
  // null for both. Initial mode follows whatever the seed already
  // has.
  const [scheduleMode, setScheduleMode] = useState<"ranged" | "all_day">(
    seed?.start_time && seed?.end_time ? "ranged" : "all_day",
  );
  const [days, setDays] = useState<DaysApplied>(seed?.days_applied ?? "all");
  const [customDaysBitmap, setCustomDaysBitmap] = useState<number>(
    seed?.custom_days_bitmap ?? 0,
  );
  const [staffingMode, setStaffingMode] = useState<StaffingMode>(
    seed?.staffing_mode ?? "single",
  );
  const [headcount, setHeadcount] = useState<string>(
    seed?.headcount?.toString() ?? "1",
  );
  const [countsEquity, setCountsEquity] = useState<boolean>(
    seed?.counts_for_equity ?? true,
  );
  const [guardiaType, setGuardiaType] = useState<string>(
    seed?.guardia_type ?? "",
  );
  const [color, setColor] = useState<string | null>(seed?.color ?? null);
  const [allowedPersonIds, setAllowedPersonIds] = useState<number[]>(
    seed?.allowed_person_ids ?? [],
  );
  const [allowedCategoryIds, setAllowedCategoryIds] = useState<number[]>(
    seed?.allowed_category_ids ?? [],
  );
  const [teamRoles, setTeamRoles] = useState<TeamRoleDraft[]>(
    seed?.team_roles.map((r) => ({
      role_label: r.role_label,
      headcount: r.headcount,
      category_ids: r.category_ids,
    })) ?? [],
  );
  const [rules, setRules] = useState<RuleDraft[]>(
    seed?.rules.map(ruleToDraft) ?? [
      {
        days_bitmap: slotAllowedDaysBitmap(
          seed?.days_applied ?? "all",
          seed?.custom_days_bitmap ?? 0,
        ),
        strategy: "solver",
        anchor_date: null,
        weeks_per_position: 1,
        weekly_pins: [],
        rotation_blocks: [],
        rotation_members: [],
      },
    ],
  );

  // Period-snapshot only: "no se aplica en este período". When true
  // the slot doesn't run for any date inside the period — no demand,
  // no assignments. The rest of the form stays populated so the
  // snapshot is still valid if admin toggles dismissed off later.
  const [dismissed, setDismissed] = useState<boolean>(
    mode === "period-snapshot" ? props.snapshot?.dismissed ?? false : false,
  );

  // The slot-level headcount the list view shows and the rules
  // editor sizes positions against. Mirrors what save.mutate()
  // commits below.
  const derivedHeadcount = useMemo<number>(() => {
    if (staffingMode === "single") return 1;
    if (staffingMode === "team_composition") {
      return Math.max(
        1,
        teamRoles.reduce((acc, r) => acc + (r.headcount || 0), 0),
      );
    }
    return Math.max(1, Number(headcount) || 1);
  }, [staffingMode, teamRoles, headcount]);

  const save = useMutation({
    mutationFn: async () => {
      // Shared body fields between SlotInput and
      // SlotPeriodSnapshotUpsert. The only differences are:
      //   - SlotInput needs `name` (and optionally department_id),
      //   - SlotPeriodSnapshotUpsert needs `dismissed`,
      //   - SlotPeriodSnapshotUpsert carries `rules` inline,
      //   - SlotInput requires a separate replaceSlotRules call.
      const common = {
        days_applied: days,
        custom_days_bitmap: days === "custom" ? customDaysBitmap : null,
        staffing_mode: staffingMode,
        headcount: derivedHeadcount,
        counts_for_equity: countsEquity,
        guardia_type: guardiaType.trim() || null,
        color: color,
        start_time:
          scheduleMode === "ranged" && startTime ? `${startTime}:00` : null,
        end_time:
          scheduleMode === "ranged" && endTime ? `${endTime}:00` : null,
        team_roles:
          staffingMode === "team_composition" ? teamRoles : [],
        allowed_person_ids: allowedPersonIds,
        allowed_category_ids:
          staffingMode === "team_composition" ? [] : allowedCategoryIds,
      };

      if (mode === "default") {
        const body: SlotInput = {
          name,
          ...common,
        };
        const slot = props.initial
          ? await api.updateSlot(props.initial.id, body)
          : await api.createSlot(body);
        // Atomic rule replacement runs after the slot core is
        // saved. New slots get a default solver rule from the
        // server which we overwrite here (often a no-op).
        const ruleInputs: SlotRuleInput[] = rules.map(draftToInput);
        await api.replaceSlotRules(slot.id, ruleInputs);
        return slot;
      }

      // period-snapshot: one atomic PUT carries the slot config +
      // rules + dismissed flag. No separate rules call.
      const body: SlotPeriodSnapshotUpsert = {
        dismissed,
        ...common,
        rules: rules.map(draftToInput),
      };
      return api.upsertSlotPeriodSnapshot(
        props.periodId,
        props.baseSlot.id,
        body,
      );
    },
    onSuccess: () => {
      if (mode === "default") {
        qc.invalidateQueries({ queryKey: ["slots"] });
      } else {
        qc.invalidateQueries({
          queryKey: ["periodo", props.periodId, "snapshots"],
        });
      }
      onClose();
    },
  });

  // "Restablecer valores por defecto" only available in
  // period-snapshot mode and only when a snapshot already exists.
  // Deletes the snapshot row so the slot reverts to its defaults
  // for the period.
  const reset = useMutation({
    mutationFn: async () => {
      if (mode !== "period-snapshot" || !props.snapshot) return;
      await api.deleteSlotPeriodSnapshot(
        props.periodId,
        props.baseSlot.id,
      );
    },
    onSuccess: () => {
      if (mode === "period-snapshot") {
        qc.invalidateQueries({
          queryKey: ["periodo", props.periodId, "snapshots"],
        });
      }
      onClose();
    },
  });

  const ruleValidationError = validateRulesClient(rules, days, customDaysBitmap);

  function addTeamRole() {
    setTeamRoles((cur) => [
      ...cur,
      { role_label: "", headcount: 1, category_ids: [] },
    ]);
  }
  function updateTeamRole(i: number, patch: Partial<TeamRoleDraft>) {
    setTeamRoles((cur) =>
      cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
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

  function togglePerson(personId: number) {
    setAllowedPersonIds((cur) =>
      cur.includes(personId)
        ? cur.filter((id) => id !== personId)
        : [...cur, personId],
    );
  }

  /**
   * Pre-save check (default mode only). If the admin is reducing
   * the allow-list, warn about any rule references that the server
   * will cascade-delete. Period-snapshot mode skips this because
   * the snapshot's rules are replaced wholesale on save — there's
   * no surprise cascade.
   */
  function confirmAllowListCascade(): boolean {
    if (mode !== "default") return true;
    const initial = props.initial;
    if (!initial) return true; // new slot — no rules yet
    const previousIds = new Set(initial.allowed_person_ids);
    const newIds = new Set(allowedPersonIds);
    if (newIds.size === 0) return true;
    const removed = [...previousIds].filter((id) => !newIds.has(id));
    if (removed.length === 0) return true;
    const personNameById = new Map(
      team.map((m) => [
        m.person_id,
        personLastName({ name: m.person_name }),
      ]),
    );
    const lines: string[] = [];
    for (const pid of removed) {
      const pinDays: string[] = [];
      let rotationCount = 0;
      for (const r of initial.rules) {
        for (const p of r.weekly_pins) {
          if (p.person_id === pid) {
            pinDays.push(DAY_LABELS[p.weekday]?.short ?? `d${p.weekday}`);
          }
        }
        for (const m of r.rotation_members) {
          if (m.person_id === pid) rotationCount += 1;
        }
      }
      if (pinDays.length === 0 && rotationCount === 0) continue;
      const fragments: string[] = [];
      if (pinDays.length > 0) {
        fragments.push(`${pinDays.length} pin (${pinDays.join(", ")})`);
      }
      if (rotationCount > 0) {
        fragments.push(`${rotationCount} posición en rotación`);
      }
      const personName = personNameById.get(pid) ?? `#${pid}`;
      lines.push(`  • ${personName}: ${fragments.join(" + ")}`);
    }
    if (lines.length === 0) return true;
    return confirm(
      `Al quitar a estas personas del equipo autorizado se eliminarán las siguientes asignaciones en reglas:\n\n`
      + lines.join("\n")
      + "\n\n¿Continuar?",
    );
  }

  const title =
    mode === "default"
      ? props.initial
        ? "Editar actividad"
        : "Nueva actividad"
      : `Editar "${props.baseSlot.name}" en este período`;

  // In period-snapshot mode with dismissed=true the rest of the
  // form is informational only — the snapshot still persists every
  // field so toggling dismissed off later restores the full
  // override. We disable the inputs visually to make this clear.
  const fieldsDisabled = mode === "period-snapshot" && dismissed;

  return (
    <Modal open={true} onClose={onClose} title={title}>
      <form
        className="space-y-3 max-h-[70vh] overflow-y-auto pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!confirmAllowListCascade()) return;
          save.mutate();
        }}
      >
        {mode === "default" && (
          <TextField label="Nombre" value={name} onChange={setName} required />
        )}

        {mode === "period-snapshot" && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {props.snapshot ? (
              <>
                Esta actividad tiene una configuración propia para este
                período. Pulsa
                <span className="font-semibold"> Restablecer valores por defecto </span>
                abajo para volver a usar la configuración habitual.
              </>
            ) : (
              <>
                Estás viendo la configuración habitual de la actividad.
                Si guardas cambios aquí se aplicarán
                <span className="font-semibold"> solo durante este período</span>;
                la configuración por defecto no se toca.
              </>
            )}
          </div>
        )}

        {mode === "period-snapshot" && (
          <label className="flex items-start gap-2 rounded-md border bg-gray-50 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={dismissed}
              onChange={(e) => setDismissed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300"
            />
            <span>
              <span className="font-medium text-gray-800">
                No se aplica en este período
              </span>
              <span className="block text-xs text-gray-600">
                La actividad queda sin demanda durante el período. Trivu no
                generará turnos para ningún día.
              </span>
            </span>
          </label>
        )}

        <fieldset
          disabled={fieldsDisabled}
          className={fieldsDisabled ? "space-y-3 opacity-50" : "space-y-3"}
        >
        <div>
          <span className="text-sm font-medium text-gray-700">Horario</span>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={scheduleMode === "ranged"}
                onChange={() => {
                  setScheduleMode("ranged");
                  if (!startTime) setStartTime("08:00");
                  if (!endTime) setEndTime("15:00");
                }}
              />
              Horario específico
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={scheduleMode === "all_day"}
                onChange={() => setScheduleMode("all_day")}
              />
              Todo el día
            </label>
          </div>
          {scheduleMode === "ranged" && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <TextField label="Hora inicio" type="time" value={startTime} onChange={setStartTime} />
              <TextField label="Hora fin" type="time" value={endTime} onChange={setEndTime} />
            </div>
          )}
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
            label="Cuántas personas cubren esta actividad"
            hint={
              <>
                <strong>Una persona</strong>: consulta, planta.{" "}
                <strong>Varias del mismo perfil</strong>: dos
                enfermeros idénticos.{" "}
                <strong>Equipo con varios roles</strong>: quirófano
                con cirujano + anestesia + instrumentista.
              </>
            }
            value={staffingMode}
            onChange={(v) => {
              if (!v) return;
              const next = v as StaffingMode;
              setStaffingMode(next);
              if (next === "single") setHeadcount("1");
            }}
            options={STAFFING.map((s) => ({ value: s.value, label: s.label }))}
          />
          <p className="mt-1 text-xs text-gray-500">
            {staffingMode === "single" &&
              "Una sola persona cubre cada turno de esta actividad."}
            {staffingMode === "multiple_same" &&
              "Varias personas con el mismo perfil cubren cada turno. Indica cuántas personas hay por turno."}
            {staffingMode === "team_composition" &&
              "Equipo con varios roles. Define los roles abajo; cada uno tiene su propia cantidad de personas por turno y su categoría."}
          </p>
        </div>
        {staffingMode === "multiple_same" && (
          <TextField
            label="Plazas"
            hint="Cuántas personas están de turno a la vez para esta actividad. Ej: planta con 3 enfermeras simultáneas en cada turno → 3."
            type="number"
            value={headcount}
            onChange={setHeadcount}
          />
        )}
        {staffingMode === "team_composition" && (
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
                    hint="Personas de este rol simultáneamente en cada turno. Ej: quirófano con 2 cirujanos a la vez → 2."
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
        <div>
          <span className="text-sm font-medium text-gray-700">Color</span>
          <SlotColorPicker value={color} onChange={setColor} />
          <p className="mt-1 text-xs text-gray-500">
            Punto coloreado junto al nombre de la actividad en la planificación.
            Opcional.
          </p>
        </div>

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
                    weeks_per_position: 1,
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
          {staffingMode === "team_composition" && (
            <p className="mb-2 rounded border border-brand-200 bg-brand-50 p-2 text-xs text-brand-800">
              En este modo cada posición de la rotación / día fijo es un{" "}
              <strong>equipo</strong> del tamaño total de la actividad (suma de las
              plazas de todos los roles). Trivu decide qué persona del
              equipo cubre cada rol cada día, rotando los roles entre ellas
              (Latin-square) a lo largo del bloque de días.
            </p>
          )}
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
              headcount={derivedHeadcount}
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

        {staffingMode !== "team_composition" && (
          <AllowedCategoriesSection
            categories={categories}
            selected={allowedCategoryIds}
            onToggle={(cid) =>
              setAllowedCategoryIds((cur) =>
                cur.includes(cid)
                  ? cur.filter((x) => x !== cid)
                  : [...cur, cid],
              )
            }
            onClear={() => setAllowedCategoryIds([])}
          />
        )}

        <AllowedPersonsSection
          team={team}
          allowedCategoryIds={
            staffingMode === "team_composition"
              ? (() => {
                  const anyRoleUnrestricted = teamRoles.some(
                    (r) => r.category_ids.length === 0,
                  );
                  if (anyRoleUnrestricted) return null;
                  const u = new Set<number>();
                  for (const r of teamRoles) {
                    for (const cid of r.category_ids) u.add(cid);
                  }
                  return u.size > 0 ? u : null;
                })()
              : allowedCategoryIds.length > 0
                ? new Set(allowedCategoryIds)
                : null
          }
          allowedPersonIds={allowedPersonIds}
          setAllowedPersonIds={setAllowedPersonIds}
          togglePerson={togglePerson}
        />
        </fieldset>

        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        {reset.isError && <ErrorText>{(reset.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-white">
          {mode === "period-snapshot" && props.snapshot && (
            <Button
              variant="secondary"
              onClick={() => {
                if (
                  confirm(
                    "Se eliminará la configuración personalizada del período y la actividad volverá a sus valores por defecto. ¿Continuar?",
                  )
                ) {
                  reset.mutate();
                }
              }}
              disabled={reset.isPending}
            >
              {reset.isPending ? "Restableciendo…" : "Restablecer valores por defecto"}
            </Button>
          )}
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
// CustomDaysPicker
// ---------------------------------------------------------------------------

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
// RuleCard
// ---------------------------------------------------------------------------

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
    if (rule.strategy === "solver") return "Reparto equitativo";
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
                    ? `${long} — fuera del alcance de la actividad`
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
            {
              v: "solver",
              label: "Reparto equitativo",
              hint:
                "Trivu reparte los turnos entre las personas elegibles "
                + "buscando que todos hagan un número parecido a lo "
                + "largo del periodo. No fija a nadie a un día concreto.",
            },
            {
              v: "fixed_weekly",
              label: "Día fijo",
              hint:
                "Asignas a mano qué persona cubre cada día de la "
                + "semana. Útil cuando el mismo Adjunto hace Consulta "
                + "todos los lunes, por ejemplo.",
            },
            {
              v: "rotation",
              label: "Rotación",
              hint:
                "Defines un grupo de personas que rotan en orden "
                + "(cada semana / N semanas). Útil para guardias "
                + "donde el orden importa pero quieres que todos "
                + "pasen por ahí.",
            },
            {
              v: "manual",
              label: "Manual",
              hint:
                "Trivu no propone nada; los huecos se quedan vacíos "
                + "y los rellenas a mano en la planificación.",
            },
          ] as { v: SlotRuleStrategy; label: string; hint: string }[]
        ).map((opt) => (
          <label key={opt.v} className="flex items-center gap-1">
            <input
              type="radio"
              checked={rule.strategy === opt.v}
              onChange={() => setStrategy(opt.v)}
            />
            {opt.label}
            <InfoHint>{opt.hint}</InfoHint>
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

// ---------------------------------------------------------------------------
// FixedWeeklyEditor
// ---------------------------------------------------------------------------

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
  const setPinAt = (weekday: number, idx: number, person_id: number | null) => {
    const all = [...rule.weekly_pins];
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
        const exceedsDefault = pinsForDay.length > headcount;
        return (
          <div key={d.bit} className="rounded border bg-white p-2 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium text-gray-700">
                {d.long}
                <span
                  className={
                    "ml-1 font-normal "
                    + (exceedsDefault ? "text-amber-600" : "text-gray-400")
                  }
                  title={
                    exceedsDefault
                      ? `Este día tiene ${pinsForDay.length} personas, por encima de la plantilla por defecto del turno (${headcount}). Permitido en Día fijo; el planning emitirá una asignación por persona.`
                      : undefined
                  }
                >
                  ({pinsForDay.length}
                  {exceedsDefault ? "" : `/${headcount}`})
                </span>
              </span>
              <button
                type="button"
                onClick={() => addPin(d.bit)}
                disabled={
                  team.length === 0
                  || pinsForDay.length >= team.length
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
                      label: personLastName({ name: m.person_name }),
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
            {pinsForDay.length < headcount && (
              <p className="mt-1 text-amber-700">
                {d.long}: {pinsForDay.length} persona{pinsForDay.length === 1 ? "" : "s"}
                {" "}asignada{pinsForDay.length === 1 ? "" : "s"} (la actividad requiere{" "}
                {headcount}).
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RotationEditor
// ---------------------------------------------------------------------------

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
  const [selectedPreset, setSelectedPreset] = useState<string>(() =>
    detectRotationPreset(rule.rotation_blocks, rule.days_bitmap),
  );
  const applyPreset = (preset: string) => {
    setSelectedPreset(preset);
    if (preset === "custom" || preset === "") {
      return;
    }
    onChange({ rotation_blocks: blocksFromPreset(preset, rule.days_bitmap) });
  };

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
    if (allUsedPersonIds.has(newPersonId)) return;
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
          value={selectedPreset}
          onChange={(v) => applyPreset(String(v))}
          options={[
            { value: "", label: "Aplicar plantilla…" },
            ...ROT_PRESETS.map((p) => ({ value: p.value, label: p.label })),
          ]}
        />
      </div>
      <div className="mt-1">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Cada cuántas semanas avanza la rotación
            <InfoHint>
              Por defecto 1: cada posición de la rotación cubre 1
              semana antes de pasar a la siguiente persona. Con 2,
              cada persona se queda 2 semanas seguidas antes de
              relevar; con 4, un mes; etc. Útil para rotaciones
              largas (guardia mensual, supervisión de planta) donde
              cambiar cada semana es demasiado overhead.
            </InfoHint>
          </span>
          <input
            type="number"
            min={1}
            max={52}
            value={rule.weeks_per_position}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && n <= 52) {
                onChange({ weeks_per_position: n });
              }
            }}
            className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
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
                    || members.length >= headcount
                  }
                  title={
                    members.length >= headcount
                      ? `Esta posición ya tiene ${headcount} persona${headcount === 1 ? "" : "s"} (el máximo de la actividad). Añade otra posición para más personas en la rotación.`
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
                  .map((t) => ({
                    value: t.person_id,
                    label: personLastName({ name: t.person_name }),
                  }));
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
                  {members.length === 1 ? "" : "s"} (la actividad requiere {headcount}).
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlotColorPicker
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AllowedCategoriesSection
// ---------------------------------------------------------------------------

function AllowedCategoriesSection({
  categories,
  selected,
  onToggle,
  onClear,
}: {
  categories: Category[];
  selected: number[];
  onToggle: (cid: number) => void;
  onClear: () => void;
}) {
  const isUnrestricted = selected.length === 0;
  const [open, setOpen] = useState<boolean>(!isUnrestricted);
  const sortedCats = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, "es"),
  );
  return (
    <div className="border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-gray-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-500" />
          )}
          <h3 className="text-sm font-semibold">
            Categorías que pueden cubrir esta actividad
          </h3>
        </div>
        <span
          className={
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium "
            + (isUnrestricted
              ? "bg-gray-100 text-gray-700"
              : "bg-brand-100 text-brand-700")
          }
        >
          {isUnrestricted
            ? "Cualquier categoría"
            : `${selected.length} ${selected.length === 1 ? "categoría" : "categorías"}`}
        </span>
      </button>
      {open && (
        <div className="mt-3">
          <div className="flex items-start justify-between gap-3 mb-2">
            <p className="text-xs text-gray-500 flex-1">
              Por defecto cualquier categoría puede cubrir esta actividad.
              Si sólo algunas deben poder hacerlo, márcalas aquí.
            </p>
            {!isUnrestricted && (
              <button
                type="button"
                onClick={onClear}
                className="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 whitespace-nowrap"
              >
                Permitir cualquier categoría
              </button>
            )}
          </div>
          {sortedCats.length === 0 ? (
            <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
              Aún no hay categorías. Crea categorías en /admin/categorias.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sortedCats.map((c) => {
                const checked = selected.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs cursor-pointer "
                      + (checked
                        ? "border-brand-300 bg-brand-50 text-brand-800"
                        : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(c.id)}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                    />
                    {c.name}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AllowedPersonsSection
// ---------------------------------------------------------------------------

function AllowedPersonsSection({
  team,
  allowedCategoryIds,
  allowedPersonIds,
  setAllowedPersonIds,
  togglePerson,
}: {
  team: TeamMember[];
  allowedCategoryIds: Set<number> | null;
  allowedPersonIds: number[];
  setAllowedPersonIds: (ids: number[]) => void;
  togglePerson: (personId: number) => void;
}) {
  const isUnrestricted = allowedPersonIds.length === 0;
  const [open, setOpen] = useState<boolean>(!isUnrestricted);
  const sortedTeam = [...team]
    .filter((m) => !m.disabled_at)
    .filter((m) => {
      if (allowedCategoryIds === null) return true;
      if (m.category_id === null) return true;
      return allowedCategoryIds.has(m.category_id);
    })
    .sort((a, b) => a.person_name.localeCompare(b.person_name, "es"));
  return (
    <div className="border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-gray-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-500" />
          )}
          <h3 className="text-sm font-semibold">Equipo autorizado</h3>
        </div>
        <span
          className={
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium "
            + (isUnrestricted
              ? "bg-gray-100 text-gray-700"
              : "bg-brand-100 text-brand-700")
          }
        >
          {isUnrestricted
            ? "Todo el equipo"
            : `${allowedPersonIds.length} ${allowedPersonIds.length === 1 ? "persona" : "personas"}`}
        </span>
      </button>
      {open && (
        <div className="mt-3">
          <div className="flex items-start justify-between gap-3 mb-2">
            <p className="text-xs text-gray-500 flex-1">
              Por defecto cualquier miembro puede cubrir esta actividad. Si
              sólo algunas personas deben poder hacerlo, márcalas aquí.
            </p>
            {!isUnrestricted && (
              <button
                type="button"
                onClick={() => setAllowedPersonIds([])}
                className="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 whitespace-nowrap"
              >
                Permitir a todo el equipo
              </button>
            )}
          </div>
          <ul className="rounded-md border bg-white divide-y divide-gray-100 max-h-56 overflow-y-auto">
            {sortedTeam.map((m) => {
              const checked = allowedPersonIds.includes(m.person_id);
              return (
                <li key={m.person_id}>
                  <label className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={isUnrestricted || checked}
                      onChange={() => togglePerson(m.person_id)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <span className={isUnrestricted ? "text-gray-700" : "text-gray-900"}>
                      {personLastName({ name: m.person_name })}
                    </span>
                    {m.category_name && (
                      <span className="text-xs text-gray-500">
                        · {m.category_name}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
            {team.length === 0 && (
              <li className="px-3 py-2 text-xs text-gray-500">
                Aún no hay miembros en el equipo.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

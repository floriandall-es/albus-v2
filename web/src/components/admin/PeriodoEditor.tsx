"use client";
// Shared periodo-especial editor body.
//
// Rendered inline inside /admin/schedule's vacation card. Owns the
// Actividades + Reglas tabs, the Generate button + touched-months
// confirm, and the Eliminar action. The parent decides what to do
// after a successful generate (typically: collapse the surrounding
// card + show a banner above the existing-planificaciones table).
import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Play, Trash2 } from "lucide-react";
import {
  api,
  type CapPeriodOverride,
  type CapPeriodOverrideUpsert,
  type DependencySeverity,
  type FrequencyPeriod,
  type GeneratePeriodResult,
  type Periodo,
  type Slot,
  type SlotFrequencyCap,
  type SlotPeriodSnapshot,
  type SlotSuccessionRule,
  type SuccessionPeriodOverride,
  type SuccessionPeriodOverrideUpsert,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  InfoHint,
  Modal,
  StatusPill,
} from "@/components/admin/ui";
import { SlotDialog } from "@/components/admin/SlotDialog";

// Label maps mirroring /admin/rules — keep the wording consistent
// across the two surfaces so the admin doesn't have to re-learn.
const SEVERITY_LABEL: Record<DependencySeverity, string> = {
  hard: "Estricta",
  soft: "Blanda",
};
const PERIOD_LABEL: Record<FrequencyPeriod, string> = {
  rolling_7: "Móvil 7 días",
  rolling_14: "Móvil 14 días",
  rolling_28: "Móvil 28 días",
  iso_week: "Semana ISO",
  calendar_month: "Mes natural",
};

type EditorTab = "actividades" | "reglas";

/**
 * Periodo-especial editor body.
 *
 * Tabs:
 *   - Actividades: per-(period, slot) snapshot of the full slot+rules
 *     config. Same SlotDialog the admin uses on /admin/slots, opened
 *     in mode='period-snapshot' so the visual language is identical.
 *   - Reglas: per-(period, succession/cap) delta overrides (those
 *     rules are tenant-scoped, so a delta model still fits).
 *
 * The "Generar período" button at the bottom fires the multi-month
 * CP-SAT solve for every full month touched by the periodo's date
 * range. On success the parent's `onGenerated` callback fires —
 * /admin/schedule uses it to collapse the surrounding card and show
 * a success banner above its existing-planificaciones table.
 */
export function PeriodoEditor({
  periodo,
  onGenerated,
  onDeleted,
}: {
  periodo: Periodo;
  /** Called with the generated schedules on a successful solve.
   * Parent decides what to render afterwards (collapse the card,
   * show a banner, etc.). */
  onGenerated?: (results: GeneratePeriodResult[]) => void;
  /** Called after the periodo is deleted (admin pressed the trash
   * button + confirmed). Parent should remove the periodo from its
   * list and collapse the editor. */
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();

  const slots = useQuery({
    queryKey: ["slots"],
    queryFn: () => api.listSlots(),
  });

  // Touched months — admin should see what "Generar" is about to do
  // before pressing the button. Matches generate_period server-side:
  // every (year, month) covered by [start, end] inclusive.
  const touchedMonths = useMemo(() => {
    const s = new Date(periodo.start_date + "T00:00:00");
    const e = new Date(periodo.end_date + "T00:00:00");
    const out: { year: number; month: number; label: string }[] = [];
    let y = s.getFullYear();
    let m = s.getMonth();
    const endY = e.getFullYear();
    const endM = e.getMonth();
    while (y < endY || (y === endY && m <= endM)) {
      out.push({
        year: y,
        month: m + 1,
        label: new Date(y, m, 1).toLocaleDateString("es-ES", {
          month: "long",
          year: "numeric",
        }),
      });
      if (m === 11) {
        y += 1;
        m = 0;
      } else {
        m += 1;
      }
    }
    return out;
  }, [periodo.start_date, periodo.end_date]);

  const [generateError, setGenerateError] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: () => api.generatePeriodo(periodo.id),
    onSuccess: (result) => {
      setGenerateError(null);
      qc.invalidateQueries({ queryKey: ["schedules"] });
      onGenerated?.(result);
    },
    onError: (e) => {
      setGenerateError((e as Error).message);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deletePeriodo(periodo.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["periodos"] });
      onDeleted?.();
    },
  });

  // Avoid name suppression: the parent row already shows
  // `periodo.name` and `dateRange` in its clickable header, so the
  // editor's own header doesn't repeat them. It just carries the
  // helper text + the Eliminar button. The three regions (header,
  // body, footer) get distinct tints so the eye stops reading the
  // whole modal as one blob.
  return (
    <div>
      {/* Header strip: helper text + Eliminar. Warm amber tint
          (matches the "you're editing a period config" semantics
          carried by the same colour on the SlotDialog banner) so
          the band reads clearly as a distinct edit-context region,
          not as part of the white body below. items-center keeps
          the multi-line helper text vertically centred against the
          taller Eliminar button. */}
      <div className="flex flex-wrap items-center gap-3 border-b-2 border-amber-200 bg-amber-50 px-4 py-3">
        <p className="min-w-0 flex-1 text-xs text-amber-900">
          Ajusta abajo qué actividades se desactivan, cambian sus
          plazas o relajan sus restricciones durante este periodo.
          Lo que no toques mantiene su configuración por defecto.
        </p>
        <Button
          variant="danger"
          onClick={() => {
            if (
              confirm(
                `¿Eliminar el periodo "${periodo.name}"? Esto borra todas sus configuraciones específicas, pero las planificaciones ya generadas no se tocan.`,
              )
            ) {
              remove.mutate();
            }
          }}
          disabled={remove.isPending}
        >
          <Trash2 className="h-4 w-4" />
          {remove.isPending ? "Eliminando…" : "Eliminar"}
        </Button>
      </div>

      {/* Body: errors + tabs. White on the surrounding gray so the
          working area reads as a "page" sitting on the row. */}
      <div className="space-y-3 bg-white px-4 py-4">
        {generateError && <ErrorText>{generateError}</ErrorText>}
        {remove.isError && (
          <ErrorText>{(remove.error as Error).message}</ErrorText>
        )}
        <EditorTabs periodo={periodo} slots={slots.data ?? []} />
      </div>

      {/* Footer strip: months-to-touch hint + Generate button.
          Matching amber tint to the header band so they bookend the
          working area as one cohesive "you are editing this period"
          frame. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-xs text-amber-900">
          Generará {touchedMonths.length}{" "}
          {touchedMonths.length === 1 ? "planificación" : "planificaciones"}:{" "}
          {touchedMonths.map((t) => t.label).join(", ")}.
        </p>
        <Button
          onClick={() => {
            if (
              confirm(
                `Esto generará ${touchedMonths.length} planificación${touchedMonths.length === 1 ? "" : "es"} (${touchedMonths.map((t) => t.label).join(", ")}). Si ya existen borradores, se sobrescribirán; las celdas bloqueadas se conservan. Planificaciones publicadas o archivadas detienen la operación. ¿Continuar?`,
              )
            ) {
              generate.mutate();
            }
          }}
          disabled={generate.isPending}
        >
          <Play className="h-4 w-4" />
          {generate.isPending ? "Generando…" : "Generar período"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabbed body. One panel per override category. Queries live INSIDE each
// panel so opening a tab the admin doesn't care about doesn't fan out to
// extra fetches.
// ---------------------------------------------------------------------------
function EditorTabs({
  periodo,
  slots,
}: {
  periodo: Periodo;
  slots: Slot[];
}) {
  const [tab, setTab] = useState<EditorTab>("actividades");

  return (
    <>
      <nav className="mt-6 mb-3 flex flex-wrap gap-1 border-b border-gray-200">
        {(
          [
            { key: "actividades", label: "Actividades" },
            { key: "reglas", label: "Reglas" },
          ] as { key: EditorTab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              "px-3 py-2 -mb-px text-sm font-medium border-b-2 transition-colors "
              + (tab === key
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-gray-500 hover:text-gray-800")
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "actividades" && (
        <ActividadesTab periodo={periodo} slots={slots} />
      )}
      {tab === "reglas" && <ReglasTab periodo={periodo} slots={slots} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Actividades tab — per-(period, slot) snapshot CRUD.
//
// One row per slot. The row shows a status pill summarising what (if
// anything) the period changes about the slot. Clicking "Editar"
// opens the shared SlotDialog in mode='period-snapshot' — same UI
// the admin uses on /admin/slots, so there's nothing new to learn.
// ---------------------------------------------------------------------------
function ActividadesTab({
  periodo,
  slots,
}: {
  periodo: Periodo;
  slots: Slot[];
}) {
  const snapshots = useQuery({
    queryKey: ["periodo", periodo.id, "snapshots"],
    queryFn: () => api.listSlotPeriodSnapshots(periodo.id),
  });
  const snapshotBySlot = useMemo(() => {
    const m = new Map<number, SlotPeriodSnapshot>();
    for (const s of snapshots.data ?? []) m.set(s.slot_id, s);
    return m;
  }, [snapshots.data]);

  // SlotDialog needs categories + team for the same pickers the
  // /admin/slots editor exposes. Load them once here.
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  return (
    <ul className="space-y-2">
      {slots
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((slot) => (
          <SlotSnapshotRow
            key={slot.id}
            slot={slot}
            snapshot={snapshotBySlot.get(slot.id) ?? null}
            periodId={periodo.id}
            categories={cats.data ?? []}
            team={team.data ?? []}
          />
        ))}
    </ul>
  );
}

function SlotSnapshotRow({
  slot,
  snapshot,
  periodId,
  categories,
  team,
}: {
  slot: Slot;
  snapshot: SlotPeriodSnapshot | null;
  periodId: number;
  categories: import("@/lib/api").Category[];
  team: import("@/lib/api").TeamMember[];
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: slot.color ?? "#9ca3af" }}
          />
          <span className="text-sm font-semibold text-gray-900">
            {slot.name}
          </span>
          <span className="text-xs text-gray-500">
            {slot.staffing_mode === "team_composition"
              ? `${slot.team_roles.length} roles`
              : `${slot.headcount} plaza${slot.headcount === 1 ? "" : "s"}`}
          </span>
          {snapshot?.dismissed ? (
            <StatusPill tone="danger">No aplica en el periodo</StatusPill>
          ) : snapshot ? (
            <StatusPill tone="warning">Personalizada</StatusPill>
          ) : null}
          <div className="ml-auto">
            <Button variant="secondary" onClick={() => setModalOpen(true)}>
              Editar
            </Button>
          </div>
        </div>
      </Card>
      {modalOpen && (
        <SlotDialog
          mode="period-snapshot"
          baseSlot={slot}
          snapshot={snapshot}
          periodId={periodId}
          categories={categories}
          team={team}
          onClose={() => setModalOpen(false)}
        />
      )}
    </li>
  );
}


// ---------------------------------------------------------------------------
// Reglas tab — succession + frequency cap delta overrides.
//
// Visual layout mirrors /admin/rules: three rounded-xl section cards, one
// per rule type, each holding a table of the tenant's rules with an extra
// "Modificación" column that summarises what (if anything) the period
// changes. A "Modificar" button per row opens a modal carrying the
// override form. Per-SlotRule overrides moved to the V.2.5 snapshot
// model (they're part of the slot's full config now, inside SlotDialog).
// ---------------------------------------------------------------------------
function ReglasTab({
  periodo,
  slots,
}: {
  periodo: Periodo;
  slots: Slot[];
}) {
  const successionRules = useQuery({
    queryKey: ["succession-rules"],
    queryFn: api.listSuccessionRules,
  });
  const successionOverrides = useQuery({
    queryKey: ["periodo-succession-overrides", periodo.id],
    queryFn: () => api.listSuccessionPeriodOverrides(periodo.id),
  });
  const succOverrideByRule = useMemo(() => {
    const m = new Map<number, SuccessionPeriodOverride>();
    for (const o of successionOverrides.data ?? [])
      m.set(o.succession_rule_id, o);
    return m;
  }, [successionOverrides.data]);

  const caps = useQuery({
    queryKey: ["frequency-caps"],
    queryFn: api.listFrequencyCaps,
  });
  const capOverrides = useQuery({
    queryKey: ["periodo-cap-overrides", periodo.id],
    queryFn: () => api.listCapPeriodOverrides(periodo.id),
  });
  const capOverrideByCap = useMemo(() => {
    const m = new Map<number, CapPeriodOverride>();
    for (const o of capOverrides.data ?? []) m.set(o.cap_id, o);
    return m;
  }, [capOverrides.data]);

  const slotById = useMemo(() => {
    const m: Record<number, Slot> = {};
    for (const s of slots) m[s.id] = s;
    return m;
  }, [slots]);

  // Same split /admin/rules uses: same-day incompatibility (days_after=0)
  // sits separately from "X then no Y for N days" succession (days_after>=1).
  const incompat = (successionRules.data ?? []).filter(
    (r) => r.days_after === 0,
  );
  const succession = (successionRules.data ?? []).filter(
    (r) => r.days_after >= 1,
  );

  return (
    <div className="space-y-6">
      <SameDayOverrideSection
        rules={incompat}
        loading={successionRules.isLoading}
        error={
          successionRules.isError
            ? (successionRules.error as Error).message
            : null
        }
        overrideByRule={succOverrideByRule}
        slotById={slotById}
        periodId={periodo.id}
      />
      <SuccessionOverrideSection
        rules={succession}
        loading={successionRules.isLoading}
        error={
          successionRules.isError
            ? (successionRules.error as Error).message
            : null
        }
        overrideByRule={succOverrideByRule}
        slotById={slotById}
        periodId={periodo.id}
      />
      <CapOverrideSection
        caps={caps.data ?? []}
        loading={caps.isLoading}
        error={caps.isError ? (caps.error as Error).message : null}
        overrideByCap={capOverrideByCap}
        slotById={slotById}
        periodId={periodo.id}
      />
    </div>
  );
}

// Tiny status helper used in the override summary cells. Returns null
// when the row has no override (renders as "—" in the cell).
function summariseSuccessionOverride(
  o: SuccessionPeriodOverride | null,
): React.ReactNode {
  if (!o) return <span className="text-gray-400">—</span>;
  if (o.disabled) {
    return <StatusPill tone="danger">Desactivada</StatusPill>;
  }
  const fragments: string[] = [];
  if (o.days_after_override !== null && o.days_after_override !== undefined) {
    fragments.push(`${o.days_after_override} d`);
  }
  if (o.severity_override) {
    fragments.push(SEVERITY_LABEL[o.severity_override]);
  }
  if (fragments.length === 0) {
    return <StatusPill tone="warning">Modificada</StatusPill>;
  }
  return <StatusPill tone="warning">→ {fragments.join(" · ")}</StatusPill>;
}

function summariseCapOverride(
  o: CapPeriodOverride | null,
): React.ReactNode {
  if (!o) return <span className="text-gray-400">—</span>;
  if (o.disabled) {
    return <StatusPill tone="danger">Desactivado</StatusPill>;
  }
  const fragments: string[] = [];
  if (o.max_count_override !== null && o.max_count_override !== undefined) {
    fragments.push(`máx ${o.max_count_override}`);
  }
  if (o.severity_override) {
    fragments.push(SEVERITY_LABEL[o.severity_override]);
  }
  if (fragments.length === 0) {
    return <StatusPill tone="warning">Modificado</StatusPill>;
  }
  return <StatusPill tone="warning">→ {fragments.join(" · ")}</StatusPill>;
}

// ---------------------------------------------------------------------------
// Same-day incompatibility overrides (days_after = 0). Mirrors the
// SameDaySection layout in /admin/rules so the admin recognises the
// shape: rounded-xl section card, header with InfoHint, table with
// per-row Modificar button.
// ---------------------------------------------------------------------------
function SameDayOverrideSection({
  rules,
  loading,
  error,
  overrideByRule,
  slotById,
  periodId,
}: {
  rules: SlotSuccessionRule[];
  loading: boolean;
  error: string | null;
  overrideByRule: Map<number, SuccessionPeriodOverride>;
  slotById: Record<number, Slot>;
  periodId: number;
}) {
  const [editing, setEditing] = useState<SlotSuccessionRule | null>(null);

  return (
    <section className="rounded-xl bg-white p-5 ring-1 ring-gray-200 shadow-soft">
      <div className="flex items-center mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center">
          Incompatibilidades del mismo día
          <InfoHint position="below">
            Reglas que prohíben combinar dos actividades el mismo día.
            Aquí no creas reglas nuevas — eliges, para este periodo,
            cuáles se desactivan o se relajan.
          </InfoHint>
        </h2>
      </div>
      {loading && <p className="text-sm text-gray-500">Cargando…</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {!loading && rules.length === 0 && (
        <Empty>No hay incompatibilidades del mismo día definidas.</Empty>
      )}
      {rules.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Actividad</th>
                <th className="px-4 py-2 font-medium">No se puede combinar con</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Modificación en el periodo</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const override = overrideByRule.get(r.id) ?? null;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-4 py-2">
                      {slotById[r.after_slot_id]?.name ?? `#${r.after_slot_id}`}
                    </td>
                    <td className="px-4 py-2">
                      {slotById[r.forbid_slot_id]?.name ?? `#${r.forbid_slot_id}`}
                    </td>
                    <td className="px-4 py-2">{SEVERITY_LABEL[r.severity]}</td>
                    <td className="px-4 py-2">
                      {summariseSuccessionOverride(override)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="secondary"
                        onClick={() => setEditing(r)}
                      >
                        {override ? "Editar" : "Modificar"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SuccessionOverrideModal
          rule={editing}
          initial={overrideByRule.get(editing.id) ?? null}
          periodId={periodId}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Multi-day succession overrides (days_after >= 1). Same shape as
// SameDayOverrideSection, different summary copy.
// ---------------------------------------------------------------------------
function SuccessionOverrideSection({
  rules,
  loading,
  error,
  overrideByRule,
  slotById,
  periodId,
}: {
  rules: SlotSuccessionRule[];
  loading: boolean;
  error: string | null;
  overrideByRule: Map<number, SuccessionPeriodOverride>;
  slotById: Record<number, Slot>;
  periodId: number;
}) {
  const [editing, setEditing] = useState<SlotSuccessionRule | null>(null);

  return (
    <section className="rounded-xl bg-white p-5 ring-1 ring-gray-200 shadow-soft">
      <div className="flex items-center mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center">
          Sucesión entre actividades
          <InfoHint position="below">
            Reglas del tipo &quot;después de X, no Y durante N días&quot;.
            Útil acortar el descanso obligatorio cuando la plantilla está
            reducida, o desactivar la regla entera durante el periodo.
          </InfoHint>
        </h2>
      </div>
      {loading && <p className="text-sm text-gray-500">Cargando…</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {!loading && rules.length === 0 && (
        <Empty>No hay reglas de sucesión definidas.</Empty>
      )}
      {rules.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Después de</th>
                <th className="px-4 py-2 font-medium">No se puede</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Modificación en el periodo</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const override = overrideByRule.get(r.id) ?? null;
                return (
                  <tr
                    key={r.id}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-4 py-2">
                      {slotById[r.after_slot_id]?.name ?? `#${r.after_slot_id}`}
                    </td>
                    <td className="px-4 py-2">
                      {slotById[r.forbid_slot_id]?.name ?? `#${r.forbid_slot_id}`}
                    </td>
                    <td className="px-4 py-2">{r.days_after}</td>
                    <td className="px-4 py-2">{SEVERITY_LABEL[r.severity]}</td>
                    <td className="px-4 py-2">
                      {summariseSuccessionOverride(override)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="secondary"
                        onClick={() => setEditing(r)}
                      >
                        {override ? "Editar" : "Modificar"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SuccessionOverrideModal
          rule={editing}
          initial={overrideByRule.get(editing.id) ?? null}
          periodId={periodId}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Frequency cap overrides. Same section-card shape as the two above.
// ---------------------------------------------------------------------------
function CapOverrideSection({
  caps,
  loading,
  error,
  overrideByCap,
  slotById,
  periodId,
}: {
  caps: SlotFrequencyCap[];
  loading: boolean;
  error: string | null;
  overrideByCap: Map<number, CapPeriodOverride>;
  slotById: Record<number, Slot>;
  periodId: number;
}) {
  const [editing, setEditing] = useState<SlotFrequencyCap | null>(null);

  return (
    <section className="rounded-xl bg-white p-5 ring-1 ring-gray-200 shadow-soft">
      <div className="flex items-center mb-3">
        <h2 className="text-lg font-semibold inline-flex items-center">
          Límites de frecuencia
          <InfoHint position="below">
            Topes del tipo &quot;como máximo N de X por persona en este
            periodo&quot;. Suele necesitar relajación cuando la plantilla
            se reduce (ej. 2 guardias/mes → 5/mes en verano).
          </InfoHint>
        </h2>
      </div>
      {loading && <p className="text-sm text-gray-500">Cargando…</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {!loading && caps.length === 0 && (
        <Empty>No hay límites de frecuencia definidos.</Empty>
      )}
      {caps.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Actividad</th>
                <th className="px-4 py-2 font-medium">Periodo</th>
                <th className="px-4 py-2 font-medium">Máx por persona</th>
                <th className="px-4 py-2 font-medium">Severidad</th>
                <th className="px-4 py-2 font-medium">Modificación en el periodo</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {caps.map((c) => {
                const override = overrideByCap.get(c.id) ?? null;
                return (
                  <tr
                    key={c.id}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-4 py-2">
                      {slotById[c.slot_id]?.name ?? `#${c.slot_id}`}
                    </td>
                    <td className="px-4 py-2">{PERIOD_LABEL[c.period]}</td>
                    <td className="px-4 py-2">{c.max_count}</td>
                    <td className="px-4 py-2">{SEVERITY_LABEL[c.severity]}</td>
                    <td className="px-4 py-2">
                      {summariseCapOverride(override)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="secondary"
                        onClick={() => setEditing(c)}
                      >
                        {override ? "Editar" : "Modificar"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CapOverrideModal
          cap={editing}
          initial={overrideByCap.get(editing.id) ?? null}
          periodId={periodId}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Succession override modal. Hosts the same form fields the V.2 inline
// edit had; now in a proper Modal so the row stays compact and the
// section table matches the layout of /admin/rules.
// ---------------------------------------------------------------------------
function SuccessionOverrideModal({
  rule,
  initial,
  periodId,
  onClose,
}: {
  rule: SlotSuccessionRule;
  initial: SuccessionPeriodOverride | null;
  periodId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [disabled, setDisabled] = useState(initial?.disabled ?? false);
  const [daysAfterStr, setDaysAfterStr] = useState<string>(
    initial?.days_after_override !== null
    && initial?.days_after_override !== undefined
      ? String(initial.days_after_override)
      : "",
  );
  const [severityOverride, setSeverityOverride] = useState<
    DependencySeverity | ""
  >(initial?.severity_override ?? "");

  const upsert = useMutation({
    mutationFn: (body: SuccessionPeriodOverrideUpsert) =>
      api.upsertSuccessionPeriodOverride(periodId, rule.id, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-succession-overrides", periodId],
      });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api.deleteSuccessionPeriodOverride(periodId, rule.id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-succession-overrides", periodId],
      });
      onClose();
    },
  });

  const title =
    rule.days_after === 0
      ? "Modificar incompatibilidad en el periodo"
      : "Modificar regla de sucesión en el periodo";

  return (
    <Modal open={true} onClose={onClose} title={title}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const days = daysAfterStr.trim() === "" ? null : Number(daysAfterStr);
          upsert.mutate({
            disabled,
            days_after_override:
              days !== null && !Number.isNaN(days) && days >= 0 && days <= 14
                ? days
                : null,
            severity_override:
              severityOverride === "" ? null : severityOverride,
          });
        }}
      >
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          <div>
            <div className="font-medium text-gray-900">
              Desactivar durante el periodo
            </div>
            <div className="text-xs text-gray-500">
              La regla no se aplica para fechas dentro del periodo.
            </div>
          </div>
        </label>

        {!disabled && rule.days_after >= 1 && (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Días después (0–14, opcional)
            </span>
            <input
              type="number"
              min="0"
              max="14"
              value={daysAfterStr}
              onChange={(e) => setDaysAfterStr(e.target.value)}
              placeholder={`${rule.days_after} (por defecto)`}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-gray-500">
              Vacío para mantener el valor por defecto ({rule.days_after}).
            </span>
          </label>
        )}

        {!disabled && (
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Severidad (opcional)
            </span>
            <select
              value={severityOverride}
              onChange={(e) =>
                setSeverityOverride(e.target.value as DependencySeverity | "")
              }
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">
                Mantener {SEVERITY_LABEL[rule.severity]} (por defecto)
              </option>
              <option value="hard">Estricta</option>
              <option value="soft">Blanda</option>
            </select>
            <span className="mt-1 block text-xs text-gray-500">
              Pasar de Estricta a Blanda deja que el solver rompa la regla
              si no hay alternativa (paga una penalización).
            </span>
          </label>
        )}

        {upsert.isError && (
          <ErrorText>{(upsert.error as Error).message}</ErrorText>
        )}
        {remove.isError && (
          <ErrorText>{(remove.error as Error).message}</ErrorText>
        )}
        <div className="flex justify-end gap-2 pt-2">
          {initial && (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm("¿Quitar esta modificación?")) remove.mutate();
              }}
              disabled={remove.isPending}
            >
              Quitar modificación
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={upsert.isPending}>
            {upsert.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cap override modal. Same idea as SuccessionOverrideModal; different fields.
// ---------------------------------------------------------------------------
function CapOverrideModal({
  cap,
  initial,
  periodId,
  onClose,
}: {
  cap: SlotFrequencyCap;
  initial: CapPeriodOverride | null;
  periodId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [disabled, setDisabled] = useState(initial?.disabled ?? false);
  const [maxCountStr, setMaxCountStr] = useState<string>(
    initial?.max_count_override !== null
    && initial?.max_count_override !== undefined
      ? String(initial.max_count_override)
      : "",
  );
  const [severityOverride, setSeverityOverride] = useState<
    DependencySeverity | ""
  >(initial?.severity_override ?? "");

  const upsert = useMutation({
    mutationFn: (body: CapPeriodOverrideUpsert) =>
      api.upsertCapPeriodOverride(periodId, cap.id, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-cap-overrides", periodId],
      });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCapPeriodOverride(periodId, cap.id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-cap-overrides", periodId],
      });
      onClose();
    },
  });

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Modificar límite en el periodo"
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const mc = maxCountStr.trim() === "" ? null : Number(maxCountStr);
          upsert.mutate({
            disabled,
            max_count_override:
              mc !== null && !Number.isNaN(mc) && mc >= 0 ? mc : null,
            severity_override:
              severityOverride === "" ? null : severityOverride,
          });
        }}
      >
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          <div>
            <div className="font-medium text-gray-900">
              Desactivar durante el periodo
            </div>
            <div className="text-xs text-gray-500">
              El límite no se aplica para fechas dentro del periodo.
            </div>
          </div>
        </label>

        {!disabled && (
          <>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Máximo durante el periodo (opcional)
              </span>
              <input
                type="number"
                min="0"
                value={maxCountStr}
                onChange={(e) => setMaxCountStr(e.target.value)}
                placeholder={`${cap.max_count} (por defecto)`}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-gray-500">
                Vacío mantiene el valor por defecto ({cap.max_count}).
              </span>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Severidad (opcional)
              </span>
              <select
                value={severityOverride}
                onChange={(e) =>
                  setSeverityOverride(e.target.value as DependencySeverity | "")
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">
                  Mantener {SEVERITY_LABEL[cap.severity]} (por defecto)
                </option>
                <option value="hard">Estricta</option>
                <option value="soft">Blanda</option>
              </select>
            </label>
          </>
        )}

        {upsert.isError && (
          <ErrorText>{(upsert.error as Error).message}</ErrorText>
        )}
        {remove.isError && (
          <ErrorText>{(remove.error as Error).message}</ErrorText>
        )}
        <div className="flex justify-end gap-2 pt-2">
          {initial && (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm("¿Quitar esta modificación?")) remove.mutate();
              }}
              disabled={remove.isPending}
            >
              Quitar modificación
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={upsert.isPending}>
            {upsert.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

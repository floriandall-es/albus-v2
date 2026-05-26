"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, CalendarRange, Play, Sparkles } from "lucide-react";
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
  ErrorText,
  PageHeader,
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
 * /admin/periodos/[id] — periodo editor.
 *
 * Tabs:
 *   - Actividades: per-(period, slot) snapshot of the full slot+rules
 *     config. Same SlotDialog the admin uses on /admin/slots, opened
 *     in mode='period-snapshot' so the visual language is identical.
 *   - Reglas: per-(period, succession/cap) delta overrides (those
 *     rules are tenant-scoped, so a delta model still fits).
 *
 * Generate button at the top fires the multi-month CP-SAT solve for
 * every full month touched by the periodo's date range.
 */
export default function PeriodoEditorPage() {
  const params = useParams<{ id: string }>();
  const periodId = Number(params.id);
  const router = useRouter();

  const periodo = useQuery({
    queryKey: ["periodo", periodId],
    queryFn: () => api.getPeriodo(periodId),
  });

  if (periodo.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (periodo.isError || !periodo.data) {
    return (
      <>
        <PageHeader title="Periodo" />
        <ErrorText>No se pudo cargar el periodo.</ErrorText>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => router.push("/admin/periodos")}>
            <ArrowLeft className="h-4 w-4" />
            Volver
          </Button>
        </div>
      </>
    );
  }

  return <PeriodoEditor periodo={periodo.data} />;
}

function PeriodoEditor({ periodo }: { periodo: Periodo }) {
  const qc = useQueryClient();
  const router = useRouter();

  const slots = useQuery({
    queryKey: ["slots"],
    queryFn: () => api.listSlots(),
  });

  // Pretty date range header.
  const start = new Date(periodo.start_date + "T00:00:00");
  const end = new Date(periodo.end_date + "T00:00:00");
  const sameYear = start.getFullYear() === end.getFullYear();
  const startLabel = start.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
  const endLabel = end.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const dateRange = `${startLabel} – ${endLabel}`;

  // Touched months — Mara should see what "Generar" is about to do
  // before pressing the button. Matches the server-side logic in
  // generate_period: every (year, month) covered by [start, end]
  // inclusive.
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

  const [generateResult, setGenerateResult] = useState<
    GeneratePeriodResult[] | null
  >(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: () => api.generatePeriodo(periodo.id),
    onSuccess: (result) => {
      setGenerateResult(result);
      setGenerateError(null);
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => {
      setGenerateError((e as Error).message);
      setGenerateResult(null);
    },
  });

  return (
    <>
      <PageHeader
        title={periodo.name}
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => router.push("/admin/periodos")}
            >
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Button>
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
        }
      />

      <div className="-mt-4 mb-6 max-w-2xl text-sm text-gray-600">
        <div className="flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-gray-500" />
          <span>{dateRange}</span>
        </div>
        <p className="mt-2">
          Ajusta abajo qué actividades se desactivan, cambian sus
          plazas o relajan sus restricciones durante este periodo.
          Lo que no toques mantiene su configuración por defecto.
        </p>
      </div>

      {generateError && (
        <Card>
          <div className="p-4">
            <ErrorText>{generateError}</ErrorText>
          </div>
        </Card>
      )}

      {generateResult && (
        <Card>
          <div className="p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-700">
              <Sparkles className="h-4 w-4" />
              Generación completada
            </div>
            <ul className="space-y-1 text-sm">
              {generateResult.map((r) => (
                <li key={r.schedule_id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    {new Date(r.period + "T00:00:00").toLocaleDateString("es-ES", {
                      month: "long",
                      year: "numeric",
                    })}
                  </span>
                  <span className="text-xs text-gray-500">
                    {r.assignments_created} asignaciones · solver:{" "}
                    {r.solver_used}
                  </span>
                  <Link
                    href={`/admin/schedule/${r.schedule_id}`}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    Abrir
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <EditorTabs periodo={periodo} slots={slots.data ?? []} />
    </>
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
// Reglas tab — succession rules + frequency caps. Mirrors the structure
// of /admin/rules, where these two live together under the same label
// ("Reglas"). Per-SlotRule overrides moved to the V.2.5 snapshot model
// — they're inside SlotDialog now under the Actividades tab.
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
    const m = new Map<number, Slot>();
    for (const s of slots) m.set(s.id, s);
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
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          Incompatibilidades (mismo día)
        </h2>
        {incompat.length === 0 ? (
          <p className="text-xs text-gray-500">
            No hay incompatibilidades de mismo día definidas.
          </p>
        ) : (
          <ul className="space-y-2">
            {incompat.map((rule) => (
              <SuccessionOverrideRow
                key={rule.id}
                rule={rule}
                afterSlot={slotById.get(rule.after_slot_id) ?? null}
                forbidSlot={slotById.get(rule.forbid_slot_id) ?? null}
                override={succOverrideByRule.get(rule.id) ?? null}
                periodId={periodo.id}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          Sucesión (días siguientes)
        </h2>
        {succession.length === 0 ? (
          <p className="text-xs text-gray-500">
            No hay reglas de sucesión definidas.
          </p>
        ) : (
          <ul className="space-y-2">
            {succession.map((rule) => (
              <SuccessionOverrideRow
                key={rule.id}
                rule={rule}
                afterSlot={slotById.get(rule.after_slot_id) ?? null}
                forbidSlot={slotById.get(rule.forbid_slot_id) ?? null}
                override={succOverrideByRule.get(rule.id) ?? null}
                periodId={periodo.id}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          Límites de frecuencia
        </h2>
        {!caps.data || caps.data.length === 0 ? (
          <p className="text-xs text-gray-500">
            No hay límites de frecuencia definidos.
          </p>
        ) : (
          <ul className="space-y-2">
            {caps.data.map((cap) => (
              <CapOverrideRow
                key={cap.id}
                cap={cap}
                slot={slotById.get(cap.slot_id) ?? null}
                override={capOverrideByCap.get(cap.id) ?? null}
                periodId={periodo.id}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SuccessionOverrideRow({
  rule,
  afterSlot,
  forbidSlot,
  override,
  periodId,
}: {
  rule: SlotSuccessionRule;
  afterSlot: Slot | null;
  forbidSlot: Slot | null;
  override: SuccessionPeriodOverride | null;
  periodId: number;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const upsert = useMutation({
    mutationFn: (body: SuccessionPeriodOverrideUpsert) =>
      api.upsertSuccessionPeriodOverride(periodId, rule.id, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-succession-overrides", periodId],
      });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api.deleteSuccessionPeriodOverride(periodId, rule.id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-succession-overrides", periodId],
      });
      setEditing(false);
    },
  });

  const summary =
    rule.days_after === 0
      ? `${afterSlot?.name ?? "?"} ⛔ mismo día ${forbidSlot?.name ?? "?"}`
      : `${afterSlot?.name ?? "?"} → ${rule.days_after}d sin ${forbidSlot?.name ?? "?"}`;

  return (
    <li>
      <Card>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {summary}
            </span>
            <span className="text-xs text-gray-500">
              {SEVERITY_LABEL[rule.severity]}
            </span>
            {override && !override.disabled && (
              <StatusPill tone="warning">Modificada</StatusPill>
            )}
            {override?.disabled && (
              <StatusPill tone="danger">Desactivada en el periodo</StatusPill>
            )}
            <div className="ml-auto flex gap-2">
              {!editing && (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  {override ? "Editar" : "Modificar"}
                </Button>
              )}
              {override && !editing && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm("¿Quitar esta modificación?")) remove.mutate();
                  }}
                  disabled={remove.isPending}
                >
                  Quitar
                </Button>
              )}
            </div>
          </div>

          {editing && (
            <SuccessionOverrideForm
              rule={rule}
              initial={override}
              onCancel={() => setEditing(false)}
              onSubmit={(body) => upsert.mutate(body)}
              submitting={upsert.isPending}
              error={upsert.error ? (upsert.error as Error).message : null}
            />
          )}
        </div>
      </Card>
    </li>
  );
}

function SuccessionOverrideForm({
  rule,
  initial,
  onCancel,
  onSubmit,
  submitting,
  error,
}: {
  rule: SlotSuccessionRule;
  initial: SuccessionPeriodOverride | null;
  onCancel: () => void;
  onSubmit: (body: SuccessionPeriodOverrideUpsert) => void;
  submitting: boolean;
  error: string | null;
}) {
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

  return (
    <form
      className="mt-3 space-y-3 border-t border-gray-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const days = daysAfterStr.trim() === "" ? null : Number(daysAfterStr);
        onSubmit({
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

      {!disabled && (
        <>
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
              0 = misma fecha incompatible. Vacío para mantener el valor por
              defecto ({rule.days_after}).
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
                Mantener {SEVERITY_LABEL[rule.severity]} (por defecto)
              </option>
              <option value="hard">Estricta</option>
              <option value="soft">Blanda</option>
            </select>
            <span className="mt-1 block text-xs text-gray-500">
              Pasar de Estricta a Blanda deja que el solver rompa la regla si
              no hay alternativa (paga una penalización).
            </span>
          </label>
        </>
      )}

      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </form>
  );
}

function CapOverrideRow({
  cap,
  slot,
  override,
  periodId,
}: {
  cap: SlotFrequencyCap;
  slot: Slot | null;
  override: CapPeriodOverride | null;
  periodId: number;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const upsert = useMutation({
    mutationFn: (body: CapPeriodOverrideUpsert) =>
      api.upsertCapPeriodOverride(periodId, cap.id, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-cap-overrides", periodId],
      });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCapPeriodOverride(periodId, cap.id),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["periodo-cap-overrides", periodId],
      });
      setEditing(false);
    },
  });

  const summary = `${slot?.name ?? "?"}: máx ${cap.max_count} en ${PERIOD_LABEL[cap.period]}`;

  return (
    <li>
      <Card>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {summary}
            </span>
            <span className="text-xs text-gray-500">
              {SEVERITY_LABEL[cap.severity]}
            </span>
            {override && !override.disabled && (
              <StatusPill tone="warning">
                {override.max_count_override !== null
                  ? `→ máx ${override.max_count_override}`
                  : "Modificado"}
              </StatusPill>
            )}
            {override?.disabled && (
              <StatusPill tone="danger">Desactivado en el periodo</StatusPill>
            )}
            <div className="ml-auto flex gap-2">
              {!editing && (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  {override ? "Editar" : "Modificar"}
                </Button>
              )}
              {override && !editing && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm("¿Quitar esta modificación?")) remove.mutate();
                  }}
                  disabled={remove.isPending}
                >
                  Quitar
                </Button>
              )}
            </div>
          </div>

          {editing && (
            <CapOverrideForm
              cap={cap}
              initial={override}
              onCancel={() => setEditing(false)}
              onSubmit={(body) => upsert.mutate(body)}
              submitting={upsert.isPending}
              error={upsert.error ? (upsert.error as Error).message : null}
            />
          )}
        </div>
      </Card>
    </li>
  );
}

function CapOverrideForm({
  cap,
  initial,
  onCancel,
  onSubmit,
  submitting,
  error,
}: {
  cap: SlotFrequencyCap;
  initial: CapPeriodOverride | null;
  onCancel: () => void;
  onSubmit: (body: CapPeriodOverrideUpsert) => void;
  submitting: boolean;
  error: string | null;
}) {
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

  return (
    <form
      className="mt-3 space-y-3 border-t border-gray-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const mc = maxCountStr.trim() === "" ? null : Number(maxCountStr);
        onSubmit({
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
              Útil para subir el tope cuando la plantilla está reducida
              (ej. 2 guardias/mes → 5/mes en verano). Vacío mantiene el valor
              por defecto ({cap.max_count}).
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

      {error && <ErrorText>{error}</ErrorText>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </form>
  );
}

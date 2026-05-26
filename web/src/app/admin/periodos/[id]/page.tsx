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
  type GeneratePeriodResult,
  type Periodo,
  type Slot,
  type SlotPeriodOverride,
} from "@/lib/api";
import {
  Button,
  Card,
  ErrorText,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";

/**
 * /admin/periodos/[id] — periodo editor.
 *
 * V.1 tab set: Actividades only. Per-slot overrides (headcount,
 * dismissed). Future V.2 adds Reglas / Sucesión / Caps tabs.
 *
 * Generate button at the top fires the multi-month CP-SAT solve for
 * every full month touched by the periodo's date range. Result shown
 * inline + links to each Schedule.
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

  const overrides = useQuery({
    queryKey: ["periodo-overrides", periodo.id],
    queryFn: () => api.listSlotPeriodOverrides(periodo.id),
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
  // before pressing the button. Compute client-side from the date
  // range. Matches the server-side logic in generate_period: every
  // (year, month) covered by [start, end] inclusive. Deps are the
  // stable ISO strings rather than the new Date objects, so the
  // memo doesn't recompute on every render.
  const touchedMonths = useMemo(() => {
    const s = new Date(periodo.start_date + "T00:00:00");
    const e = new Date(periodo.end_date + "T00:00:00");
    const out: { year: number; month: number; label: string }[] = [];
    let y = s.getFullYear();
    let m = s.getMonth(); // 0-indexed
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

  const overrideBySlot = useMemo(() => {
    const m = new Map<number, SlotPeriodOverride>();
    for (const o of overrides.data ?? []) m.set(o.slot_id, o);
    return m;
  }, [overrides.data]);

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
          Ajusta abajo qué actividades se desactivan, cambian su
          headcount o relajan sus restricciones durante este periodo.
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

      <h2 className="mb-2 mt-6 text-sm font-semibold text-gray-700">
        Actividades durante este periodo
      </h2>

      {slots.isLoading && (
        <p className="text-sm text-gray-500">Cargando actividades…</p>
      )}

      {slots.data && (
        <ul className="space-y-2">
          {slots.data
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((slot) => (
              <SlotOverrideRow
                key={slot.id}
                slot={slot}
                override={overrideBySlot.get(slot.id) ?? null}
                periodId={periodo.id}
              />
            ))}
        </ul>
      )}
    </>
  );
}

function SlotOverrideRow({
  slot,
  override,
  periodId,
}: {
  slot: Slot;
  override: SlotPeriodOverride | null;
  periodId: number;
}) {
  const qc = useQueryClient();
  // Editing mode toggles between "show summary + Modificar button"
  // and the inline form. State is local so each row is independent.
  const [editing, setEditing] = useState(false);

  const upsert = useMutation({
    mutationFn: (body: Parameters<typeof api.upsertSlotPeriodOverride>[2]) =>
      api.upsertSlotPeriodOverride(periodId, slot.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["periodo-overrides", periodId] });
      setEditing(false);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteSlotPeriodOverride(periodId, slot.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["periodo-overrides", periodId] });
      setEditing(false);
    },
  });

  const isOverridden = override !== null;

  return (
    <li>
      <Card>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2">
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
                : `headcount ${slot.headcount}`}
            </span>
            {isOverridden && (
              <StatusPill tone="warning">Modificado</StatusPill>
            )}
            {override?.dismissed && (
              <StatusPill tone="danger">No aplica en el periodo</StatusPill>
            )}
            <div className="ml-auto flex gap-2">
              {!editing && (
                <Button
                  variant="secondary"
                  onClick={() => setEditing(true)}
                >
                  {isOverridden ? "Editar" : "Modificar para el periodo"}
                </Button>
              )}
              {isOverridden && !editing && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (
                      confirm(
                        `Quitar la modificación de "${slot.name}" durante este periodo?`,
                      )
                    ) {
                      remove.mutate();
                    }
                  }}
                  disabled={remove.isPending}
                >
                  Quitar
                </Button>
              )}
            </div>
          </div>

          {editing && (
            <SlotOverrideForm
              slot={slot}
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

function SlotOverrideForm({
  slot,
  initial,
  onCancel,
  onSubmit,
  submitting,
  error,
}: {
  slot: Slot;
  initial: SlotPeriodOverride | null;
  onCancel: () => void;
  onSubmit: (
    body: Parameters<typeof api.upsertSlotPeriodOverride>[2],
  ) => void;
  submitting: boolean;
  error: string | null;
}) {
  const [dismissed, setDismissed] = useState(initial?.dismissed ?? false);
  const [headcountStr, setHeadcountStr] = useState<string>(
    initial?.headcount_override !== null
    && initial?.headcount_override !== undefined
      ? String(initial.headcount_override)
      : "",
  );

  // V.1 surfaces just the two simplest knobs: dismissed + headcount.
  // staffing_mode_override + allowed_*_override exist in the schema
  // for V.2 (per-rule strategy switching + categoría relaxation).
  // Keeping the form lean for v1 matches Mara's most common needs:
  // "Consulta apaga en agosto" → dismissed. "Quirófano halves" →
  // headcount. Both are single-input gestures.
  const isTeamComposition = slot.staffing_mode === "team_composition";

  return (
    <form
      className="mt-3 space-y-3 border-t border-gray-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const headcount = headcountStr.trim() === "" ? null : Number(headcountStr);
        onSubmit({
          dismissed,
          headcount_override:
            headcount !== null && !Number.isNaN(headcount) && headcount >= 1
              ? headcount
              : null,
          staffing_mode_override: null,
          allowed_category_ids_override: null,
          allowed_person_ids_override: null,
        });
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={dismissed}
          onChange={(e) => setDismissed(e.target.checked)}
        />
        <div>
          <div className="font-medium text-gray-900">
            No aplica durante el periodo
          </div>
          <div className="text-xs text-gray-500">
            Marca esto si esta actividad simplemente no se realiza durante
            el periodo (ej. Consulta en agosto). No se generarán
            asignaciones en esos días.
          </div>
        </div>
      </label>

      {!dismissed && !isTeamComposition && (
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Headcount durante el periodo
          </span>
          <input
            type="number"
            min="1"
            value={headcountStr}
            onChange={(e) => setHeadcountStr(e.target.value)}
            placeholder={`${slot.headcount} (por defecto)`}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-gray-500">
            Vacío para mantener el valor por defecto ({slot.headcount}).
            Útil para reducir cobertura (ej. media plantilla en verano).
          </span>
        </label>
      )}

      {!dismissed && isTeamComposition && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Esta actividad usa <strong>team_composition</strong> con{" "}
          {slot.team_roles.length} roles. Para reducir headcount en un
          rol individual necesitamos override por rol (V.2). Si quieres
          desactivarla entera durante el periodo, marca «No aplica» arriba.
        </p>
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

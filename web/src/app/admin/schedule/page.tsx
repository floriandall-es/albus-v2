"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type GeneratePeriodResult,
  type Periodo,
  type Schedule,
} from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Modal,
  PageHeader,
  StatusPill,
  TextField,
} from "@/components/admin/ui";
import {
  MonthPicker,
  formatPeriod,
} from "@/components/admin/month-picker";
import { PeriodoEditor } from "@/components/admin/PeriodoEditor";
import { SolverFallbackModal } from "@/components/schedule/SolverFallbackModal";
import {
  ArrowRight,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Pencil,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";

const STATUS_TONE = {
  draft: "warning",
  published: "success",
  archived: "neutral",
} as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

// Plain-language explainer rendered next to each status pill so
// non-technical admins immediately understand what the status
// implies for their team. Visibility is the part that confuses
// the most.
const STATUS_SUBTITLE: Record<string, string> = {
  draft: "solo tú la ves",
  published: "visible para el equipo",
  archived: "ya no visible para el equipo",
};

// "15 jul – 31 ago 2026" / "20 dic 2026 – 6 ene 2027". Same shape
// the PeriodoEditor + PeriodoRow use; lifted here so the
// existing-planificaciones section can label group headers.
function formatPeriodoRange(p: Periodo): string {
  const start = new Date(p.start_date + "T00:00:00");
  const end = new Date(p.end_date + "T00:00:00");
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
  return `${startLabel} – ${endLabel}`;
}

export default function SchedulesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules });
  // Loaded here (in addition to inside VacationCard, which uses the
  // same query key so the cache is shared) because the existing-
  // planificaciones table also needs the periodo list to group
  // months that belong to a vacation period.
  const periodos = useQuery({ queryKey: ["periodos"], queryFn: api.listPeriodos });
  const today = new Date();
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const [period, setPeriod] = useState<string>(defaultPeriod);

  // Vacation card UI state:
  //  - vacationOpen: card visible at all
  //  - expandedPeriodId: which periodo's editor is currently open
  //    inline (null = list view only)
  //  - creatingPeriodo: "+ Nuevo periodo" modal flag
  //  - generateBanner: success banner shown above the existing-
  //    schedules table after a successful vacation generate. Carries
  //    the result rows so we can link to each new schedule.
  const [vacationOpen, setVacationOpen] = useState(false);
  const [expandedPeriodId, setExpandedPeriodId] = useState<number | null>(null);
  const [creatingPeriodo, setCreatingPeriodo] = useState(false);
  const [generateBanner, setGenerateBanner] = useState<{
    periodoName: string;
    results: GeneratePeriodResult[];
  } | null>(null);
  // When the CP-SAT solver couldn't equilibrate and the API fell back
  // to greedy we open a modal explaining what happened + listing the
  // affected month(s). The pending navigation is captured here so the
  // user reads the modal first; on close we jump to the schedule.
  const [solverFallback, setSolverFallback] = useState<{
    affectedMonths: string[];
    navigateTo: string | null;
  } | null>(null);

  const generate = useMutation({
    mutationFn: () => api.generateSchedule(period),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      if (data.solver_used === "greedy") {
        // Hold the navigation in the fallback modal — user dismisses
        // it, then we route to the schedule.
        setSolverFallback({
          affectedMonths: [formatPeriod(data.period)],
          navigateTo: `/admin/schedule/${data.id}`,
        });
      } else {
        router.push(`/admin/schedule/${data.id}`);
      }
    },
  });

  return (
    <>
      <PageHeader title="Planificación" />

      {generateBanner && (
        <Card>
          <div className="flex items-start gap-3 p-4">
            <Sparkles className="mt-0.5 h-5 w-5 text-emerald-600" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-emerald-700">
                Periodo &quot;{generateBanner.periodoName}&quot;: generación completada
              </div>
              <ul className="mt-1 space-y-0.5 text-sm">
                {generateBanner.results.map((r) => (
                  <li key={r.schedule_id} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      {new Date(r.period + "T00:00:00").toLocaleDateString("es-ES", {
                        month: "long",
                        year: "numeric",
                      })}
                    </span>
                    <span className="text-xs text-gray-500">
                      {r.assignments_created} asignaciones ·{" "}
                      {r.solver_used === "cpsat" ? "Equilibrada" : "Simplificada"}
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
            <button
              type="button"
              onClick={() => setGenerateBanner(null)}
              className="shrink-0 text-xs text-gray-500 hover:text-gray-800"
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>
        </Card>
      )}

      <section aria-labelledby="generate-heading" className={generateBanner ? "mt-6" : ""}>
        <h2
          id="generate-heading"
          className="text-sm font-semibold text-gray-700 mb-2"
        >
          Crear una nueva planificación
        </h2>
        <Card>
          {/* Two distinct tiles so the month picker is visibly
              attached to the "Generar mes" button, not to the
              vacation flow. Picking a month and then clicking the
              vacation button used to be tempting because everything
              sat on one flat row. */}
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {/* Both tiles are flex columns so the action row at the
                bottom (input+button on the left, button on the right)
                gets mt-auto and the two buttons land on the same
                horizontal baseline. Grid items default to stretch
                so both tiles share the same height regardless of how
                much copy each one carries. */}
            <div className="flex flex-col rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Un mes
              </div>
              <p className="mb-3 text-xs text-gray-500">
                Elige mes y pulsa Generar para crear el borrador.
              </p>
              <div className="mt-auto flex flex-wrap items-end gap-2">
                <div className="w-64">
                  <MonthPicker label="Mes" value={period} onChange={setPeriod} />
                </div>
                <Button
                  onClick={() => generate.mutate()}
                  disabled={generate.isPending}
                >
                  {generate.isPending ? "Generando…" : "Generar mes"}
                </Button>
              </div>
            </div>
            <div className="flex flex-col rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-900/70">
                Periodo especial
              </div>
              <p className="mb-3 text-xs text-amber-900/80">
                Vacaciones, Navidad, etc. con configuración propia.
                Se generan varias planificaciones de golpe.
              </p>
              <div className="mt-auto">
                <Button
                  variant="secondary"
                  onClick={() => setVacationOpen((v) => !v)}
                >
                  <Sun className="h-4 w-4" />
                  Generar planificación de vacaciones
                </Button>
              </div>
            </div>
          </div>
          {generate.isError && (
            <div className="px-4 pb-3">
              <ErrorText>{(generate.error as Error).message}</ErrorText>
            </div>
          )}
        </Card>
      </section>

      {vacationOpen && (
        <section aria-labelledby="vacation-heading" className="mt-8">
          <h2
            id="vacation-heading"
            className="text-sm font-semibold text-gray-700 mb-2"
          >
            Periodos especiales
          </h2>
          <VacationCard
            expandedPeriodId={expandedPeriodId}
            onExpand={setExpandedPeriodId}
            onCreate={() => setCreatingPeriodo(true)}
            onGenerated={(periodoName, results) => {
              setGenerateBanner({ periodoName, results });
              setExpandedPeriodId(null);
              setVacationOpen(false);
            }}
          />
        </section>
      )}

      <section aria-labelledby="existing-heading" className="mt-8">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2
            id="existing-heading"
            className="text-sm font-semibold text-gray-700"
          >
            Planificaciones existentes
          </h2>
          {list.data && list.data.length > 0 && (
            <span className="text-xs text-gray-500">
              {list.data.length} {list.data.length === 1 ? "mes" : "meses"}
            </span>
          )}
        </div>
        {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
        {list.data && list.data.length === 0 && (
          <EmptyState
            icon={<CalendarDays className="h-5 w-5" />}
            title="Aún no hay ninguna planificación"
            description="Elige un mes arriba y pulsa Generar para crear la primera."
          />
        )}
        {list.data && list.data.length > 0 && (
          <Card>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left">
                <tr className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2.5">Mes</th>
                  <th className="px-4 py-2.5">Estado</th>
                  <th className="px-4 py-2.5">Generada</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(() => {
                  // Insert a "section header" row above each consecutive
                  // run of schedules that belong to the same periodo.
                  // A schedule belongs to a periodo when the periodo's
                  // [start_date, end_date] range overlaps the month
                  // [s.period, s.period + 1 month). Periodos are
                  // tenant-scoped non-overlapping (DB exclusion
                  // constraint), so at most one match per schedule.
                  const periodoFor = (s: Schedule): Periodo | null => {
                    if (!periodos.data) return null;
                    const ms = new Date(s.period + "T00:00:00");
                    const me = new Date(ms);
                    me.setMonth(me.getMonth() + 1);
                    for (const p of periodos.data) {
                      const ps = new Date(p.start_date + "T00:00:00");
                      const pe = new Date(p.end_date + "T00:00:00");
                      if (ps < me && pe >= ms) return p;
                    }
                    return null;
                  };
                  const rows: React.ReactNode[] = [];
                  let lastPeriodoId: number | null = null;
                  for (const s of list.data) {
                    const periodo = periodoFor(s);
                    if (periodo && periodo.id !== lastPeriodoId) {
                      rows.push(
                        <tr
                          key={`periodo-${periodo.id}`}
                          className="border-l-4 border-amber-400 bg-amber-100"
                        >
                          <td
                            colSpan={3}
                            className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-amber-900"
                          >
                            {/* Header content + a right-side
                                "Ver período completo" link that opens
                                a single page stacking every month of
                                the periodo. Click is contained to the
                                Link — clicks on the surrounding row
                                don't navigate (the row carries no
                                onClick of its own, unlike the month
                                rows below). */}
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-2">
                                <Sun className="h-3.5 w-3.5" />
                                <span>{periodo.name}</span>
                                <span className="font-normal text-amber-900/70">
                                  · {formatPeriodoRange(periodo)}
                                </span>
                              </span>
                              <Link
                                href={`/admin/schedule/periodo/${periodo.id}`}
                                className="inline-flex items-center gap-1 rounded-md ring-1 ring-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-900 hover:bg-amber-50 transition-colors normal-case"
                                title={`Abrir todos los meses de ${periodo.name} en una sola página`}
                              >
                                <span>Ver período completo</span>
                                <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            </div>
                          </td>
                        </tr>,
                      );
                      lastPeriodoId = periodo.id;
                    } else if (!periodo) {
                      lastPeriodoId = null;
                    }
                    const open = () => router.push(`/admin/schedule/${s.id}`);
                    rows.push(
                      <tr
                        key={s.id}
                        onClick={open}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            open();
                          }
                        }}
                        role="link"
                        tabIndex={0}
                        aria-label={`Abrir planificación de ${formatPeriod(s.period)}`}
                        className={
                          "cursor-pointer focus:outline-none transition-colors "
                          + (periodo
                            // Visible amber fill + thick left-edge
                            // accent in the same colour as the
                            // header row. Reads as a continuous
                            // "this belongs to Verano 2026" band.
                            ? "border-l-4 border-amber-400 bg-amber-50 hover:bg-amber-100/80 focus:bg-amber-100/80"
                            : "hover:bg-brand-50/40 focus:bg-brand-50/40")
                        }
                      >
                        <td
                          className={
                            "px-4 py-3 font-medium text-gray-900 "
                            + (periodo ? "pl-9" : "")
                          }
                        >
                          {formatPeriod(s.period)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2">
                            <StatusPill
                              tone={
                                STATUS_TONE[s.status as keyof typeof STATUS_TONE]
                                ?? "neutral"
                              }
                            >
                              {STATUS_LABEL[s.status] ?? s.status}
                            </StatusPill>
                            {STATUS_SUBTITLE[s.status] && (
                              <span className="text-xs text-gray-500">
                                {STATUS_SUBTITLE[s.status]}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {s.generated_at
                            ? new Date(s.generated_at).toLocaleString()
                            : "—"}
                        </td>
                      </tr>,
                    );
                  }
                  return rows;
                })()}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {creatingPeriodo && (
        <CreatePeriodoModal
          onClose={(createdId) => {
            setCreatingPeriodo(false);
            qc.invalidateQueries({ queryKey: ["periodos"] });
            if (createdId !== null) {
              // Auto-expand the new periodo so the admin can
              // immediately configure it.
              setExpandedPeriodId(createdId);
            }
          }}
        />
      )}
      {solverFallback && (
        <SolverFallbackModal
          affectedMonths={solverFallback.affectedMonths}
          onClose={() => {
            const nav = solverFallback.navigateTo;
            setSolverFallback(null);
            if (nav) router.push(nav);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Vacation card — the inline replacement for /admin/periodos.
//
// Lists existing periodos as compact rows. Clicking a row expands the
// shared PeriodoEditor below it; only one periodo is open at a time.
// A "+ Nuevo periodo" row at the bottom opens the create modal.
// ---------------------------------------------------------------------------
function VacationCard({
  expandedPeriodId,
  onExpand,
  onCreate,
  onGenerated,
}: {
  expandedPeriodId: number | null;
  onExpand: (id: number | null) => void;
  onCreate: () => void;
  onGenerated: (periodoName: string, results: GeneratePeriodResult[]) => void;
}) {
  const list = useQuery({
    queryKey: ["periodos"],
    queryFn: api.listPeriodos,
  });

  return (
    <Card>
      <div className="p-4">
        <p className="mb-3 text-xs text-gray-500">
          Define un rango de fechas (vacaciones, Navidad, etc.) y ajusta
          qué actividades y reglas aplican durante ese periodo. Después
          genera la planificación de todos los meses que toca con un
          clic.
        </p>

        {list.isLoading && (
          <p className="text-sm text-gray-500">Cargando…</p>
        )}
        {list.isError && (
          <ErrorText>{(list.error as Error).message}</ErrorText>
        )}

        {list.data && (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {list.data.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-gray-500">
                Aún no hay periodos definidos.
              </li>
            )}
            {list.data.map((p) => (
              <PeriodoRow
                key={p.id}
                periodo={p}
                expanded={expandedPeriodId === p.id}
                onToggle={() =>
                  onExpand(expandedPeriodId === p.id ? null : p.id)
                }
                onGenerated={(results) => onGenerated(p.name, results)}
                onDeleted={() => onExpand(null)}
              />
            ))}
            {/* Action row, not a periodo. Slight gray fill +
                top border emphasis sets it apart from the list
                items above. */}
            <li>
              <button
                type="button"
                onClick={onCreate}
                className="flex w-full items-center gap-2 border-t-2 border-gray-200 bg-gray-50 px-4 py-3 text-left text-sm text-brand-700 hover:bg-gray-100 transition-colors"
              >
                <Sun className="h-4 w-4" />
                <span className="font-medium">+ Nuevo periodo</span>
              </button>
            </li>
          </ul>
        )}
      </div>
    </Card>
  );
}

function PeriodoRow({
  periodo,
  expanded,
  onToggle,
  onGenerated,
  onDeleted,
}: {
  periodo: Periodo;
  expanded: boolean;
  onToggle: () => void;
  onGenerated: (results: GeneratePeriodResult[]) => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  // Pretty date range — same logic as the old /admin/periodos list.
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
  const days =
    Math.round((end.getTime() - start.getTime()) / 86400000) + 1;

  // Delete lives here (next to the row's name/date label) rather than
  // inside the editor — the action operates on the periodo's identity,
  // not its body of config, so the natural place for it is the
  // header. onDeleted is forwarded so the parent collapses the row.
  const remove = useMutation({
    mutationFn: () => api.deletePeriodo(periodo.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["periodos"] });
      onDeleted();
    },
  });

  return (
    <li>
      {/* The clickable header is the "tab" of the row. It always
          carries an amber tint so a periodo reads consistently here
          AND down in the existing-planificaciones table grouping.
          Expanded gets the darker amber-100 (same shade the existing
          table uses for the group header), collapsed gets amber-50
          so there's still a subtle "this one is open" cue beyond the
          chevron direction.
          The chevron + name/date take the toggle click; the right-side
          buttons stop propagation so they don't also expand the row. */}
      <div
        className={
          "flex w-full items-center gap-3 px-4 py-3 transition-colors "
          + (expanded
            ? "bg-amber-100 hover:bg-amber-200/70"
            : "bg-amber-50 hover:bg-amber-100/70")
        }
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-500" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-gray-900">
              {periodo.name}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
              <CalendarRange className="h-3.5 w-3.5" />
              <span>{dateRange}</span>
              <span>·</span>
              <span>
                {days} {days === 1 ? "día" : "días"}
              </span>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-4 w-4" />
            Editar
          </Button>
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
      </div>
      {remove.isError && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2">
          <ErrorText>{(remove.error as Error).message}</ErrorText>
        </div>
      )}
      {/* PeriodoEditor lays itself out as three horizontal strips
          (header / body / footer) with their own backgrounds. We
          just give it edge-to-edge space below the header tab. */}
      {expanded && (
        <div className="border-t border-gray-200">
          <PeriodoEditor periodo={periodo} onGenerated={onGenerated} />
        </div>
      )}
      {editing && (
        <EditPeriodoModal
          periodo={periodo}
          onClose={() => setEditing(false)}
        />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Create-periodo modal — name + start/end date. Moved here from the
// deleted /admin/periodos page; the schedule page is the only caller.
// ---------------------------------------------------------------------------
function CreatePeriodoModal({
  onClose,
}: {
  /** Called with the new periodo's id on success, or null on cancel/close. */
  onClose: (createdId: number | null) => void;
}) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createPeriodo({
        name: name.trim(),
        start_date: startDate,
        end_date: endDate,
      }),
    onSuccess: (p) => onClose(p.id),
  });

  const canSubmit =
    name.trim().length > 0
    && !!startDate
    && !!endDate
    && endDate >= startDate
    && !create.isPending;

  return (
    <Modal open={true} onClose={() => onClose(null)} title="Nuevo periodo">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          placeholder="Verano 2026"
          autoComplete="off"
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Desde</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Hasta</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate || undefined}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <p className="text-xs text-gray-500">
          Las dos fechas se incluyen en el periodo. No puede solaparse
          con otro periodo existente.
        </p>
        {create.isError && (
          <ErrorText>{(create.error as Error).message}</ErrorText>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => onClose(null)}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? "Creando…" : "Crear"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}


// ---------------------------------------------------------------------------
// Edit-periodo modal — name + start/end date. Pre-filled with the
// current values and patched via the existing PATCH /api/periodos/{id}
// endpoint. Server enforces non-overlap with other periodos, so a
// conflicting date range surfaces here as a 422 error.
// ---------------------------------------------------------------------------
function EditPeriodoModal({
  periodo,
  onClose,
}: {
  periodo: Periodo;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(periodo.name);
  const [startDate, setStartDate] = useState(periodo.start_date);
  const [endDate, setEndDate] = useState(periodo.end_date);

  const save = useMutation({
    mutationFn: () =>
      api.updatePeriodo(periodo.id, {
        name: name.trim(),
        start_date: startDate,
        end_date: endDate,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["periodos"] });
      onClose();
    },
  });

  const canSubmit =
    name.trim().length > 0
    && !!startDate
    && !!endDate
    && endDate >= startDate
    && !save.isPending;

  return (
    <Modal open={true} onClose={onClose} title="Editar periodo">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) save.mutate();
        }}
      >
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          placeholder="Verano 2026"
          autoComplete="off"
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Desde</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Hasta</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate || undefined}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <p className="text-xs text-gray-500">
          Cambiar las fechas no toca las planificaciones ya generadas;
          tendrás que regenerar para que se aplique el nuevo rango.
        </p>
        {save.isError && (
          <ErrorText>{(save.error as Error).message}</ErrorText>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

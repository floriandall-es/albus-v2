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
import {
  CalendarDays,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Sun,
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

export default function SchedulesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules });
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

  const generate = useMutation({
    mutationFn: () => api.generateSchedule(period),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.push(`/admin/schedule/${data.id}`);
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
                      {r.assignments_created} asignaciones · solver: {r.solver_used}
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
          <div className="p-4">
            <p className="text-xs text-gray-500 mb-3">
              Elige un mes y pulsa Generar para crear el borrador del mes.
              Para vacaciones o periodos largos con configuración propia,
              usa la opción de la derecha.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-72">
                <MonthPicker label="Mes" value={period} onChange={setPeriod} />
              </div>
              <Button
                onClick={() => generate.mutate()}
                disabled={generate.isPending}
              >
                {generate.isPending ? "Generando…" : "Generar nueva"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setVacationOpen((v) => !v)}
              >
                <Sun className="h-4 w-4" />
                Generar planificación de vacaciones
              </Button>
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
                {list.data.map((s: Schedule) => {
                  const open = () => router.push(`/admin/schedule/${s.id}`);
                  return (
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
                      className="cursor-pointer hover:bg-brand-50/40 focus:bg-brand-50/40 focus:outline-none transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
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
                    </tr>
                  );
                })}
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
            <li>
              <button
                type="button"
                onClick={onCreate}
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-brand-700 hover:bg-brand-50/50 transition-colors"
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

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50/60 transition-colors"
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
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50/40 px-4 py-4">
          <PeriodoEditor
            periodo={periodo}
            onGenerated={onGenerated}
            onDeleted={onDeleted}
          />
        </div>
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

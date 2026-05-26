"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Sun, Trash2 } from "lucide-react";
import { api, type Periodo } from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Modal,
  PageHeader,
  TextField,
} from "@/components/admin/ui";

/**
 * /admin/periodos — list + create / delete periodos especiales.
 *
 * A periodo defines a date range during which the scheduler applies
 * modified slot/rule config (vacation, Christmas, etc.). See
 * docs/vacation-periods.md.
 *
 * V.1 surface: this page shows the list + lets admin create / delete.
 * Per-slot overrides live on the editor page at /admin/periodos/[id].
 * The "Generar período" button + status surfacing also live on the
 * editor; this list is just navigation.
 *
 * Admin-only — the layout already gates non-admins. We don't redundant-
 * check here.
 */

export default function PeriodosPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ["periodos"],
    queryFn: api.listPeriodos,
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deletePeriodo(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["periodos"] }),
  });

  return (
    <>
      <PageHeader
        title="Periodos especiales"
        action={
          <Button onClick={() => setCreating(true)}>Nuevo periodo</Button>
        }
      />

      <p className="-mt-4 mb-6 max-w-2xl text-sm text-gray-600">
        Define un rango de fechas (vacaciones, Navidad, etc.) y ajusta
        qué actividades y reglas aplican durante ese periodo. Después
        genera la planificación de todos los meses que toca con un
        clic.
      </p>

      {list.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}

      {list.data && list.data.length === 0 && (
        <EmptyState
          icon={<Sun className="h-5 w-5" />}
          title="Sin periodos definidos"
          description="Cuando definas uno aparecerá aquí. Pulsa 'Nuevo periodo' para empezar."
        />
      )}

      {list.data && list.data.length > 0 && (
        <ul className="space-y-3">
          {list.data.map((p) => (
            <PeriodoRow
              key={p.id}
              periodo={p}
              onOpen={() => router.push(`/admin/periodos/${p.id}`)}
              onDelete={() => {
                if (
                  confirm(
                    `¿Eliminar el periodo "${p.name}"? Esto borra todas sus configuraciones específicas, pero las planificaciones ya generadas no se tocan.`,
                  )
                ) {
                  del.mutate(p.id);
                }
              }}
            />
          ))}
        </ul>
      )}

      {creating && (
        <CreatePeriodoModal
          onClose={(createdId) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["periodos"] });
            if (createdId !== null) {
              router.push(`/admin/periodos/${createdId}`);
            }
          }}
        />
      )}
    </>
  );
}

function PeriodoRow({
  periodo,
  onOpen,
  onDelete,
}: {
  periodo: Periodo;
  onOpen: () => void;
  onDelete: () => void;
}) {
  // Pretty date range — "15 jul – 31 ago 2026" or "20 dic 2026 – 6 ene
  // 2027" when the range crosses a year. Keep both ends labelled so
  // there's no ambiguity at year boundaries.
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
  // Day count (inclusive of both ends).
  const days =
    Math.round((end.getTime() - start.getTime()) / 86400000) + 1;

  return (
    <li>
      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-base font-semibold text-gray-900">
              {periodo.name}
            </div>
            <div className="mt-0.5 text-sm text-gray-600">{dateRange}</div>
            <div className="text-xs text-gray-500">
              {days} {days === 1 ? "día" : "días"}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="danger" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
              Eliminar
            </Button>
            <Button onClick={onOpen}>
              Editar
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}

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

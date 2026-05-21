"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Filter, X } from "lucide-react";
import {
  api,
  personLastName,
  type TransplantCase,
  type TransplantCaseInput,
  type TransplantProcedureInput,
  type TransplantProcedureType,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  StatusPill,
  TextField,
} from "@/components/admin/ui";
import { formatLongDate, todayIso } from "@/lib/dates";

/**
 * Admin transplant case log. The lung-transplant service uses
 * this as their canonical record of every EXPLANTE + IMPLANTE
 * the department does (or coordinates with another hospital).
 *
 * Layout:
 *   - Top: filter row (date range, surgeon, type, cross-hospital)
 *     + "Estadísticas" link + "Nuevo trasplante" button.
 *   - Body: chronological card list (one card per case),
 *     newest first. Each card shows the case header (date,
 *     external ref, cross-hospital pill) and the procedures
 *     stacked underneath with primary/secondary surgeon names.
 *   - Empty state when no cases match.
 */
export default function TrasplantesPage() {
  const qc = useQueryClient();

  // Filter state. Persisted only in React state — short-lived
  // exploration, not worth a URL round-trip.
  const [filterPersonId, setFilterPersonId] = useState<number | "">("");
  const [filterType, setFilterType] = useState<TransplantProcedureType | "">(
    "",
  );
  const [filterCross, setFilterCross] = useState<"" | "yes" | "no">("");
  const [filterFrom, setFilterFrom] = useState<string>("");
  const [filterTo, setFilterTo] = useState<string>("");

  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  // Surgeon picker pool: only members with categoría Adjunto, plus
  // the disabled Pastor (so editing a historical case can still
  // attribute him). Keep the list small — neumólogos and residents
  // never appear on the surgeries table.
  const surgeonOptions = useMemo(() => {
    return (team.data ?? [])
      .filter(
        (m) =>
          (m.category_name === "Adjunto" ||
            m.person_name === "Pastor (inactivo)") &&
          m.group_id == null,
      )
      .map((m) => ({
        ...m,
        // Last-name-only display label, computed once so the
        // picker + sort use the same string the case rows show.
        // TeamMember doesn't expose last_name; the helper's
        // whitespace-split fallback (and the parenthetical-strip
        // we added for the disabled-Pastor sentinel) handle every
        // shape we have today.
        display_name: personLastName({ name: m.person_name }),
      }))
      .sort((a, b) =>
        a.display_name.localeCompare(b.display_name, "es"),
      );
  }, [team.data]);

  const list = useQuery({
    queryKey: [
      "transplants",
      filterPersonId || null,
      filterType || null,
      filterCross || null,
      filterFrom || null,
      filterTo || null,
    ],
    queryFn: () =>
      api.listTransplants({
        person_id:
          filterPersonId === "" ? undefined : Number(filterPersonId),
        type: filterType === "" ? undefined : filterType,
        cross_hospital:
          filterCross === ""
            ? undefined
            : filterCross === "yes",
        from: filterFrom || undefined,
        to: filterTo || undefined,
      }),
  });

  const [editing, setEditing] = useState<TransplantCase | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTransplant(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["transplants"] }),
  });

  const filtersActive =
    filterPersonId !== ""
    || filterType !== ""
    || filterCross !== ""
    || filterFrom !== ""
    || filterTo !== "";

  function clearFilters() {
    setFilterPersonId("");
    setFilterType("");
    setFilterCross("");
    setFilterFrom("");
    setFilterTo("");
  }

  return (
    <>
      <PageHeader
        title="Trasplantes"
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/admin/trasplantes/stats"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <BarChart3 className="h-4 w-4 text-gray-500" />
              Estadísticas
            </Link>
            <Button onClick={() => setEditing("new")}>Nuevo trasplante</Button>
          </div>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500">
            <Filter className="h-3.5 w-3.5" />
            Filtros
          </div>
          <div className="min-w-[160px]">
            <Select
              label="Cirujano"
              value={filterPersonId}
              onChange={(v) =>
                setFilterPersonId(v === "" ? "" : Number(v))
              }
              options={[
                { value: "", label: "— Cualquier cirujano —" },
                ...surgeonOptions.map((m) => ({
                  value: m.person_id,
                  label: m.display_name,
                })),
              ]}
            />
          </div>
          <div className="min-w-[140px]">
            <Select
              label="Tipo"
              value={filterType}
              onChange={(v) =>
                setFilterType(
                  (v === ""
                    ? ""
                    : (v as TransplantProcedureType)) as
                    | TransplantProcedureType
                    | "",
                )
              }
              options={[
                { value: "", label: "Cualquiera" },
                { value: "explante", label: "Solo explantes" },
                { value: "implante", label: "Solo implantes" },
              ]}
            />
          </div>
          <div className="min-w-[160px]">
            <Select
              label="Cross-hospital"
              value={filterCross}
              onChange={(v) => setFilterCross(v as "" | "yes" | "no")}
              options={[
                { value: "", label: "Cualquiera" },
                { value: "yes", label: "Sí" },
                { value: "no", label: "No (solo locales)" },
              ]}
            />
          </div>
          <div>
            <TextField
              label="Desde"
              type="date"
              value={filterFrom}
              onChange={setFilterFrom}
            />
          </div>
          <div>
            <TextField
              label="Hasta"
              type="date"
              value={filterTo}
              onChange={setFilterTo}
            />
          </div>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              <X className="h-3 w-3" />
              Limpiar
            </button>
          )}
        </div>
      </Card>

      {list.isLoading && (
        <div className="mt-4 text-sm text-gray-500">Cargando…</div>
      )}
      {list.isError && (
        <ErrorText>{(list.error as Error).message}</ErrorText>
      )}
      {list.data && list.data.length === 0 && (
        <Empty>
          {filtersActive
            ? "Ningún trasplante coincide con los filtros."
            : "Aún no hay trasplantes registrados. Pulsa 'Nuevo trasplante' para crear el primero."}
        </Empty>
      )}
      {list.data && list.data.length > 0 && (
        <div className="mt-4 space-y-3">
          {list.data.map((c) => (
            <CaseRow
              key={c.id}
              c={c}
              onEdit={() => setEditing(c)}
              onDelete={() => {
                if (
                  confirm(
                    `¿Eliminar trasplante del ${formatLongDate(c.occurred_on)}? Esta acción no se puede deshacer.`,
                  )
                ) {
                  del.mutate(c.id);
                }
              }}
            />
          ))}
        </div>
      )}

      {editing && (
        <TransplantEditor
          surgeons={surgeonOptions}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function CaseRow({
  c,
  onEdit,
  onDelete,
}: {
  c: TransplantCase;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-soft overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/40 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-gray-900">
            {formatLongDate(c.occurred_on)}
          </span>
          {c.external_case_id && (
            <span className="text-xs text-gray-500">
              · Caso #{c.external_case_id}
            </span>
          )}
          {c.is_cross_hospital && (
            <StatusPill tone="info">Cross-hospital</StatusPill>
          )}
          {c.has_explante && c.has_implante && (
            <StatusPill tone="success">Completo</StatusPill>
          )}
          {c.has_explante && !c.has_implante && (
            <StatusPill tone="warning">Solo explante</StatusPill>
          )}
          {!c.has_explante && c.has_implante && (
            <StatusPill tone="warning">Solo implante</StatusPill>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Editar
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
          >
            Eliminar
          </button>
        </div>
      </div>
      <div className="divide-y divide-gray-100">
        {c.procedures.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={
                  "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider "
                  + (p.type === "explante"
                    ? "bg-amber-50 text-amber-800"
                    : "bg-emerald-50 text-emerald-800")
                }
              >
                {p.type}
              </span>
              <span className="text-gray-700 truncate">
                {p.primary_person_name
                  ? personLastName({ name: p.primary_person_name })
                  : (
                    <span className="italic text-gray-400">
                      Sin cirujano local
                    </span>
                  )}
                {p.secondary_person_name && (
                  <span className="text-gray-500">
                    {" "}
                    + {personLastName({ name: p.secondary_person_name })}
                  </span>
                )}
              </span>
            </div>
            {p.notes && (
              <span className="shrink-0 text-xs italic text-gray-500 max-w-[40%] truncate">
                {p.notes}
              </span>
            )}
          </div>
        ))}
      </div>
      {c.notes && (
        <div className="border-t border-gray-100 bg-gray-50/40 px-4 py-2 text-xs text-gray-600">
          {c.notes}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit modal
// ---------------------------------------------------------------------------

type EditorSurgeon = {
  person_id: number;
  // Pre-computed last-name-only label so the modal selectors
  // don't have to re-run the helper for every <option>.
  display_name: string;
};

function TransplantEditor({
  existing,
  surgeons,
  onClose,
}: {
  existing: TransplantCase | null;
  surgeons: EditorSurgeon[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = existing === null;
  const [externalCaseId, setExternalCaseId] = useState<string>(
    existing?.external_case_id ?? "",
  );
  const [notes, setNotes] = useState<string>(existing?.notes ?? "");
  const [procedures, setProcedures] = useState<TransplantProcedureInput[]>(
    () =>
      existing
        ? existing.procedures.map((p) => ({
            type: p.type,
            occurred_at: p.occurred_at,
            primary_person_id: p.primary_person_id,
            secondary_person_id: p.secondary_person_id,
            notes: p.notes,
          }))
        : [
            {
              type: "explante",
              // Default to today at 11:00 local — most ops are
              // mid-morning. The customer can adjust.
              occurred_at: defaultProcedureDateTime(),
              primary_person_id: null,
              secondary_person_id: null,
              notes: null,
            },
          ],
  );

  const save = useMutation({
    mutationFn: () => {
      const body: TransplantCaseInput = {
        external_case_id: externalCaseId.trim() || null,
        notes: notes.trim() || null,
        procedures: procedures.map((p) => ({
          type: p.type,
          occurred_at: p.occurred_at,
          primary_person_id: p.primary_person_id,
          secondary_person_id: p.secondary_person_id,
          notes: p.notes?.trim() || null,
        })),
      };
      if (isNew) return api.createTransplant(body);
      return api.updateTransplant(existing!.id, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transplants"] });
      onClose();
    },
  });

  function updateProc(
    idx: number,
    patch: Partial<TransplantProcedureInput>,
  ) {
    setProcedures((cur) =>
      cur.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    );
  }

  function addProc(type: TransplantProcedureType) {
    setProcedures((cur) => [
      ...cur,
      {
        type,
        occurred_at: cur[0]?.occurred_at ?? defaultProcedureDateTime(),
        primary_person_id: null,
        secondary_person_id: null,
        notes: null,
      },
    ]);
  }

  function removeProc(idx: number) {
    setProcedures((cur) => cur.filter((_, i) => i !== idx));
  }

  const canSave = procedures.length > 0 && !save.isPending;

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={isNew ? "Nuevo trasplante" : "Editar trasplante"}
      size="lg"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Referencia externa"
            hint="Número de caso del sistema de coordinación de donantes, si lo conoces. Opcional."
            value={externalCaseId}
            onChange={setExternalCaseId}
          />
          <div />
        </div>

        <div>
          <span className="text-sm font-medium text-gray-700">Notas del caso</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="Notas sobre el caso (opcional)…"
          />
        </div>

        <div className="border-t border-gray-100 pt-3">
          <div className="mb-2 text-sm font-medium text-gray-700">
            Procedimientos
          </div>
          <div className="space-y-2">
            {procedures.map((p, idx) => (
              <ProcedureRow
                key={idx}
                proc={p}
                surgeons={surgeons}
                onChange={(patch) => updateProc(idx, patch)}
                onRemove={
                  procedures.length > 1 ? () => removeProc(idx) : null
                }
              />
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => addProc("explante")}
              className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              + Explante
            </button>
            <button
              type="button"
              onClick={() => addProc("implante")}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
            >
              + Implante
            </button>
          </div>
        </div>

        {save.isError && (
          <ErrorText>{(save.error as Error).message}</ErrorText>
        )}

        <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!canSave}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ProcedureRow({
  proc,
  surgeons,
  onChange,
  onRemove,
}: {
  proc: TransplantProcedureInput;
  surgeons: EditorSurgeon[];
  onChange: (patch: Partial<TransplantProcedureInput>) => void;
  onRemove: (() => void) | null;
}) {
  // The API expects an ISO timestamp; the <input type="datetime-local">
  // gives us "YYYY-MM-DDTHH:MM" without the timezone. We pad to a full
  // ISO + Z (treated as UTC) on the way out, and slice off the seconds
  // + tz on the way in for the input value.
  const inputValue = proc.occurred_at.slice(0, 16);
  return (
    <div className="rounded-md border border-gray-200 p-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          label=""
          value={proc.type}
          onChange={(v) =>
            onChange({ type: v as TransplantProcedureType })
          }
          options={[
            { value: "explante", label: "Explante" },
            { value: "implante", label: "Implante" },
          ]}
        />
        <input
          type="datetime-local"
          value={inputValue}
          onChange={(e) => {
            const v = e.target.value;
            // datetime-local gives "YYYY-MM-DDTHH:MM" without tz.
            // Stash with ":00Z" so the server sees a UTC instant.
            onChange({
              occurred_at: v ? `${v}:00Z` : proc.occurred_at,
            });
          }}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto rounded-md p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
            aria-label="Eliminar procedimiento"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Cirujano principal"
          value={proc.primary_person_id ?? ""}
          onChange={(v) =>
            onChange({
              primary_person_id: v === "" ? null : Number(v),
            })
          }
          options={[
            { value: "", label: "— Sin cirujano local —" },
            ...surgeons.map((s) => ({
              value: s.person_id,
              label: s.display_name,
            })),
          ]}
        />
        <Select
          label="Segundo cirujano"
          value={proc.secondary_person_id ?? ""}
          onChange={(v) =>
            onChange({
              secondary_person_id: v === "" ? null : Number(v),
            })
          }
          options={[
            { value: "", label: "— Ninguno —" },
            ...surgeons
              .filter((s) => s.person_id !== proc.primary_person_id)
              .map((s) => ({
                value: s.person_id,
                label: s.display_name,
              })),
          ]}
        />
      </div>
      <TextField
        label="Notas del procedimiento"
        value={proc.notes ?? ""}
        onChange={(v) => onChange({ notes: v })}
        placeholder='ej. "Recibido Juan Canalejo", "No válido"…'
      />
    </div>
  );
}

function defaultProcedureDateTime(): string {
  // Today at 11:00 local — the typical mid-morning OR slot. We
  // store as UTC (Z) because the backend column is tz-aware and
  // the UI doesn't need finer precision than the minute.
  const t = todayIso();
  return `${t}T11:00:00Z`;
}

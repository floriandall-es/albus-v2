"use client";
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Filter, X } from "lucide-react";
import {
  api,
  personLastName,
  type TransplantCase,
  type TransplantCaseInput,
  type TransplantProcedure,
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
} from "@/components/admin/ui";
import { formatLongDate, todayIso } from "@/lib/dates";

// Date labels for the dense list view. Existing /lib/dates.ts
// gives "Lunes 18 mayo" — the month is redundant here because
// the section header already says "Mayo 2026". We use full
// Spanish weekday names (not truncated abbrevs) because the
// natural 3-char abbreviation for martes is "mar", which
// reads as marzo and made the column ambiguous. Lowercase
// stays consistent with how the planning grid renders weekdays.
const WEEKDAY_FULL_ES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];
const MONTH_LONG_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function shortDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = WEEKDAY_FULL_ES[dt.getDay()];
  return `${wd} ${d}`;
}

function monthHeaderLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const name = MONTH_LONG_ES[m - 1];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

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
  // Estado filter — client-side (estado is derived from notes, no
  // clean SQL). "" = all.
  const [filterEstado, setFilterEstado] = useState<"" | EstadoKey>("");
  const [filterFrom, setFilterFrom] = useState<string>("");
  const [filterTo, setFilterTo] = useState<string>("");

  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  // Surgeon picker pool: only members with categoría Adjunto, plus
  // the disabled Pastor (so editing a historical case can still
  // attribute him). Keep the list small — neumólogos and residents
  // never appear on the surgeries table. Match both "Adjunto" (old
  // tenants seeded before the inclusive rename) and "Adjunto/a"
  // (new tenants).
  const surgeonOptions = useMemo(() => {
    return (team.data ?? [])
      .filter(
        (m) =>
          m.category_name === "Adjunto"
            || m.category_name === "Adjunto/a"
            || m.person_name === "Pastor (inactivo)",
      )
      .map((m) => ({
        ...m,
        // Last-name-only display label, computed once so the picker +
        // sort use the same string the case rows show. Prefer the
        // structured last_name (e.g. "Jose Alfonso Ceron" → "Ceron");
        // the whitespace-split fallback only kicks in for legacy
        // single-name rows.
        display_name: personLastName({
          name: m.person_name,
          last_name: m.person_last_name,
        }),
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
      filterFrom || null,
      filterTo || null,
    ],
    queryFn: () =>
      api.listTransplants({
        person_id:
          filterPersonId === "" ? undefined : Number(filterPersonId),
        type: filterType === "" ? undefined : filterType,
        from: filterFrom || undefined,
        to: filterTo || undefined,
      }),
  });

  // Estado filter is applied client-side (it's derived from notes).
  const visibleCases = useMemo(() => {
    const all = list.data ?? [];
    if (filterEstado === "") return all;
    return all.filter((c) => caseEstado(c).key === filterEstado);
  }, [list.data, filterEstado]);

  const [editing, setEditing] = useState<TransplantCase | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTransplant(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["transplants"] }),
  });

  const filtersActive =
    filterPersonId !== ""
    || filterType !== ""
    || filterEstado !== ""
    || filterFrom !== ""
    || filterTo !== "";

  function clearFilters() {
    setFilterPersonId("");
    setFilterType("");
    setFilterEstado("");
    setFilterFrom("");
    setFilterTo("");
  }

  // Group cases by their YYYY-MM, newest month first. Renders as a
  // single table with non-data "month header" rows breaking up the
  // groups — much denser than card-per-case and much closer to how
  // the customer actually thinks about the archive ("we did X
  // transplants in March").
  const groupedByMonth = useMemo(() => {
    const map = new Map<string, TransplantCase[]>();
    for (const c of visibleCases) {
      const ym = c.occurred_on.slice(0, 7);
      const arr = map.get(ym) ?? [];
      arr.push(c);
      map.set(ym, arr);
    }
    return Array.from(map.entries()).sort((a, b) =>
      b[0].localeCompare(a[0]),
    );
  }, [visibleCases]);

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

      {/* Compact filter bar — single inline row, no per-input
          labels (the placeholders + icon carry enough). Doesn't
          wrap a Card so it reads as a toolbar, not a section. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-soft">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500">
          <Filter className="h-3.5 w-3.5" />
          Filtros
        </span>
        <select
          value={filterPersonId === "" ? "" : String(filterPersonId)}
          onChange={(e) =>
            setFilterPersonId(e.target.value === "" ? "" : Number(e.target.value))
          }
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
        >
          <option value="">Cualquier cirujano</option>
          {surgeonOptions.map((m) => (
            <option key={m.person_id} value={m.person_id}>
              {m.display_name}
            </option>
          ))}
        </select>
        <select
          value={filterType}
          onChange={(e) =>
            setFilterType(
              (e.target.value as TransplantProcedureType | ""),
            )
          }
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
        >
          <option value="">Cualquier tipo</option>
          <option value="explante">Solo explantes</option>
          <option value="implante">Solo implantes</option>
        </select>
        <select
          value={filterEstado}
          onChange={(e) => setFilterEstado(e.target.value as "" | EstadoKey)}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
        >
          <option value="">Cualquier estado</option>
          <option value="completo">Completo</option>
          <option value="no_valido">No válido</option>
        </select>
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => setFilterFrom(e.target.value)}
          placeholder="Desde"
          aria-label="Desde"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        <input
          type="date"
          value={filterTo}
          onChange={(e) => setFilterTo(e.target.value)}
          placeholder="Hasta"
          aria-label="Hasta"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            <X className="h-3 w-3" />
            Limpiar
          </button>
        )}
        {list.data && visibleCases.length > 0 && (
          <span className="ml-auto text-xs text-gray-500">
            {visibleCases.length} caso{visibleCases.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {list.isLoading && (
        <div className="text-sm text-gray-500">Cargando…</div>
      )}
      {list.isError && (
        <ErrorText>{(list.error as Error).message}</ErrorText>
      )}
      {list.data && visibleCases.length === 0 && (
        <Empty>
          {filtersActive
            ? "Ningún trasplante coincide con los filtros."
            : "Aún no hay trasplantes registrados. Pulsa 'Nuevo trasplante' para crear el primero."}
        </Empty>
      )}

      {groupedByMonth.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2 w-32">Fecha</th>
                <th className="px-3 py-2 w-20">Caso</th>
                <th className="px-3 py-2 w-32">Estado</th>
                <th className="px-3 py-2">Explante</th>
                <th className="px-3 py-2">Implante</th>
                <th className="px-3 py-2">Notas</th>
                <th className="px-3 py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {groupedByMonth.map(([ym, cases]) => (
                <Fragment key={ym}>
                  <tr className="bg-gray-50/70">
                    <td
                      colSpan={7}
                      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-600"
                    >
                      {monthHeaderLabel(ym)}
                      <span className="ml-2 font-normal text-gray-400">
                        · {cases.length} trasplante
                        {cases.length === 1 ? "" : "s"}
                      </span>
                    </td>
                  </tr>
                  {cases.map((c) => (
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
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
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

// Estado is derived from the case's notes (the special-case checkboxes
// write canonical phrases there; legacy rows carry them in a procedure
// note). The three special cases are the only non-default states;
// anything else is a complete transplant. Shared by the badge + the
// list filter so they never disagree.
type EstadoKey = "no_valido" | "envio" | "recibido" | "completo";

function caseEstado(c: TransplantCase): {
  key: EstadoKey;
  label: string;
  tone: "success" | "danger" | "info";
} {
  const parts = new Set<string>();
  if (c.notes) parts.add(c.notes);
  for (const p of c.procedures) if (p.notes) parts.add(p.notes);
  const low = Array.from(parts).join(" · ").toLowerCase();
  if (low.includes("no válido") || low.includes("no valido")) {
    return { key: "no_valido", label: "No válido", tone: "danger" };
  }
  if (
    low.includes("envío a otro hospital")
    || low.includes("envio a otro hospital")
  ) {
    return { key: "envio", label: "Envío", tone: "info" };
  }
  if (low.includes("recibido de otro hospital")) {
    return { key: "recibido", label: "Recibido", tone: "info" };
  }
  return { key: "completo", label: "Completo", tone: "success" };
}

/** One row per case in the dense list. Both procedures are
 * rendered inline (explante in one column, implante in the next)
 * so the customer can scan a month's worth at a glance. */
function CaseRow({
  c,
  onEdit,
  onDelete,
}: {
  c: TransplantCase;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const explante = c.procedures.find((p) => p.type === "explante");
  const implante = c.procedures.find((p) => p.type === "implante");
  // Collapse all the case-level + per-procedure notes into a
  // single comma-separated cell. Dedupe — many migrated rows
  // share the same note across explante + implante ("No válido")
  // and showing it twice is noise.
  const notesSet = new Set<string>();
  if (c.notes) notesSet.add(c.notes);
  for (const p of c.procedures) {
    if (p.notes) notesSet.add(p.notes);
  }
  const notes = Array.from(notesSet).join(" · ");

  // Estado badge — derived from the notes (see caseEstado).
  const { label: statusLabel, tone: statusTone } = caseEstado(c);

  return (
    <tr className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
      <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-900">
        {shortDateLabel(c.occurred_on)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
        {c.external_case_id ? `#${c.external_case_id}` : "—"}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
      </td>
      <td className="px-3 py-2">
        <SurgeonCell proc={explante} />
      </td>
      <td className="px-3 py-2">
        <SurgeonCell proc={implante} />
      </td>
      <td className="px-3 py-2 text-xs italic text-gray-500 truncate max-w-[240px]">
        {notes || <span className="not-italic text-gray-300">—</span>}
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1 whitespace-nowrap">
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
      </td>
    </tr>
  );
}

/** Single surgeon cell — primary on top with optional secondary in
 * grey beneath. Renders an empty-dash placeholder when this case
 * doesn't have a procedure of the expected type at all, and an
 * italic "Sin local" when the procedure exists but the primary is
 * NULL (cross-hospital). */
function SurgeonCell({ proc }: { proc: TransplantProcedure | undefined }) {
  if (!proc) {
    return <span className="text-gray-300">—</span>;
  }
  if (!proc.primary_person_name) {
    return (
      <span className="italic text-gray-400">Sin local</span>
    );
  }
  return (
    <span className="text-gray-800">
      {personLastName({
        name: proc.primary_person_name,
        last_name: proc.primary_person_last_name,
      })}
      {proc.secondary_person_name && (
        <span className="text-gray-500">
          {" "}
          + {personLastName({
            name: proc.secondary_person_name,
            last_name: proc.secondary_person_last_name,
          })}
        </span>
      )}
    </span>
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

// Three recurring shapes a transplant can take. Each is just a
// canonical phrase we drop into the case notes (where the list view +
// stats read it from) — no extra column, so it stays flexible and the
// admin can still add free text alongside.
const SPECIAL_CASE_NOTES: { key: string; label: string; phrase: string }[] = [
  // organ extracted but not transplanted
  { key: "invalido", label: "No válido", phrase: "No válido" },
  // we explanted, the organ went to another hospital
  { key: "enviado", label: "Envío a otro hospital", phrase: "Envío a otro hospital" },
  // we only implanted an organ received from elsewhere
  { key: "recibido", label: "Recibido de otro hospital", phrase: "Recibido de otro hospital" },
];

function notesHasPhrase(notes: string, phrase: string): boolean {
  return notes.toLowerCase().includes(phrase.toLowerCase());
}

// Add or remove a canonical phrase from a free-text notes string. On
// add we prepend it (so it leads the note); on remove we strip the
// phrase plus any trailing ". " / whitespace separator and tidy up.
function toggleNotePhrase(notes: string, phrase: string, on: boolean): string {
  const has = notesHasPhrase(notes, phrase);
  if (on === has) return notes;
  if (on) {
    const rest = notes.trim();
    return rest ? `${phrase}. ${rest}` : phrase;
  }
  return notes
    .replace(new RegExp(`${phrase}\\.?\\s*`, "i"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
  // Single case-level date (no time). Explante + implante always
  // happen the same day in practice, so we collect one date and
  // stamp both procedures with it. Seed from the earliest procedure
  // on record when editing, else today.
  const [caseDate, setCaseDate] = useState<string>(() => {
    if (existing && existing.procedures.length > 0) {
      return existing.procedures
        .map((p) => p.occurred_at.slice(0, 10))
        .sort()[0];
    }
    return todayIso();
  });
  const [notes, setNotes] = useState<string>(existing?.notes ?? "");
  const [procedures, setProcedures] = useState<TransplantProcedureInput[]>(
    () => {
      if (existing) {
        return existing.procedures.map((p) => ({
          type: p.type,
          occurred_at: p.occurred_at,
          primary_person_id: p.primary_person_id,
          secondary_person_id: p.secondary_person_id,
          notes: p.notes,
        }));
      }
      // Fresh case: pre-fill BOTH halves of the transplant so
      // the admin's eye lands on a complete shape. The surgeon
      // selectors default to "Sin cirujano local", so a
      // cross-hospital case where only one half was done locally
      // just leaves the other side empty — no need to add or
      // remove rows by hand for the common case. The admin can
      // still drop a row entirely (× icon on each row) when one
      // half genuinely didn't happen at all.
      const at = defaultProcedureDateTime();
      return [
        {
          type: "explante",
          occurred_at: at,
          primary_person_id: null,
          secondary_person_id: null,
          notes: null,
        },
        {
          type: "implante",
          occurred_at: at,
          primary_person_id: null,
          secondary_person_id: null,
          notes: null,
        },
      ];
    },
  );

  const save = useMutation({
    mutationFn: () => {
      // Stamp every procedure with the single case date at a fixed
      // 11:00Z — Spain is UTC+1/+2 so this never crosses a calendar
      // day, and the backend only reads the date off it.
      const at = `${caseDate}T11:00:00Z`;
      const body: TransplantCaseInput = {
        // The "Referencia externa" field was removed from the form.
        // Preserve any imported/existing id so editing a legacy case
        // never wipes its #number; new cases simply have none.
        external_case_id: existing?.external_case_id ?? null,
        notes: notes.trim() || null,
        procedures: procedures.map((p) => ({
          type: p.type,
          occurred_at: at,
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
        {/* Caso especial — quick toggles at the top. Each writes (or
            removes) its canonical phrase in the notes; the list view,
            stats and estado badge all read these phrases. */}
        <div>
          <span className="text-sm font-medium text-gray-700">
            Caso especial
          </span>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {SPECIAL_CASE_NOTES.map((s) => (
              <label
                key={s.key}
                className="flex items-center gap-1.5 text-sm text-gray-700"
              >
                <input
                  type="checkbox"
                  checked={notesHasPhrase(notes, s.phrase)}
                  onChange={(e) =>
                    setNotes((n) => toggleNotePhrase(n, s.phrase, e.target.checked))
                  }
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
                {s.label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="case-date"
            className="text-sm font-medium text-gray-700"
          >
            Fecha del caso
          </label>
          <input
            id="case-date"
            type="date"
            value={caseDate}
            onChange={(e) => setCaseDate(e.target.value)}
            className="mt-1 block rounded-md border border-gray-300 px-3 py-2 text-sm"
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

        <div className="border-t border-gray-100 pt-3">
          <span className="text-sm font-medium text-gray-700">Notas del caso</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="mt-1.5 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            placeholder="Notas sobre el caso (opcional)…"
          />
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
  // The date lives once at the case level and the free-text per-
  // procedure notes were dropped (the special-case checkboxes cover
  // the common annotations now) — each procedure is just its type +
  // surgeons. Any existing proc.notes is preserved through save.
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

"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sun } from "lucide-react";
import {
  api,
  personLastName,
  type Assignment,
  type AvailabilityBlockType,
  type Periodo,
} from "@/lib/api";
import {
  Button,
  ErrorText,
  Modal,
  Select,
  TextField,
} from "@/components/admin/ui";
import { PlanningGrid } from "@/components/schedule/planning-grid";
import { ViolationsBanner } from "@/components/schedule/ViolationsBanner";

// ---------------------------------------------------------------------------
// ScheduleSection: the editable body of ONE schedule.
//
// Owns the data fetches (detail / holidays / absences / meetings / violations
// / periodos / team), the rule-violation cell-flag computation, the planning
// grid, the per-cell mutations (save / clear / dismiss / lock / sin-cubrir),
// the violations banner, and the inline modals (AssignmentEdit, ManageAbsences,
// IncidentPrompt).
//
// What it does NOT own:
//   - The page-level title / status pill / Publicar-Reabrir-Archivar buttons
//   - NotifyConfirmModal (lives on the page that orchestrates publish/reopen)
//   - BalanceStats — the Reparto-por-persona table. The per-month page renders
//     ONE per section; the period view renders ONE aggregated table over all
//     sections. Keeping it out of this component lets either pattern compose.
//
// All react-query keys MATCH the keys the per-month page used before the
// extraction, so the cache is shared and a period view stacking Julio +
// Agosto sections only refetches data that's not already there.
// ---------------------------------------------------------------------------

export type ScheduleSectionProps = {
  scheduleId: number;
  /** Optional override: hide the per-section violations banner (the period
   * view may aggregate violations elsewhere — though V.1 keeps them per
   * section for clarity). Defaults to false. */
  hideViolationsBanner?: boolean;
  /** Force read-only mode regardless of schedule status. The per-month page
   * uses status=draft as the editability gate; pass this prop if the parent
   * wants to additionally suppress edits (e.g. a future stats-only view).
   * Defaults to false — editability comes from status. */
  readonly?: boolean;
};

export function ScheduleSection({
  scheduleId: id,
  hideViolationsBanner = false,
  readonly = false,
}: ScheduleSectionProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Assignment | null>(null);
  // Date the admin clicked on the Libre row, to open the
  // "add absence" modal pre-filled with that day.
  const [addingAbsenceDate, setAddingAbsenceDate] = useState<string | null>(
    null,
  );

  // Follow-up prompt for documenting a manual change on a REOPENED
  // schedule (status=draft + reopened_at set). Set when a save /
  // clear / dismiss mutation succeeds; rendered as a small
  // IncidentPromptModal. Lock toggles don't trigger it — they're
  // metadata, not a substantive change. `incidentSuppressedRef`
  // remembers whether the admin clicked "No preguntar más" so we
  // stop nagging during the rest of this page-load session.
  const [incidentPrompt, setIncidentPrompt] = useState<{
    slotName: string;
    date: string;
    kind: "change" | "clear" | "dismiss";
  } | null>(null);
  const incidentSuppressedRef = useRef(false);

  const detail = useQuery({
    queryKey: ["schedule", id],
    queryFn: () => api.getSchedule(id),
    enabled: !Number.isNaN(id),
  });
  const holidays = useQuery({
    queryKey: ["holidays-detail", detail.data?.period],
    queryFn: () =>
      api.listHolidays(new Date(detail.data!.period).getFullYear()),
    enabled: !!detail.data,
  });

  // Backfill mutation for legacy "—" cells. Creates an Assignment
  // row with person_id=null so the cell renders as Sin cubrir and
  // becomes editable through the regular Reasignar modal. Same query
  // invalidation shape as the regular cell edit so the grid +
  // violations banner refresh together.
  const createSinCubrir = useMutation({
    mutationFn: (vars: {
      slot_id: number;
      team_role_id: number | null;
      date: string;
    }) =>
      api.createAssignment(id, {
        slot_id: vars.slot_id,
        team_role_id: vars.team_role_id,
        date: vars.date,
        person_id: null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", id] });
      qc.invalidateQueries({ queryKey: ["schedule-violations", id] });
    },
  });

  const absences = useQuery({
    queryKey: ["team-absences", detail.data?.period],
    queryFn: () => {
      const period = detail.data!.period;
      // Bound the query to the schedule's month (a year fits in the
      // browser cache anyway, but this keeps the payload tight).
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const from = `${period.slice(0, 7)}-01`;
      const to = `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
      return api.listTeamAbsences({ from, to });
    },
    enabled: !!detail.data,
  });

  // Meeting occurrences for this month — drives the "Reuniones"
  // row in the planning grid. Admin sees every meeting (the
  // backend's audience filter is bypassed for admins).
  const meetingInstances = useQuery({
    queryKey: ["meeting-instances", detail.data?.period],
    queryFn: () => {
      const period = detail.data!.period;
      const y = Number(period.slice(0, 4));
      const m = Number(period.slice(5, 7));
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const from = `${period.slice(0, 7)}-01`;
      const to = `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
      return api.listMeetingInstances(from, to);
    },
    enabled: !!detail.data,
  });

  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  // Rule-violation list for the ViolationsBanner + per-cell markers
  // in the planning grid. Refetched whenever the schedule is
  // invalidated (after any assignment save) so the count stays
  // current as the admin edits cells.
  const violations = useQuery({
    queryKey: ["schedule-violations", id],
    queryFn: () => api.listScheduleViolations(id),
    enabled: !!detail.data,
  });
  // Vacation V.1: surface a banner when the schedule's month overlaps
  // an active periodo, so the admin understands why some cells have
  // different slot config than usual (Quirófano halved, Consulta off,
  // etc.). Fetches all periodos and filters client-side — there are
  // at most a handful per tenant.
  const periodos = useQuery({
    queryKey: ["periodos"],
    queryFn: api.listPeriodos,
  });
  const overlappingPeriodos = useMemo(() => {
    if (!detail.data || !periodos.data) return [] as Periodo[];
    // Build [month_start, month_end] for this schedule.
    const monthFirst = detail.data.period;
    const [yy, mm] = monthFirst.split("-").map(Number);
    const monthStart = `${monthFirst.slice(0, 8)}01`;
    const lastDay = new Date(yy, mm, 0).getDate();
    const monthEnd = `${monthFirst.slice(0, 8)}${String(lastDay).padStart(2, "0")}`;
    // Overlap: periodo.end >= monthStart AND periodo.start <= monthEnd.
    return periodos.data.filter(
      (p) => p.end_date >= monthStart && p.start_date <= monthEnd,
    );
  }, [detail.data, periodos.data]);
  const flaggedAssignmentIds = useMemo(() => {
    const s = new Set<number>();
    // Suppressed ("Ocultar"-ed by admin) violations don't paint the
    // cell ring — once overruled the grid should look clean. The
    // banner still surfaces them under its "Mostrar N ocultos"
    // toggle if the admin needs to revisit.
    for (const v of violations.data ?? []) {
      if (v.suppressed_at !== null) continue;
      for (const c of v.cells) s.add(c.assignment_id);
    }
    return s;
  }, [violations.data]);

  if (detail.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (detail.isError || !detail.data) {
    return <ErrorText>{(detail.error as Error)?.message ?? "Error"}</ErrorText>;
  }

  const s = detail.data;
  const isEditable = !readonly && s.status === "draft";

  return (
    <>
      {overlappingPeriodos.length > 0 && (
        <PeriodoBanner periodos={overlappingPeriodos} />
      )}

      {!hideViolationsBanner && (
        <ViolationsBanner
          scheduleId={id}
          violations={violations.data ?? []}
        />
      )}

      <PlanningGrid
        assignments={s.assignments}
        holidayDates={holidayDates}
        onCellClick={isEditable ? (a) => setEditing(a) : undefined}
        absences={absences.data}
        meetings={meetingInstances.data}
        flaggedAssignmentIds={flaggedAssignmentIds}
        // Libre row only becomes interactive while the schedule is
        // still a draft. Once published / archived the team has
        // already seen the planning, so absence edits should go
        // through /admin/availability (and ideally a reopen of the
        // schedule).
        onAbsenceCellClick={
          isEditable ? (d) => setAddingAbsenceDate(d) : undefined
        }
        // Legacy data sometimes has cells missing their Assignment row
        // entirely (the row disappeared in the previous tool and came
        // over that way in the migrate). Such cells render as "—" with
        // no way to reassign. Admin clicking one creates a Sin-cubrir
        // row in place; the cell then becomes interactive via the
        // normal Reasignar flow. Confirm prompt avoids accidental
        // creates on the many legitimate "—" cells (e.g. weekend
        // columns for weekday-only slots).
        onEmptyCellClick={
          isEditable
            ? ({ slot_id, team_role_id, slot_name, team_role_label, date }) => {
                const label = team_role_label
                  ? `${slot_name} — ${team_role_label}`
                  : slot_name;
                if (
                  !confirm(
                    `Crear celda "Sin cubrir" para ${label} el ${date}? Podrás asignar a alguien después.`,
                  )
                ) {
                  return;
                }
                createSinCubrir.mutate({ slot_id, team_role_id, date });
              }
            : undefined
        }
      />

      {editing && (
        <AssignmentEditModal
          assignment={editing}
          scheduleId={id}
          onClose={() => setEditing(null)}
          onChangeRecorded={(kind) => {
            // Only prompt for documentation when the schedule was
            // previously published + brought back for edits — i.e.
            // when other people may have already seen the old
            // version and would benefit from an explanation.
            if (!s.reopened_at) return;
            if (incidentSuppressedRef.current) return;
            if (!editing) return;
            setIncidentPrompt({
              slotName: editing.slot_name,
              date: editing.date,
              kind,
            });
          }}
        />
      )}
      {incidentPrompt && (
        <IncidentPromptModal
          data={incidentPrompt}
          onClose={(suppressFurther) => {
            setIncidentPrompt(null);
            if (suppressFurther) incidentSuppressedRef.current = true;
          }}
        />
      )}
      {addingAbsenceDate && (
        <ManageAbsencesModal
          date={addingAbsenceDate}
          onClose={() => setAddingAbsenceDate(null)}
        />
      )}
    </>
  );
}


function AssignmentEditModal({
  assignment,
  scheduleId,
  onClose,
  onChangeRecorded,
}: {
  assignment: Assignment;
  scheduleId: number;
  onClose: () => void;
  /** Fires after a substantive write (person change, clear, or
   * "No aplica" toggle) lands successfully. Parent uses it to
   * decide whether to show the incident-prompt follow-up. Lock /
   * unlock doesn't call this — it's pure metadata. */
  onChangeRecorded?: (kind: "change" | "clear" | "dismiss") => void;
}) {
  const qc = useQueryClient();
  const [selectedPid, setSelectedPid] = useState<number | "">(
    assignment.person_id ?? "",
  );

  const eligible = useQuery({
    queryKey: ["eligible", scheduleId, assignment.id],
    queryFn: () => api.listEligiblePersons(scheduleId, assignment.id),
  });

  // If the previously-assigned person is no longer eligible (e.g.
  // an approved bloqueo was created for them after the schedule
  // was published — the canonical "user asked off, mark them libre,
  // reassign their shift" flow), reset the dropdown to "Sin cubrir"
  // so submitting the form doesn't fire the eligibility check with
  // the dead person's id and surface a misleading bloqueo error.
  // The admin then has to consciously pick a replacement, which is
  // the whole point of opening this modal.
  useEffect(() => {
    if (!eligible.data) return;
    const currentInEligible = eligible.data.some(
      (p) => p.person_id === selectedPid,
    );
    if (selectedPid !== "" && !currentInEligible) {
      setSelectedPid("");
    }
    // Intentionally don't depend on selectedPid — this is a one-shot
    // reconciliation on eligible-load, not a continuous guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["schedule", scheduleId] });
    // Re-fetch violations so the banner + cell markers reflect the
    // new assignment state. Cheap (<100ms server-side) and the
    // immediate visual feedback is the whole point of the feature.
    qc.invalidateQueries({ queryKey: ["schedule-violations", scheduleId] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patchAssignment(scheduleId, assignment.id, {
        person_id: selectedPid === "" ? null : Number(selectedPid),
        clear_person: selectedPid === "",
      }),
    onSuccess: () => {
      invalidate();
      // "change" covers both "set a person" and "cleared via the
      // dropdown's Sin cubrir option" — the explicit Quitar button
      // below uses the separate clear mutation instead.
      onChangeRecorded?.(selectedPid === "" ? "clear" : "change");
      onClose();
    },
  });
  const clear = useMutation({
    mutationFn: () =>
      api.patchAssignment(scheduleId, assignment.id, { clear_person: true }),
    onSuccess: () => {
      invalidate();
      onChangeRecorded?.("clear");
      onClose();
    },
  });
  const lock = useMutation({
    mutationFn: () =>
      assignment.locked_at
        ? api.unlockAssignment(scheduleId, assignment.id)
        : api.lockAssignment(scheduleId, assignment.id),
    onSuccess: () => {
      // Deliberately NO onChangeRecorded — locking pins what the
      // solver should keep on a regenerate; it's not a substantive
      // change for the team, so we don't pester the admin to write
      // it up.
      invalidate();
      onClose();
    },
  });
  const dismiss = useMutation({
    mutationFn: () =>
      assignment.dismissed_at
        ? api.undismissAssignment(scheduleId, assignment.id)
        : api.dismissAssignment(scheduleId, assignment.id),
    onSuccess: () => {
      invalidate();
      onChangeRecorded?.("dismiss");
      onClose();
    },
  });
  const isDismissed = assignment.dismissed_at !== null;

  if (isDismissed) {
    return (
      <Modal
        open={true}
        onClose={onClose}
        title={`${assignment.slot_name} (${assignment.date})`}
      >
        <div className="space-y-3">
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Esta actividad está marcada como <strong>No aplica</strong> para
            este día. No se asignará a nadie y Trivu la ignorará al
            regenerar la planificación.
          </p>
          {dismiss.isError && (
            <ErrorText>{(dismiss.error as Error).message}</ErrorText>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
            <Button
              onClick={() => dismiss.mutate()}
              disabled={dismiss.isPending}
            >
              {dismiss.isPending ? "Aplicando…" : "Volver a aplicar"}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Asignar a ${assignment.slot_name} (${assignment.date})`}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Persona</span>
          <select
            value={String(selectedPid)}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedPid(v === "" ? "" : Number(v));
            }}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
          >
            <option value="">— Sin cubrir —</option>
            {(eligible.data ?? []).map((p) => (
              <option key={p.person_id} value={String(p.person_id)}>
                {personLastName({
                  name: p.person_name,
                  last_name: p.person_last_name,
                })}
              </option>
            ))}
          </select>
        </label>
        {eligible.isLoading && (
          <p className="text-xs text-gray-500">Cargando elegibles…</p>
        )}
        {eligible.data && eligible.data.length === 0 && (
          <p className="text-xs text-amber-700">
            Nadie cumple los requisitos para este slot/fecha.
          </p>
        )}
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        {dismiss.isError && (
          <ErrorText>{(dismiss.error as Error).message}</ErrorText>
        )}
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => lock.mutate()}
              disabled={lock.isPending}
            >
              {assignment.locked_at ? "Desbloquear" : "Bloquear"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (
                  confirm(
                    `Marcar ${assignment.slot_name} como "No aplica" el ${assignment.date}? Se aplicará a todo el día.`,
                  )
                ) {
                  dismiss.mutate();
                }
              }}
              disabled={dismiss.isPending}
            >
              No aplica hoy
            </Button>
            <Button
              variant="danger"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
            >
              Vaciar
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Asignar"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}


const ABSENCE_TYPE_OPTIONS: { value: AvailabilityBlockType; label: string }[] = [
  { value: "vacation", label: "Vacaciones" },
  { value: "sick", label: "Baja médica" },
  { value: "training", label: "Formación" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Otro" },
];

function ManageAbsencesModal({
  date,
  onClose,
}: {
  date: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  // Pull the FULL availability_blocks for this date (admin endpoint —
  // returns block ids, statuses, ranges; the public TeamAbsence shape
  // is sanitized and doesn't include ids). Filter to approved blocks
  // covering the date, since the Libre row only renders those.
  const blocksQuery = useQuery({
    queryKey: ["availability-blocks", "date", date],
    queryFn: () =>
      api.listAvailabilityBlocks({
        from: date,
        to: date,
        status: "approved",
      }),
  });
  const [personId, setPersonId] = useState<number | "">("");
  const [blockType, setBlockType] = useState<AvailabilityBlockType>("vacation");
  const [notes, setNotes] = useState("");

  const invalidate = () => {
    // The Libre row reads from listTeamAbsences; the manage modal
    // reads from listAvailabilityBlocks. Bust both query families
    // so the UI stays in sync after any add/remove.
    qc.invalidateQueries({ queryKey: ["team-absences"] });
    qc.invalidateQueries({ queryKey: ["availability-blocks"] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.createAvailabilityBlock({
        person_id: Number(personId),
        start_date: date,
        end_date: date,
        block_type: blockType,
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      setPersonId("");
      setNotes("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAvailabilityBlock(id),
    onSuccess: invalidate,
  });

  const approvedBlocksForDay = (blocksQuery.data ?? []).filter(
    (b) => b.start_date <= date && date <= b.end_date,
  );
  const existingPersonIds = new Set(approvedBlocksForDay.map((b) => b.person_id));

  // Only offer people who don't ALREADY have an approved block on
  // this date so the admin can't accidentally create overlaps.
  const candidates = (team.data ?? []).filter(
    (m) => !existingPersonIds.has(m.person_id),
  );

  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString(
    "es-ES",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  );

  const confirmRemove = (blockId: number, label: string, isMultiDay: boolean, start: string, end: string) => {
    const msg = isMultiDay
      ? `${label} tiene una ausencia del ${start} al ${end}. ¿Quitarla entera? Esta acción afecta a todos los días del rango.`
      : `¿Quitar la ausencia de ${label} el ${start}?`;
    if (confirm(msg)) remove.mutate(blockId);
  };

  return (
    <Modal open={true} onClose={onClose} title="Gestionar ausencias">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Día: <span className="font-medium text-gray-800">{formattedDate}</span>
        </p>

        {/* Current absences for this date with remove buttons. */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">
            Actualmente libres
          </h3>
          {blocksQuery.isLoading && (
            <p className="text-sm text-gray-500">Cargando…</p>
          )}
          {blocksQuery.data && approvedBlocksForDay.length === 0 && (
            <p className="text-xs text-gray-500">
              Nadie está marcado como libre este día.
            </p>
          )}
          {approvedBlocksForDay.length > 0 && (
            <ul className="space-y-1">
              {approvedBlocksForDay.map((b) => {
                const isMultiDay = b.start_date !== b.end_date;
                return (
                  <li
                    key={b.id}
                    className="flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm"
                  >
                    <span>
                      <span className="font-medium text-gray-800">
                        {b.person_name}
                      </span>
                      <span className="ml-2 text-xs text-gray-500">
                        {ABSENCE_TYPE_OPTIONS.find(
                          (o) => o.value === b.block_type,
                        )?.label ?? b.block_type}
                      </span>
                      {isMultiDay && (
                        <span className="ml-2 text-xs text-amber-700">
                          ({b.start_date} → {b.end_date})
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        confirmRemove(
                          b.id,
                          b.person_name,
                          isMultiDay,
                          b.start_date,
                          b.end_date,
                        )
                      }
                      disabled={remove.isPending}
                      className="text-xs text-red-700 hover:underline disabled:text-gray-400 disabled:no-underline"
                    >
                      Quitar
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {remove.isError && (
            <div className="mt-2">
              <ErrorText>{(remove.error as Error).message}</ErrorText>
            </div>
          )}
        </div>

        {/* Add-new form. */}
        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (personId === "") return;
            add.mutate();
          }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Añadir persona
          </h3>
          <Select
            label="Persona"
            value={personId}
            onChange={(v) => setPersonId(v === "" ? "" : Number(v))}
            options={[
              { value: "", label: "— Selecciona —" },
              ...candidates.map((m) => ({
                value: m.person_id,
                // Last-name-only convention (matches the planning
                // grid, BalanceStats, rotation pickers, etc.).
                // personLastName falls back to whitespace-splitting
                // when no explicit last_name field is present, which
                // is the case for TeamMember rows today.
                label: personLastName({ name: m.person_name }),
              })),
            ]}
          />
          {candidates.length === 0 && (
            <p className="text-xs text-amber-700">
              Todos los miembros del equipo ya tienen una ausencia registrada
              para este día.
            </p>
          )}
          <Select
            label="Tipo"
            value={blockType}
            onChange={(v) => v && setBlockType(v as AvailabilityBlockType)}
            options={ABSENCE_TYPE_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
          />
          <TextField
            label="Nota (opcional)"
            value={notes}
            onChange={setNotes}
            placeholder="Visible para administradores"
          />
          {add.isError && (
            <ErrorText>{(add.error as Error).message}</ErrorText>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
            <Button type="submit" disabled={add.isPending || personId === ""}>
              {add.isPending ? "Guardando…" : "Añadir"}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}


/**
 * Follow-up shown after a manual change on a REOPENED schedule.
 * Asks the admin to optionally log why they touched a published
 * cell — useful both as a paper trail and as a place to record
 * the side-channel communication ("avisé a Marta por WhatsApp").
 *
 * Pre-fills:
 *   - title: short summary based on the cell that changed
 *   - occurred_at: the assignment's date (NOT today). When you
 *     read "Incidencias del 18 mayo" later you want to see the
 *     change associated with that day, not the day you happened
 *     to make the edit.
 *
 * Skipping is the friendly default — "Ahora no" closes without
 * writing anything. The "No volver a preguntar" checkbox is
 * session-scoped (lives in a useRef on the parent), so the
 * dismissal lasts only until the admin refreshes the page or
 * navigates away. We don't persist it: tomorrow's edits should
 * get the chance to be documented even if today they weren't in
 * the mood.
 */
function IncidentPromptModal({
  data,
  onClose,
}: {
  data: {
    slotName: string;
    date: string;
    kind: "change" | "clear" | "dismiss";
  };
  /** Pass `suppressFurther=true` when the user wants to silence
   * the prompt for the rest of this page-load session. */
  onClose: (suppressFurther: boolean) => void;
}) {
  const qc = useQueryClient();
  // Short, human-readable summary of the change. The admin can
  // (and usually will) edit it before saving.
  const defaultTitle = (() => {
    const prefix =
      data.kind === "dismiss"
        ? "Cancelado"
        : data.kind === "clear"
          ? "Quitada cobertura"
          : "Cambio";
    return `${prefix} en ${data.slotName} del ${formatShortDate(data.date)}`;
  })();
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [occurredAt, setOccurredAt] = useState(data.date);
  const [suppress, setSuppress] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.createIncident({
        occurred_at: occurredAt,
        title: title.trim(),
        body: body.trim() ? body.trim() : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incidents"] });
      onClose(suppress);
    },
  });

  return (
    <Modal
      open={true}
      onClose={() => onClose(suppress)}
      title="¿Anotar el motivo del cambio?"
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) save.mutate();
        }}
      >
        <p className="text-sm text-gray-600">
          Como la planificación ya estaba publicada, conviene dejar
          constancia del cambio para el resto del equipo. Esto se
          guarda en <strong>Incidencias</strong>.
        </p>
        <TextField label="Título" value={title} onChange={setTitle} required />
        <TextField
          label="Fecha"
          type="date"
          value={occurredAt}
          onChange={setOccurredAt}
          required
        />
        <div>
          <span className="text-sm font-medium text-gray-700">
            Motivo (opcional)
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            maxLength={10000}
            placeholder="Por qué, a quién avisaste, repercusiones…"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600 pt-1">
          <input
            type="checkbox"
            checked={suppress}
            onChange={(e) => setSuppress(e.target.checked)}
            className="h-3.5 w-3.5 accent-brand-600"
          />
          No volver a preguntar para los próximos cambios de esta sesión.
        </label>
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={() => onClose(suppress)}>
            Ahora no
          </Button>
          <Button type="submit" disabled={save.isPending || !title.trim()}>
            {save.isPending ? "Guardando…" : "Anotar incidencia"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "18 mayo" — short date for inline use in pre-filled incident
 * titles. We avoid weekday + year here because the title is a
 * one-liner; the full date lives on the incident's own
 * `occurred_at` field. */
function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const MONTHS = [
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
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

// Vacation V.1: small awareness banner. Renders above the violations
// banner when the current schedule's month overlaps an active periodo.
// Click-through to the periodo editor so the admin can see / tweak the
// regime that produced this month's atypical cells.
function PeriodoBanner({ periodos }: { periodos: Periodo[] }) {
  const fmt = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("es-ES", {
      day: "numeric",
      month: "short",
    });
  return (
    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2">
      <div className="flex items-start gap-2">
        <Sun className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div className="flex-1 text-sm text-amber-900">
          {periodos.length === 1 ? (
            <span>
              <strong>{periodos[0].name}</strong> activo del{" "}
              {fmt(periodos[0].start_date)} al {fmt(periodos[0].end_date)}.
              Las actividades y reglas pueden estar modificadas en esas
              fechas.{" "}
              <Link
                href={`/admin/periodos/${periodos[0].id}`}
                className="underline-offset-2 hover:underline"
              >
                Editar reglas →
              </Link>
            </span>
          ) : (
            <span>
              {periodos.length} periodos especiales activos este mes:{" "}
              {periodos.map((p, i) => (
                <span key={p.id}>
                  {i > 0 ? ", " : ""}
                  <Link
                    href={`/admin/periodos/${p.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {p.name}
                  </Link>
                  {" "}
                  ({fmt(p.start_date)} – {fmt(p.end_date)})
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  personLastName,
  type Assignment,
  type AvailabilityBlockType,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  Card,
  ErrorText,
  Modal,
  Select,
  TextField,
} from "@/components/admin/ui";
import { Avatar, PlanningGrid } from "@/components/schedule/planning-grid";
import { ViolationsBanner } from "@/components/schedule/ViolationsBanner";
import { formatPeriod } from "@/components/admin/month-picker";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

// Plain-language explainer rendered next to the bold status word
// so non-technical admins can tell at a glance what changes for
// the team in each state. See also: /admin/schedule list view.
const STATUS_SUBTITLE: Record<string, string> = {
  draft: "solo tú la ves",
  published: "visible para el equipo",
  archived: "ya no visible para el equipo",
};

export default function ScheduleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = Number(params.id);
  const [editing, setEditing] = useState<Assignment | null>(null);
  // Which lifecycle action is currently being confirmed via the
  // notify-members modal. Null when no modal is open.
  const [confirmingAction, setConfirmingAction] = useState<
    "publish" | "reopen" | null
  >(null);
  // Date the admin clicked on the Libre row, to open the
  // "add absence" modal pre-filled with that day.
  const [addingAbsenceDate, setAddingAbsenceDate] = useState<string | null>(
    null,
  );

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

  const publish = useMutation({
    mutationFn: (notifyMembers: boolean) =>
      api.publishSchedule(id, notifyMembers),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", id] }),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", id] }),
  });
  const unarchive = useMutation({
    mutationFn: () => api.unarchiveSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", id] });
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const reopen = useMutation({
    mutationFn: (notifyMembers: boolean) =>
      api.reopenSchedule(id, notifyMembers),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", id] });
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => api.generateSchedule(detail.data!.period),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace(`/admin/schedule/${data.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace("/admin/schedule");
    },
  });
  const downloadPdf = useMutation({
    mutationFn: () => api.downloadSchedulePdf(id),
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
      // Main planning's Libre row should only show main-team
      // members. Sub-equipo absences live on the sub-equipo's
      // own grid; mixing them in here was the source of "why
      // are residents showing up as libre in the admin
      // planning?" — fixed by scoping the absences fetch.
      return api.listTeamAbsences({ from, to, mainTeamOnly: true });
    },
    enabled: !!detail.data,
  });
  // Loaded here so BalanceStats can sort columns by (categoría, name).
  // Same query key used inside ManageAbsencesModal — react-query
  // dedupes the request.
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

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
  const flaggedAssignmentIds = useMemo(() => {
    const s = new Set<number>();
    for (const v of violations.data ?? []) {
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
  const isEditable = s.status === "draft";
  // Surface mutation errors that until now were swallowed silently
  // (e.g. unarchive failing → button briefly disables, nothing else).
  // First non-null wins; refreshing detail.data implicitly clears the
  // visible error after a successful retry.
  const actionError =
    (publish.error as Error | null)
    ?? (archive.error as Error | null)
    ?? (unarchive.error as Error | null)
    ?? (reopen.error as Error | null)
    ?? (regenerate.error as Error | null)
    ?? (remove.error as Error | null)
    ?? (downloadPdf.error as Error | null);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{`Planificación · ${formatPeriod(s.period)}`}</h1>
        <div className="flex gap-2">
          {s.status === "draft" && (
            <>
              <Button
                variant="secondary"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
              >
                Regenerar
              </Button>
              <Button
                onClick={() => setConfirmingAction("publish")}
                disabled={publish.isPending}
              >
                {publish.isPending ? "Publicando…" : "Publicar"}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    confirm(
                      `¿Eliminar el borrador de ${formatPeriod(s.period)}? Esta acción no se puede deshacer.`,
                    )
                  ) {
                    remove.mutate();
                  }
                }}
                disabled={remove.isPending}
              >
                Eliminar
              </Button>
            </>
          )}
          {s.status === "published" && (
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmingAction("reopen")}
                disabled={reopen.isPending}
              >
                {reopen.isPending ? "Reabriendo…" : "Reabrir"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
              >
                Archivar
              </Button>
            </>
          )}
          {s.status === "archived" && (
            <Button
              variant="secondary"
              onClick={() => unarchive.mutate()}
              disabled={unarchive.isPending}
            >
              {unarchive.isPending ? "Desarchivando…" : "Desarchivar"}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => downloadPdf.mutate()}
            disabled={downloadPdf.isPending}
          >
            {downloadPdf.isPending ? "Generando PDF…" : "Descargar PDF"}
          </Button>
        </div>
      </div>
      {actionError && (
        <div className="mb-3">
          <ErrorText>{actionError.message}</ErrorText>
        </div>
      )}
      <p className="mb-4 text-sm text-gray-600">
        Estado: <span className="font-medium">{STATUS_LABEL[s.status]}</span>
        {STATUS_SUBTITLE[s.status] && (
          <span className="ml-1 text-gray-500">
            · {STATUS_SUBTITLE[s.status]}
          </span>
        )}
        {s.reopened_at && (
          <span
            className="ml-3 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-50 text-amber-800 border border-amber-200"
            title={
              "Esta planificación fue reabierta el "
              + new Date(s.reopened_at).toLocaleString()
              + ". Los miembros del equipo no la verán hasta que se publique de nuevo."
            }
          >
            Reabierta
          </span>
        )}
        {s.solver_used && (
          <span
            className={
              "ml-3 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide "
              + (s.solver_used === "cpsat"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-800 border border-amber-200")
            }
            title={
              s.solver_used === "cpsat"
                ? "Equilibrada: equidad, descansos y reglas cruzadas aplicadas."
                : "Simplificada (respaldo): no se pudo equilibrar con todas las reglas activas — la planificación es válida pero el reparto puede ser desigual."
            }
          >
            {s.solver_used === "cpsat" ? "Equilibrada" : "Simplificada"}
          </span>
        )}
        {isEditable && (
          <span className="ml-3 text-xs text-gray-500">
            (haz clic en una celda para editarla)
          </span>
        )}
      </p>

      <ViolationsBanner violations={violations.data ?? []} />

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
      />

      <BalanceStats
        // Main planning's reparto only covers main-team
        // assignments — sub-equipo slots belong on the
        // sub-equipo's own balance view, mixing them in here
        // surfaced residents in the admin's main breakdown.
        // Same scoping as the Libre row above.
        assignments={s.assignments.filter(
          (a) => a.slot_group_id === null,
        )}
        holidayDates={holidayDates}
        team={team.data ?? []}
      />

      {editing && (
        <AssignmentEditModal
          assignment={editing}
          scheduleId={id}
          onClose={() => setEditing(null)}
        />
      )}
      {addingAbsenceDate && (
        <ManageAbsencesModal
          date={addingAbsenceDate}
          onClose={() => setAddingAbsenceDate(null)}
        />
      )}
      {confirmingAction === "publish" && (
        <NotifyConfirmModal
          title="Publicar planificación"
          description={
            s.reopened_at
              ? "La planificación volverá a estar visible en \"Mis turnos\" con los ajustes que has hecho."
              : "La planificación quedará visible para todos los miembros del equipo en \"Mis turnos\"."
          }
          confirmLabel="Publicar"
          notifyLabel="Avisar por email a los miembros del equipo"
          onClose={() => setConfirmingAction(null)}
          onConfirm={(notify) => {
            publish.mutate(notify, {
              onSuccess: () => setConfirmingAction(null),
            });
          }}
          isPending={publish.isPending}
        />
      )}
      {confirmingAction === "reopen" && (
        <NotifyConfirmModal
          title="Reabrir planificación"
          description={
            "Volver a borrador para hacer cambios. Los cambios de turno pendientes se cancelarán y la planificación dejará de estar visible en \"Mis turnos\" hasta volver a publicarla."
          }
          confirmLabel="Reabrir"
          notifyLabel="Avisar por email a los miembros del equipo"
          onClose={() => setConfirmingAction(null)}
          onConfirm={(notify) => {
            reopen.mutate(notify, {
              onSuccess: () => setConfirmingAction(null),
            });
          }}
          isPending={reopen.isPending}
        />
      )}
    </>
  );
}


function AssignmentEditModal({
  assignment,
  scheduleId,
  onClose,
}: {
  assignment: Assignment;
  scheduleId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [selectedPid, setSelectedPid] = useState<number | "">(
    assignment.person_id ?? "",
  );

  const eligible = useQuery({
    queryKey: ["eligible", scheduleId, assignment.id],
    queryFn: () => api.listEligiblePersons(scheduleId, assignment.id),
  });

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
      onClose();
    },
  });
  const clear = useMutation({
    mutationFn: () =>
      api.patchAssignment(scheduleId, assignment.id, { clear_person: true }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const lock = useMutation({
    mutationFn: () =>
      assignment.locked_at
        ? api.unlockAssignment(scheduleId, assignment.id)
        : api.lockAssignment(scheduleId, assignment.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

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
                {p.person_name}
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
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => lock.mutate()}
              disabled={lock.isPending}
            >
              {assignment.locked_at ? "Desbloquear" : "Bloquear"}
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

// ---------------------------------------------------------------------------
// Balance stats: per-person counts of slot assignments. Lets the admin see
// at a glance whether the schedule is fairly distributed. Min/max highlighted
// per column so outliers stand out.
// ---------------------------------------------------------------------------

function BalanceStats({
  assignments,
  holidayDates,
  team,
}: {
  assignments: Assignment[];
  holidayDates: Set<string>;
  /** Used to sort the column headers by (categoría, name) so the
   * Reparto matches the order admins see on /admin/team. Without it
   * the table sorted alphabetically by last-name only and mixed
   * residents and adjuntos in the row. */
  team: TeamMember[];
}) {
  const stats = useMemo(() => {
    // Sprint 16: rows are keyed by (slot_name, team_role_label) so a
    // team_composition slot like Trasplante shows up as three rows
    // (Explante / Implante 1 / Implante 2) instead of one aggregated
    // row that hides whether the role rotation is balanced.
    type RowKey = { slot_name: string; team_role_label: string | null };
    const keyFor = (k: RowKey) =>
      `${k.slot_name}\x00${k.team_role_label ?? ""}`;
    type PersonMeta = {
      name: string;
      avatar_url: string | null;
      // Used to sort columns by (categoría, name). Pulled from the
      // team list since Assignment payloads don't carry category info.
      category_name: string | null;
    };
    const teamByPerson = new Map<
      number,
      { category_name: string | null }
    >();
    for (const m of team) {
      teamByPerson.set(m.person_id, { category_name: m.category_name });
    }
    const persons = new Map<number, PersonMeta>();
    const rows = new Map<string, RowKey>();
    const counts = new Map<string, Map<number, number>>(); // key -> pid -> n
    const weByPerson = new Map<number, number>();          // pid -> we/holiday count
    for (const a of assignments) {
      if (a.person_id === null || a.person_name === null) continue;
      if (!persons.has(a.person_id)) {
        // Render the LAST name in the BalanceStats header for the
        // same reason the planning grid uses it: tight columns. The
        // helper falls back to a heuristic split of `name` when
        // last_name isn't populated yet.
        const lastName = personLastName({
          name: a.person_name,
          last_name: a.person_last_name,
        });
        persons.set(a.person_id, {
          name: lastName,
          avatar_url: a.person_avatar_url ?? null,
          category_name:
            teamByPerson.get(a.person_id)?.category_name ?? null,
        });
      }
      const rk: RowKey = {
        slot_name: a.slot_name,
        team_role_label: a.team_role_label ?? null,
      };
      const ks = keyFor(rk);
      if (!rows.has(ks)) rows.set(ks, rk);
      let row = counts.get(ks);
      if (!row) {
        row = new Map();
        counts.set(ks, row);
      }
      row.set(a.person_id, (row.get(a.person_id) ?? 0) + 1);
      const wd = new Date(a.date).getUTCDay();
      if (wd === 0 || wd === 6 || holidayDates.has(a.date)) {
        weByPerson.set(a.person_id, (weByPerson.get(a.person_id) ?? 0) + 1);
      }
    }
    // Sort columns first by categoría (alphabetical, with null
    // categorías last so admins like Sales don't shove the clinical
    // grouping around), then by last-name. Mirrors the /admin/team
    // page's ordering so the two views line up.
    const personsSorted = Array.from(persons.entries()).sort((a, b) => {
      const ca = a[1].category_name;
      const cb = b[1].category_name;
      if (ca !== cb) {
        if (ca === null) return 1;
        if (cb === null) return -1;
        const byCat = ca.localeCompare(cb, "es");
        if (byCat !== 0) return byCat;
      }
      return a[1].name.localeCompare(b[1].name, "es");
    });
    const rowsSorted = Array.from(rows.values()).sort((a, b) => {
      const byName = a.slot_name.localeCompare(b.slot_name);
      if (byName !== 0) return byName;
      // Same slot: keep the no-role row first (rare — shouldn't
      // coexist with role rows, but defensive), then alpha by role.
      if (a.team_role_label === null && b.team_role_label !== null) return -1;
      if (a.team_role_label !== null && b.team_role_label === null) return 1;
      return (a.team_role_label ?? "").localeCompare(b.team_role_label ?? "");
    });

    // Per-row min/max across persons for highlighting.
    const minMaxByRow = new Map<string, { min: number; max: number }>();
    for (const rk of rowsSorted) {
      const ks = keyFor(rk);
      const row = counts.get(ks)!;
      let mn = Infinity;
      let mx = -Infinity;
      for (const [pid] of personsSorted) {
        const v = row.get(pid) ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      minMaxByRow.set(ks, { min: mn, max: mx });
    }

    // Per-person totals + min/max across persons.
    const totalByPerson = new Map<number, number>();
    for (const [pid] of personsSorted) {
      let s = 0;
      for (const rk of rowsSorted) {
        s += counts.get(keyFor(rk))?.get(pid) ?? 0;
      }
      totalByPerson.set(pid, s);
    }
    let totalMin = Infinity;
    let totalMax = -Infinity;
    for (const v of totalByPerson.values()) {
      if (v < totalMin) totalMin = v;
      if (v > totalMax) totalMax = v;
    }
    let weMin = Infinity;
    let weMax = -Infinity;
    for (const [pid] of personsSorted) {
      const v = weByPerson.get(pid) ?? 0;
      if (v < weMin) weMin = v;
      if (v > weMax) weMax = v;
    }
    return {
      personsSorted,
      rowsSorted,
      keyFor,
      counts,
      minMaxByRow,
      totalByPerson,
      totalMin,
      totalMax,
      weByPerson,
      weMin,
      weMax,
    };
  }, [assignments, holidayDates, team]);

  if (stats.personsSorted.length === 0) return null;

  const cellClass = (
    v: number,
    mn: number,
    mx: number,
    differs: boolean,
  ) => {
    if (!differs) return "text-gray-700";
    if (v === mx && mx !== mn) return "text-rose-700 font-medium";
    if (v === mn && mx !== mn) return "text-emerald-700";
    return "text-gray-700";
  };

  return (
    <div className="mt-6 inline-block max-w-full overflow-x-auto">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">
        Reparto por persona
      </h2>
      <Card>
        <table className="text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 text-left">
            <tr className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2">Actividad</th>
              {stats.personsSorted.map(([pid, meta]) => (
                <th
                  key={pid}
                  className="px-3 py-2 text-right whitespace-nowrap normal-case font-medium text-gray-700 text-xs tracking-normal"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar
                      name={meta.name}
                      mine={false}
                      imageUrl={meta.avatar_url}
                    />
                    <span>{meta.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.rowsSorted.map((rk) => {
              const ks = stats.keyFor(rk);
              const row = stats.counts.get(ks)!;
              const mm = stats.minMaxByRow.get(ks)!;
              return (
                <tr key={ks} className="border-b">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex flex-col leading-tight">
                      <span>{rk.slot_name}</span>
                      {rk.team_role_label && (
                        <span className="text-[10px] font-normal text-gray-500">
                          {rk.team_role_label}
                        </span>
                      )}
                    </span>
                  </td>
                  {stats.personsSorted.map(([pid]) => {
                    const v = row.get(pid) ?? 0;
                    return (
                      <td
                        key={pid}
                        className={
                          "px-3 py-2 text-right "
                          + cellClass(v, mm.min, mm.max, mm.min !== mm.max)
                        }
                      >
                        {v || "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-b bg-gray-50">
              <td
                className="px-3 py-2 font-medium whitespace-nowrap"
                title="Asignaciones en sábado, domingo o festivo"
              >
                Fines de semana / festivos
              </td>
              {stats.personsSorted.map(([pid]) => {
                const v = stats.weByPerson.get(pid) ?? 0;
                return (
                  <td
                    key={pid}
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        v,
                        stats.weMin,
                        stats.weMax,
                        stats.weMin !== stats.weMax,
                      )
                    }
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
            <tr className="bg-gray-50 font-medium">
              <td className="px-3 py-2">Total</td>
              {stats.personsSorted.map(([pid]) => {
                const v = stats.totalByPerson.get(pid) ?? 0;
                return (
                  <td
                    key={pid}
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        v,
                        stats.totalMin,
                        stats.totalMax,
                        stats.totalMin !== stats.totalMax,
                      )
                    }
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </Card>
      <p className="mt-2 text-[11px] text-gray-500">
        <span className="text-rose-700">Rojo</span>: máximo de la fila ·{" "}
        <span className="text-emerald-700">verde</span>: mínimo. Diferencias
        grandes indican desbalance.
      </p>
    </div>
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
                label: m.person_name,
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


function NotifyConfirmModal({
  title,
  description,
  confirmLabel,
  notifyLabel,
  onConfirm,
  onClose,
  isPending,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  notifyLabel: string;
  onConfirm: (notifyMembers: boolean) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  // Default ON — admins who want to silence the email actively
  // untick the box. Matches the existing reopen/republish behavior
  // before this opt-out was added.
  const [notify, setNotify] = useState(true);
  return (
    <Modal open={true} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">{description}</p>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="mt-0.5"
          />
          <span>{notifyLabel}</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancelar
          </Button>
          <Button
            onClick={() => onConfirm(notify)}
            disabled={isPending}
          >
            {isPending ? "Guardando…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

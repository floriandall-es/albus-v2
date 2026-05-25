"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  personLastName,
  type Assignment,
  type Slot,
  type TeamAbsence,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
} from "@/components/admin/ui";
import { GroupLibreRow } from "@/components/schedule/group-libre-row";
import { MONTH_LONG_ES, WEEKDAY_LONG_ES } from "@/lib/dates";

/**
 * Sub-team lead's planning grid. One Schedule per (tenant, month),
 * created by the tenant admin's solver run. Group slots get no
 * assignments from the solver (it skips group_id != NULL), so the
 * lead creates rows from scratch via POST /api/schedules/{id}
 * /assignments and edits them via PATCH/DELETE — all scoped
 * server-side to their group.
 *
 * UI: month picker → list of group's activities × day cells →
 * click cell to assign one of the group's members.
 *
 * If no Schedule exists yet for the picked month (tenant admin
 * hasn't run "Generar nueva"), the lead sees an empty-state
 * pointing them at that dependency. v1 doesn't let leads create
 * empty Schedules unilaterally — keeps the model simple at the
 * cost of one round-trip on the admin's side.
 */

export default function LeadPlanificacionPage() {
  const today = new Date();
  const [period, setPeriod] = useState<string>(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`,
  );

  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });

  // Find the schedule whose period matches the selected month.
  const schedule = useMemo(
    () =>
      schedules.data?.find((s) => s.period.slice(0, 7) === period.slice(0, 7))
      ?? null,
    [schedules.data, period],
  );

  const slots = useQuery({ queryKey: ["slots"], queryFn: () => api.listSlots() });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const detail = useQuery({
    queryKey: ["schedule", schedule?.id],
    queryFn: () => api.getSchedule(schedule!.id),
    enabled: !!schedule,
  });
  const myGroupId = me.data?.lead_group_id ?? null;

  // Group-scoped Libre row. team-absences returns every approved
  // absence in the tenant; we filter to this group's members on
  // the client by intersecting with the team list's group_id.
  const monthStart = period.slice(0, 8) + "01";
  const monthEnd = useMemo(() => {
    const [yy, mm] = period.split("-").map(Number);
    const last = new Date(yy, mm, 0).getDate();
    return `${yy}-${String(mm).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  }, [period]);
  const absences = useQuery({
    queryKey: ["team-absences", monthStart, monthEnd],
    queryFn: () =>
      api.listTeamAbsences({ from: monthStart, to: monthEnd }),
  });
  const groupAbsences = useMemo<TeamAbsence[]>(() => {
    if (!absences.data || !team.data || myGroupId === null) return [];
    const groupPersonIds = new Set(
      team.data
        .filter((m) => m.group_id === myGroupId)
        .map((m) => m.person_id),
    );
    return absences.data.filter((a) => groupPersonIds.has(a.person_id));
  }, [absences.data, team.data, myGroupId]);
  const isPublishedForGroup =
    schedule && myGroupId
      ? schedule.published_group_ids.includes(myGroupId)
      : false;

  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: () =>
      api.publishGroupSchedule(schedule!.id, myGroupId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["schedule", schedule!.id] });
    },
  });
  const unpublish = useMutation({
    mutationFn: () =>
      api.unpublishGroupSchedule(schedule!.id, myGroupId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      qc.invalidateQueries({ queryKey: ["schedule", schedule!.id] });
    },
  });
  const downloadPdf = useMutation({
    mutationFn: () =>
      api.downloadGroupSchedulePdf(schedule!.id, myGroupId!),
  });

  return (
    <>
      <PageHeader title="Planificación" />
      <Card>
        <div className="p-4 flex items-end gap-3 flex-wrap justify-between">
          <MonthYearPicker value={period} onChange={setPeriod} />
          {schedule && myGroupId && (
            <div className="flex items-center gap-2">
              <span
                className={
                  "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide "
                  + (isPublishedForGroup
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-800")
                }
              >
                {isPublishedForGroup ? "Publicada" : "Borrador"}
              </span>
              {isPublishedForGroup ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (
                      confirm(
                        "Al despublicar, tu sub-equipo dejará de ver esta planificación hasta que la vuelvas a publicar. ¿Continuar?",
                      )
                    ) {
                      unpublish.mutate();
                    }
                  }}
                  disabled={unpublish.isPending}
                >
                  Despublicar
                </Button>
              ) : (
                <Button
                  onClick={() => publish.mutate()}
                  disabled={publish.isPending}
                >
                  {publish.isPending ? "Publicando…" : "Publicar"}
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
          )}
        </div>
        {schedule && myGroupId && (
          <div className="px-4 pb-3 text-xs text-gray-500">
            {isPublishedForGroup
              ? "Tu sub-equipo ya puede ver esta planificación en \"Mis turnos\". Para hacer cambios, despublica primero."
              : "Solo tú la ves. Cuando publiques, tu sub-equipo la verá en \"Mis turnos\"."}
          </div>
        )}
      </Card>

      <div className="mt-6">
        {schedules.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
        {schedules.data && !schedule && (
          <Empty>
            El administrador todavía no ha generado la planificación de este
            mes. Cuando lo haga, podrás organizar a tu sub-equipo aquí.
          </Empty>
        )}
        {schedule && detail.data && slots.data && team.data && (
          <PlanningGrid
            scheduleId={schedule.id}
            period={schedule.period}
            slots={slots.data}
            team={team.data}
            assignments={detail.data.assignments}
            absences={groupAbsences}
            readOnly={isPublishedForGroup}
          />
        )}
      </div>
    </>
  );
}

function MonthYearPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // value is "YYYY-MM-01" — extract bits, render two selects.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const today = new Date();
  // Window: current year ± 1.
  const years = [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1];
  const set = (y: number, m: number) =>
    onChange(`${y}-${String(m).padStart(2, "0")}-01`);
  return (
    <div className="flex gap-2 items-end">
      <Select
        label="Mes"
        value={month}
        onChange={(v) => v !== "" && set(year, Number(v))}
        options={MONTH_LONG_ES.map((label, idx) => ({
          value: idx + 1,
          label: label.charAt(0).toUpperCase() + label.slice(1),
        }))}
      />
      <Select
        label="Año"
        value={year}
        onChange={(v) => v !== "" && set(Number(v), month)}
        options={years.map((y) => ({ value: y, label: String(y) }))}
      />
    </div>
  );
}

function PlanningGrid({
  scheduleId,
  period,
  slots,
  team,
  assignments,
  absences,
  readOnly,
}: {
  scheduleId: number;
  period: string;
  slots: Slot[];
  team: TeamMember[];
  assignments: Assignment[];
  absences: TeamAbsence[];
  /** When true (= the schedule is already published for the
   * lead's group) cells become non-clickable. Edits should
   * go through "Despublicar → editar → Publicar" rather than
   * silently mutating what residentes already see. */
  readOnly: boolean;
}) {
  // Days in the month.
  const [yy, mm] = period.split("-").map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  const days = Array.from({ length: lastDay }, (_, i) => i + 1);

  // Sort slots by position so the grid order matches the list order.
  const sortedSlots = useMemo(
    () =>
      [...slots].sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.name.localeCompare(b.name, "es");
      }),
    [slots],
  );

  // Index assignments by (slot_id, date) for O(1) cell lookup.
  // Date string format is YYYY-MM-DD; we build the day key from
  // (slot, day-number) on render.
  const byCell = useMemo(() => {
    const m = new Map<string, Assignment>();
    for (const a of assignments) {
      m.set(`${a.slot_id}_${a.date}`, a);
    }
    return m;
  }, [assignments]);

  const [editing, setEditing] = useState<{
    slot: Slot;
    date: string;
    existing: Assignment | null;
  } | null>(null);

  return (
    <>
      <div className="rounded-xl border border-gray-200 bg-white shadow-soft overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 border-r border-gray-200 px-3 py-2 text-left font-semibold uppercase tracking-wide text-gray-500">
                Actividad
              </th>
              {days.map((d) => {
                const dt = new Date(yy, mm - 1, d);
                const dow = WEEKDAY_LONG_ES[dt.getDay()].charAt(0).toUpperCase();
                const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
                return (
                  <th
                    key={d}
                    className={
                      "px-2 py-2 text-center font-medium border-r border-gray-100 last:border-r-0 "
                      + (isWeekend ? "bg-gray-100/60 text-gray-700" : "text-gray-500")
                    }
                  >
                    <div className="text-[10px] uppercase">{dow}</div>
                    <div className="text-sm font-semibold text-gray-900">{d}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedSlots.length === 0 && (
              <tr>
                <td
                  colSpan={days.length + 1}
                  className="px-4 py-6 text-center text-sm text-gray-500"
                >
                  Aún no hay actividades. Crea la primera en{" "}
                  <strong>Actividades</strong>.
                </td>
              </tr>
            )}
            {sortedSlots.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 last:border-b-0">
                <td className="sticky left-0 z-10 bg-white border-r border-gray-200 px-3 py-2 align-middle">
                  <div className="font-medium text-gray-900">{s.name}</div>
                  {s.start_time && s.end_time && (
                    <div className="text-[10px] text-gray-500">
                      {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                    </div>
                  )}
                </td>
                {days.map((d) => {
                  const dateStr = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                  const existing = byCell.get(`${s.id}_${dateStr}`) ?? null;
                  // Use last name to match the read-only grids on
                  // /me/turnos and /me/sub-equipos — first-name-only
                  // was an early-prototype shorthand that drifted.
                  const personLabel = existing?.person_name
                    ? personLastName({
                        name: existing.person_name,
                        last_name: existing.person_last_name,
                      })
                    : "";
                  // Once the plan is published-for-group the lead
                  // has to despublicar before editing — backend
                  // returns 400 otherwise. Render the cell as a
                  // non-interactive div so the lead doesn't see
                  // a hover state implying it's clickable.
                  const cellContent =
                    existing && existing.person_id
                      ? personLabel || existing.person_name
                      : "—";
                  const cellTone =
                    existing && existing.person_id
                      ? "bg-brand-50 text-brand-900"
                      : "text-gray-400";
                  return (
                    <td
                      key={d}
                      className="border-r border-gray-100 last:border-r-0 p-0"
                    >
                      {readOnly ? (
                        <div
                          className={
                            "flex h-10 w-full items-center justify-center px-1 text-center text-[11px] "
                            + cellTone
                          }
                        >
                          {cellContent}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({ slot: s, date: dateStr, existing })
                          }
                          className={
                            "w-full h-10 px-1 text-center text-[11px] transition-colors "
                            + (existing && existing.person_id
                              ? "bg-brand-50 text-brand-900 hover:bg-brand-100"
                              : "text-gray-400 hover:bg-gray-50")
                          }
                        >
                          {cellContent}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <GroupLibreRow
              yy={yy}
              mm={mm}
              days={days}
              absences={absences}
            />
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        {readOnly
          ? "Vista de solo lectura — la planificación está publicada. Pulsa Despublicar arriba para volver a editar."
          : "Haz click en una celda para asignar o cambiar a la persona del turno."}
      </p>

      {editing && (
        <AssignDialog
          scheduleId={scheduleId}
          slot={editing.slot}
          date={editing.date}
          existing={editing.existing}
          team={team}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function AssignDialog({
  scheduleId,
  slot,
  date,
  existing,
  team,
  onClose,
}: {
  scheduleId: number;
  slot: Slot;
  date: string;
  existing: Assignment | null;
  team: TeamMember[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [personId, setPersonId] = useState<number | "">(
    existing?.person_id ?? "",
  );

  const activeTeam = team.filter((m) => !m.disabled_at);

  const save = useMutation({
    mutationFn: async () => {
      const target = personId === "" ? null : Number(personId);
      if (existing) {
        if (target === null) {
          return api.patchAssignment(scheduleId, existing.id, {
            clear_person: true,
          });
        }
        return api.patchAssignment(scheduleId, existing.id, {
          person_id: target,
        });
      }
      return api.createAssignment(scheduleId, {
        slot_id: slot.id,
        date,
        person_id: target,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", scheduleId] });
      onClose();
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteAssignment(scheduleId, existing!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", scheduleId] });
      onClose();
    },
  });

  // Pretty date for the modal title.
  const [yy, mm, dd] = date.split("-").map(Number);
  const dt = new Date(yy, mm - 1, dd);
  const weekday = WEEKDAY_LONG_ES[dt.getDay()];
  const longDate = `${weekday.charAt(0).toUpperCase() + weekday.slice(1)} ${dd} ${MONTH_LONG_ES[mm - 1]}`;

  return (
    <Modal open={true} onClose={onClose} title={`${slot.name} — ${longDate}`}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select
          label="Persona asignada"
          value={personId}
          onChange={(v) => setPersonId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "— Sin asignar —" },
            // Same last-name-only convention the planning grid
            // cells use. TeamMember doesn't carry person_last_name
            // explicitly, so personLastName falls back to splitting
            // person_name by whitespace — fine for "Jose Doménech"
            // / "Mara Gascón" / "H. Tovar".
            ...activeTeam.map((m) => ({
              value: m.person_id,
              label: personLastName({
                name: m.person_name,
                last_name: null,
              }),
            })),
          ]}
        />
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}
        <div className="flex items-center justify-between pt-2">
          <div>
            {existing && (
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm("¿Eliminar esta asignación del día?")) {
                    del.mutate();
                  }
                }}
                disabled={del.isPending}
              >
                Eliminar asignación
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

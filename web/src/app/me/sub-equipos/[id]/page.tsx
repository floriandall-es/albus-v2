"use client";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  api,
  personLastName,
  type Assignment,
  type Slot,
  type TeamAbsence,
} from "@/lib/api";
import { Button, Card, Empty, PageHeader, Select } from "@/components/admin/ui";
import { GroupLibreRow } from "@/components/schedule/group-libre-row";
import { MONTH_LONG_ES, WEEKDAY_LONG_ES } from "@/lib/dates";

/**
 * Member-facing read-only view of a sub-team's published plan.
 * Same shape as /admin/groups/[id]/planificacion but the backend
 * only releases assignments to a plain member when the group
 * has published the plan for that schedule (drafts stay between
 * the lead and tenant admin).
 *
 * Visible to every signed-in member regardless of which group
 * they belong to — handy for an Adjunto who wants to know which
 * residente is on guardia tonight, or a residente checking how
 * other sub-teams are arranged.
 */
export default function MemberSubEquipoPage() {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);

  const groups = useQuery({ queryKey: ["groups"], queryFn: api.listGroups });
  const group = groups.data?.find((g) => g.id === groupId);

  const today = new Date();
  const [period, setPeriod] = useState<string>(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`,
  );

  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });
  const schedule = useMemo(
    () =>
      schedules.data?.find(
        (s) => s.period.slice(0, 7) === period.slice(0, 7),
      ) ?? null,
    [schedules.data, period],
  );

  const isPublishedForGroup =
    schedule?.published_group_ids?.includes(groupId) ?? false;

  const downloadPdf = useMutation({
    mutationFn: () => api.downloadGroupSchedulePdf(schedule!.id, groupId),
  });

  // We only call the schedule detail when the group is published
  // for this month — otherwise the backend would return 403 and
  // we'd surface a confusing error. The Empty state below covers
  // the not-yet-published case explicitly.
  const detail = useQuery({
    queryKey: ["schedule", schedule?.id, "group", groupId, "member"],
    queryFn: () => api.getSchedule(schedule!.id, { groupId }),
    enabled: !!schedule && isPublishedForGroup,
  });

  const slots = useQuery({ queryKey: ["slots"], queryFn: () => api.listSlots() });
  const groupSlots = useMemo(
    () => (slots.data ?? []).filter((s) => s.group_id === groupId),
    [slots.data, groupId],
  );

  // Sub-equipo absences for the displayed month. Same join
  // pattern the lead view uses: team-absences (all tenant) ∩
  // team members in this group.
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
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
    if (!absences.data || !team.data) return [];
    const groupPersonIds = new Set(
      team.data
        .filter((m) => m.group_id === groupId)
        .map((m) => m.person_id),
    );
    return absences.data.filter((a) => groupPersonIds.has(a.person_id));
  }, [absences.data, team.data, groupId]);

  return (
    <>
      <PageHeader title={group?.name ?? "Sub-equipo"} />
      {group?.lead_name && (
        <p className="-mt-4 mb-6 text-sm text-gray-600">
          Coordinado por <span className="font-medium">{group.lead_name}</span>.
        </p>
      )}

      <Card>
        <div className="p-4 flex items-end gap-3 flex-wrap justify-between">
          <MonthYearPicker value={period} onChange={setPeriod} />
          {schedule && isPublishedForGroup && (
            <Button
              variant="secondary"
              onClick={() => downloadPdf.mutate()}
              disabled={downloadPdf.isPending}
            >
              {downloadPdf.isPending ? "Generando PDF…" : "Descargar PDF"}
            </Button>
          )}
        </div>
      </Card>

      <div className="mt-6">
        {schedules.isLoading && (
          <p className="text-sm text-gray-500">Cargando…</p>
        )}
        {schedules.data && !schedule && (
          <Empty>
            No hay planificación para este mes todavía.
          </Empty>
        )}
        {schedule && !isPublishedForGroup && (
          <Empty>
            La planificación de {group?.name ?? "este sub-equipo"} para este
            mes aún no está publicada. Cuando el responsable la publique,
            la verás aquí.
          </Empty>
        )}
        {schedule && isPublishedForGroup && detail.data && groupSlots && (
          <ReadOnlyGrid
            period={schedule.period}
            slots={groupSlots}
            assignments={detail.data.assignments}
            absences={groupAbsences}
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
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const today = new Date();
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

function ReadOnlyGrid({
  period,
  slots,
  assignments,
  absences,
}: {
  period: string;
  slots: Slot[];
  assignments: Assignment[];
  absences: TeamAbsence[];
}) {
  const [yy, mm] = period.split("-").map(Number);
  const lastDay = new Date(yy, mm, 0).getDate();
  const days = Array.from({ length: lastDay }, (_, i) => i + 1);

  const sortedSlots = useMemo(
    () =>
      [...slots].sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.name.localeCompare(b.name, "es");
      }),
    [slots],
  );

  const byCell = useMemo(() => {
    const m = new Map<string, Assignment>();
    for (const a of assignments) {
      m.set(`${a.slot_id}_${a.date}`, a);
    }
    return m;
  }, [assignments]);

  return (
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
                    + (isWeekend
                      ? "bg-gray-100/60 text-gray-700"
                      : "text-gray-500")
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
                Este sub-equipo aún no tiene actividades definidas.
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
                // Last name to match the sibling planning views
                // (/me/turnos + the main team grid).
                const personLabel = existing?.person_name
                  ? personLastName({
                      name: existing.person_name,
                      last_name: existing.person_last_name,
                    })
                  : "";
                return (
                  <td
                    key={d}
                    className="border-r border-gray-100 last:border-r-0 p-0"
                  >
                    <div
                      className={
                        "w-full h-10 px-1 text-center text-[11px] flex items-center justify-center "
                        + (existing && existing.person_id
                          ? "bg-brand-50 text-brand-900"
                          : "text-gray-400")
                      }
                    >
                      {existing && existing.person_id
                        ? personLabel || existing.person_name
                        : "—"}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
          <GroupLibreRow yy={yy} mm={mm} days={days} absences={absences} />
        </tbody>
      </table>
    </div>
  );
}

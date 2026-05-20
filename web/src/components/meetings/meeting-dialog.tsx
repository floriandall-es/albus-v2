"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Group,
  type Meeting,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  ErrorText,
  Modal,
  Select,
  TextField,
} from "@/components/admin/ui";

/**
 * Create / edit dialog for both regular (weekly) and ad-hoc (one-off)
 * meetings. Used by /admin/reuniones (full power: regular + ad-hoc)
 * and by /me/reuniones (ad-hoc only — see `lockedKind`).
 *
 * Audience is the union of three sources, all editable from the
 * same form:
 *   - "Todo el equipo principal" checkbox (include_main_team)
 *   - Sub-equipo checkboxes (group_ids)
 *   - Per-person picker (person_ids)
 * The backend validates that at least one of the three is non-empty.
 */
export function MeetingDialog({
  initial,
  defaultKind,
  lockedKind,
  onClose,
}: {
  initial: Meeting | null;
  /** Default kind for a new meeting. Ignored when editing. */
  defaultKind: "regular" | "ad_hoc";
  /** When set, the kind toggle is hidden and forced to this value
   * (e.g., /me/reuniones only creates ad-hoc). */
  lockedKind?: "regular" | "ad_hoc";
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.listGroups });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  const initialKind = initial?.kind ?? defaultKind;
  const [kind, setKind] = useState<"regular" | "ad_hoc">(initialKind);

  const today = new Date();
  const todayIsoStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const [title, setTitle] = useState<string>(initial?.title ?? "");
  const [description, setDescription] = useState<string>(
    initial?.description ?? "",
  );
  const [location, setLocation] = useState<string>(initial?.location ?? "");
  const [date, setDate] = useState<string>(initial?.date ?? todayIsoStr);
  // Weekday: 0=Monday..6=Sunday. Default to today's weekday for fresh
  // forms — most admins are creating "every Tuesday" while opening the
  // form on Tuesday morning, so this matches intent more often than
  // not. JS getDay() is Sun=0..Sat=6, so we shift it.
  const jsDayToPy = (d: number) => (d + 6) % 7;
  const [weekday, setWeekday] = useState<number>(
    initial?.weekday ?? jsDayToPy(today.getDay()),
  );
  const [startTime, setStartTime] = useState<string>(
    (initial?.start_time ?? "10:00:00").slice(0, 5),
  );
  const [endTime, setEndTime] = useState<string>(
    (initial?.end_time ?? "11:00:00").slice(0, 5),
  );

  const [includeMainTeam, setIncludeMainTeam] = useState<boolean>(
    initial?.audience.include_main_team ?? false,
  );
  const [groupIds, setGroupIds] = useState<Set<number>>(
    new Set(initial?.audience.group_ids ?? []),
  );
  const [personIds, setPersonIds] = useState<Set<number>>(
    new Set(initial?.audience.person_ids ?? []),
  );

  // Person picker UI state — search query + the selected name pool
  // is derived from team list. Filtered client-side because tenants
  // are <100 members and a server-search round-trip would feel slower.
  const [personQuery, setPersonQuery] = useState<string>("");
  const filteredTeam = useMemo(() => {
    if (!team.data) return [] as TeamMember[];
    const q = personQuery.trim().toLowerCase();
    if (!q) return team.data;
    return team.data.filter(
      (m) =>
        m.person_name.toLowerCase().includes(q)
        || (m.person_email ?? "").toLowerCase().includes(q),
    );
  }, [team.data, personQuery]);

  const togglePerson = (id: number) =>
    setPersonIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleGroup = (id: number) =>
    setGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const audienceEmpty =
    !includeMainTeam && groupIds.size === 0 && personIds.size === 0;

  const save = useMutation({
    mutationFn: () => {
      const audience = {
        include_main_team: includeMainTeam,
        group_ids: Array.from(groupIds),
        person_ids: Array.from(personIds),
      };
      const common = {
        title: title.trim(),
        description: description.trim() || null,
        location: location.trim() || null,
        start_time: `${startTime}:00`,
        end_time: `${endTime}:00`,
        ...audience,
      };
      if (kind === "regular") {
        const body = { ...common, weekday };
        return initial
          ? api.updateRegularMeeting(initial.id, body)
          : api.createRegularMeeting(body);
      }
      const body = { ...common, date };
      return initial
        ? api.updateAdHocMeeting(initial.id, body)
        : api.createAdHocMeeting(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings"] });
      qc.invalidateQueries({ queryKey: ["meeting-instances"] });
      onClose();
    },
  });

  // Selected-person name lookup so the chip list reads "María García"
  // not "Person 42" while team.data is loading or stale.
  const teamById = useMemo(() => {
    const m = new Map<number, TeamMember>();
    for (const t of team.data ?? []) m.set(t.person_id, t);
    return m;
  }, [team.data]);

  const showKindToggle = !lockedKind && !initial;

  // The save button is enabled iff the form is minimally valid.
  // Backend re-validates, but this keeps the UX honest.
  const canSave =
    !!title.trim()
    && !!startTime
    && !!endTime
    && endTime > startTime
    && (kind === "regular" || !!date)
    && !audienceEmpty;

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar reunión" : "Nueva reunión"}
      size="lg"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        {showKindToggle && (
          <div className="flex gap-2 rounded-lg bg-gray-100 p-1 w-fit">
            <button
              type="button"
              onClick={() => setKind("regular")}
              className={
                "px-3 py-1 text-sm rounded-md transition-colors "
                + (kind === "regular"
                  ? "bg-white shadow-sm text-gray-900 font-medium"
                  : "text-gray-600 hover:text-gray-900")
              }
            >
              Semanal
            </button>
            <button
              type="button"
              onClick={() => setKind("ad_hoc")}
              className={
                "px-3 py-1 text-sm rounded-md transition-colors "
                + (kind === "ad_hoc"
                  ? "bg-white shadow-sm text-gray-900 font-medium"
                  : "text-gray-600 hover:text-gray-900")
              }
            >
              Puntual
            </button>
          </div>
        )}

        <TextField
          label="Título"
          value={title}
          onChange={setTitle}
          placeholder="Ej. Sesión clínica"
          required
        />
        <div>
          <span className="text-sm font-medium text-gray-700">
            Descripción (opcional)
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Temas, orden del día…"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <TextField
          label="Ubicación (opcional)"
          value={location}
          onChange={setLocation}
          placeholder="Ej. Sala de sesiones"
        />

        <div className="grid grid-cols-2 gap-3">
          {kind === "regular" ? (
            <Select
              label="Día de la semana"
              value={weekday}
              onChange={(v) => v !== "" && setWeekday(Number(v))}
              options={WEEKDAY_OPTIONS}
            />
          ) : (
            <TextField
              label="Fecha"
              type="date"
              value={date}
              onChange={setDate}
              required
            />
          )}
          <div className="grid grid-cols-2 gap-2">
            <TextField
              label="Inicio"
              type="time"
              value={startTime}
              onChange={setStartTime}
              required
            />
            <TextField
              label="Fin"
              type="time"
              value={endTime}
              onChange={setEndTime}
              required
            />
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 p-3 space-y-3">
          <div className="text-sm font-medium text-gray-700">
            Audiencia
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeMainTeam}
              onChange={(e) => setIncludeMainTeam(e.target.checked)}
            />
            Todo el equipo principal
          </label>

          {groups.data && groups.data.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">Sub-equipos</div>
              <div className="space-y-1">
                {groups.data.map((g: Group) => (
                  <label
                    key={g.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={groupIds.has(g.id)}
                      onChange={() => toggleGroup(g.id)}
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs text-gray-500 mb-1">Personas concretas</div>
            <input
              type="text"
              value={personQuery}
              onChange={(e) => setPersonQuery(e.target.value)}
              placeholder="Buscar por nombre o email…"
              className="block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm mb-2"
            />
            <div className="max-h-40 overflow-y-auto rounded-md border border-gray-200">
              {filteredTeam.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-500">
                  Sin resultados.
                </div>
              )}
              {filteredTeam.map((m) => (
                <label
                  key={m.person_id}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={personIds.has(m.person_id)}
                    onChange={() => togglePerson(m.person_id)}
                  />
                  <span className="flex-1 truncate">{m.person_name}</span>
                  {m.person_email && (
                    <span className="text-[11px] text-gray-400 truncate">
                      {m.person_email}
                    </span>
                  )}
                </label>
              ))}
            </div>
            {personIds.size > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Array.from(personIds).map((pid) => {
                  const m = teamById.get(pid);
                  return (
                    <span
                      key={pid}
                      className="inline-flex items-center gap-1 rounded-full bg-brand-50 text-brand-800 text-[11px] px-2 py-0.5"
                    >
                      {m?.person_name ?? `#${pid}`}
                      <button
                        type="button"
                        onClick={() => togglePerson(pid)}
                        className="text-brand-700 hover:text-brand-900"
                        aria-label="Quitar"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          {audienceEmpty && (
            <p className="text-xs text-amber-700">
              Selecciona al menos un grupo o persona.
            </p>
          )}
        </div>

        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending || !canSave}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// 0=Mon..6=Sun matches the backend's stored weekday. Labels in
// Spanish, capitalised for the form.
const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Lunes" },
  { value: 1, label: "Martes" },
  { value: 2, label: "Miércoles" },
  { value: 3, label: "Jueves" },
  { value: 4, label: "Viernes" },
  { value: 5, label: "Sábado" },
  { value: 6, label: "Domingo" },
];

// Re-used by the list pages to format the weekday for regular meetings.
export const WEEKDAY_LABELS_ES = WEEKDAY_OPTIONS.map((o) => o.label);

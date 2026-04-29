"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Category,
  type DaysApplied,
  type Skill,
  type SkillStrength,
  type Slot,
  type SlotInput,
  type StaffingMode,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  TextField,
} from "@/components/admin/ui";

const DAYS: { value: DaysApplied; label: string }[] = [
  { value: "all", label: "Todos los días" },
  { value: "weekdays", label: "Días laborables" },
  { value: "weekends_holidays", label: "Fines de semana / festivos" },
  { value: "custom", label: "Personalizado" },
];

const STAFFING: { value: StaffingMode; label: string }[] = [
  { value: "single", label: "Una persona" },
  { value: "multiple_same", label: "Varias del mismo perfil" },
  { value: "team_composition", label: "Equipo (varios roles)" },
];

export default function SlotsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.listSkills });
  const [editing, setEditing] = useState<Slot | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteSlot(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slots"] }),
  });

  return (
    <>
      <PageHeader
        title="Slots"
        action={<Button onClick={() => setEditing("new")}>Nuevo slot</Button>}
      />
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay slots.</Empty>}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Horario</th>
                <th className="px-4 py-2 font-medium">Días</th>
                <th className="px-4 py-2 font-medium">Modo</th>
                <th className="px-4 py-2 font-medium">Plazas</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{s.name}</td>
                  <td className="px-4 py-2">
                    {s.start_time && s.end_time
                      ? `${s.start_time}–${s.end_time}${s.crosses_midnight ? " (+1d)" : ""}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{s.days_applied}</td>
                  <td className="px-4 py-2 text-gray-600">{s.staffing_mode}</td>
                  <td className="px-4 py-2">{s.headcount}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button variant="secondary" onClick={() => setEditing(s)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (confirm(`¿Eliminar slot "${s.name}"?`)) del.mutate(s.id);
                      }}
                    >
                      Eliminar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {editing && (
        <SlotDialog
          initial={editing === "new" ? null : editing}
          categories={cats.data ?? []}
          skills={skills.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

type TeamRoleDraft = { role_label: string; headcount: number; category_ids: number[] };
type SkillDraft = { skill_id: number; strength: SkillStrength };

function SlotDialog({
  initial,
  categories,
  skills,
  onClose,
}: {
  initial: Slot | null;
  categories: Category[];
  skills: Skill[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [startTime, setStartTime] = useState(initial?.start_time?.slice(0, 5) ?? "");
  const [endTime, setEndTime] = useState(initial?.end_time?.slice(0, 5) ?? "");
  const [days, setDays] = useState<DaysApplied>(initial?.days_applied ?? "all");
  const [mode, setMode] = useState<StaffingMode>(initial?.staffing_mode ?? "single");
  const [headcount, setHeadcount] = useState<string>(
    initial?.headcount?.toString() ?? "1",
  );
  const [postRest, setPostRest] = useState<boolean>(initial?.post_slot_rest ?? false);
  const [countsEquity, setCountsEquity] = useState<boolean>(
    initial?.counts_for_equity ?? true,
  );
  const [teamRoles, setTeamRoles] = useState<TeamRoleDraft[]>(
    initial?.team_roles.map((r) => ({
      role_label: r.role_label,
      headcount: r.headcount,
      category_ids: r.category_ids,
    })) ?? [],
  );
  const [skillsRequired, setSkillsRequired] = useState<SkillDraft[]>(
    initial?.skills_required.map((s) => ({
      skill_id: s.skill_id,
      strength: s.strength,
    })) ?? [],
  );

  const save = useMutation({
    mutationFn: () => {
      const body: SlotInput = {
        name,
        days_applied: days,
        staffing_mode: mode,
        headcount: Number(headcount),
        post_slot_rest: postRest,
        counts_for_equity: countsEquity,
        start_time: startTime ? `${startTime}:00` : null,
        end_time: endTime ? `${endTime}:00` : null,
        team_roles: mode === "team_composition" ? teamRoles : [],
        skills_required: skillsRequired,
      };
      return initial ? api.updateSlot(initial.id, body) : api.createSlot(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      onClose();
    },
  });

  function addTeamRole() {
    setTeamRoles((cur) => [
      ...cur,
      { role_label: "", headcount: 1, category_ids: [] },
    ]);
  }
  function updateTeamRole(i: number, patch: Partial<TeamRoleDraft>) {
    setTeamRoles((cur) => cur.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeTeamRole(i: number) {
    setTeamRoles((cur) => cur.filter((_, idx) => idx !== i));
  }
  function toggleCategory(i: number, cid: number) {
    setTeamRoles((cur) =>
      cur.map((r, idx) =>
        idx === i
          ? {
              ...r,
              category_ids: r.category_ids.includes(cid)
                ? r.category_ids.filter((x) => x !== cid)
                : [...r.category_ids, cid],
            }
          : r,
      ),
    );
  }

  function addSkill() {
    const used = new Set(skillsRequired.map((s) => s.skill_id));
    const next = skills.find((s) => !used.has(s.id));
    if (next) setSkillsRequired((cur) => [...cur, { skill_id: next.id, strength: "hard" }]);
  }
  function updateSkill(i: number, patch: Partial<SkillDraft>) {
    setSkillsRequired((cur) =>
      cur.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }
  function removeSkill(i: number) {
    setSkillsRequired((cur) => cur.filter((_, idx) => idx !== i));
  }

  return (
    <Modal open={true} onClose={onClose} title={initial ? "Editar slot" : "Nuevo slot"}>
      <form
        className="space-y-3 max-h-[70vh] overflow-y-auto pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Nombre" value={name} onChange={setName} required />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Hora inicio" type="time" value={startTime} onChange={setStartTime} />
          <TextField label="Hora fin" type="time" value={endTime} onChange={setEndTime} />
        </div>
        <Select
          label="Días aplicados"
          value={days}
          onChange={(v) => v && setDays(v as DaysApplied)}
          options={DAYS.map((d) => ({ value: d.value, label: d.label }))}
        />
        <Select
          label="Modo de plantilla"
          value={mode}
          onChange={(v) => v && setMode(v as StaffingMode)}
          options={STAFFING.map((s) => ({ value: s.value, label: s.label }))}
        />
        <TextField label="Plazas" type="number" value={headcount} onChange={setHeadcount} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={postRest}
            onChange={(e) => setPostRest(e.target.checked)}
          />
          Genera descanso post-guardia
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={countsEquity}
            onChange={(e) => setCountsEquity(e.target.checked)}
          />
          Cuenta para equidad
        </label>

        {mode === "team_composition" && (
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Roles del equipo</h3>
              <Button variant="secondary" onClick={addTeamRole}>
                + Añadir rol
              </Button>
            </div>
            {teamRoles.length === 0 && (
              <p className="text-xs text-gray-500">Sin roles. Añade al menos uno.</p>
            )}
            {teamRoles.map((r, i) => (
              <div
                key={i}
                className="rounded-md border bg-gray-50 p-2 mb-2 space-y-2"
              >
                <div className="grid grid-cols-[1fr_5rem_auto] gap-2 items-end">
                  <TextField
                    label="Etiqueta"
                    value={r.role_label}
                    onChange={(v) => updateTeamRole(i, { role_label: v })}
                  />
                  <TextField
                    label="Plazas"
                    type="number"
                    value={String(r.headcount)}
                    onChange={(v) => updateTeamRole(i, { headcount: Number(v) || 1 })}
                  />
                  <button
                    type="button"
                    onClick={() => removeTeamRole(i)}
                    className="text-xs text-red-700 hover:underline pb-2"
                  >
                    Quitar
                  </button>
                </div>
                <div>
                  <span className="text-xs font-medium text-gray-700">
                    Categorías que pueden cubrir este rol
                  </span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {categories.length === 0 && (
                      <span className="text-xs text-gray-500">
                        Crea categorías primero.
                      </span>
                    )}
                    {categories.map((c) => (
                      <label key={c.id} className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={r.category_ids.includes(c.id)}
                          onChange={() => toggleCategory(i, c.id)}
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Skills requeridas</h3>
            <Button variant="secondary" onClick={addSkill} disabled={skills.length === 0}>
              + Añadir skill
            </Button>
          </div>
          {skills.length === 0 && (
            <p className="text-xs text-gray-500">Crea skills primero.</p>
          )}
          {skillsRequired.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-2 items-end mb-2">
              <Select
                label="Skill"
                value={s.skill_id}
                onChange={(v) => v !== "" && updateSkill(i, { skill_id: Number(v) })}
                options={skills.map((sk) => ({ value: sk.id, label: sk.name }))}
              />
              <Select
                label="Fuerza"
                value={s.strength}
                onChange={(v) => v && updateSkill(i, { strength: v as SkillStrength })}
                options={[
                  { value: "hard", label: "Obligatoria" },
                  { value: "soft", label: "Preferida" },
                ]}
              />
              <button
                type="button"
                onClick={() => removeSkill(i)}
                className="text-xs text-red-700 hover:underline pb-2"
              >
                Quitar
              </button>
            </div>
          ))}
        </div>

        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-white">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

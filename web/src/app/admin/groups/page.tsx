"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Group, type TeamMember } from "@/lib/api";
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
import { SetupBanner } from "@/components/admin/SetupBanner";

/**
 * Manage sub-team groups. Tenant-admin only — group leads see a
 * filtered admin UI elsewhere but don't manage the groups
 * themselves.
 *
 * A group has:
 *   - a name (unique per tenant)
 *   - one designated lead (a Membership) who acts as group-scoped admin
 *   - N members (memberships.group_id points at the group)
 *
 * The list shows headcount + slot count per group so the admin
 * can sanity-check what's scoped to whom.
 */
export default function GroupsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["groups"], queryFn: api.listGroups });
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [managingMembers, setManagingMembers] = useState<Group | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteGroup(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["team"] });
      qc.invalidateQueries({ queryKey: ["slots"] });
    },
  });

  return (
    <>
      <PageHeader
        title="Sub-equipos"
        action={<Button onClick={() => setEditing("new")}>Nuevo sub-equipo</Button>}
      />
      <SetupBanner
        area="subteams"
        title="Sub-equipos con su propio responsable"
        description="Un sub-equipo (residentes, becarios, etc.) gestiona sus propias actividades y planificación sin mezclarse con el equipo principal. Crea uno, elige a un miembro como responsable, y se convertirá en administrador de ese sub-equipo."
      />

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && (
        <Empty>Aún no hay sub-equipos.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Responsable</th>
                <th className="px-4 py-2 font-medium">Miembros</th>
                <th className="px-4 py-2 font-medium">Actividades</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((g) => (
                <tr
                  key={g.id}
                  className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors"
                >
                  <td className="px-4 py-2 font-medium text-gray-900">
                    {g.name}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {g.lead_name ?? (
                      <span className="text-gray-400">— sin responsable —</span>
                    )}
                  </td>
                  <td className="px-4 py-2">{g.member_count}</td>
                  <td className="px-4 py-2">{g.slot_count}</td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Button
                      variant="secondary"
                      onClick={() => setManagingMembers(g)}
                    >
                      Miembros
                    </Button>
                    <Button variant="secondary" onClick={() => setEditing(g)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (
                          confirm(
                            `¿Eliminar el sub-equipo "${g.name}"?\n\n`
                              + `Las personas y actividades vuelven al equipo principal. `
                              + `No se borra ningún miembro ni actividad.`,
                          )
                        ) {
                          del.mutate(g.id);
                        }
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
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <GroupDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {managingMembers && (
        <ManageMembersDialog
          group={managingMembers}
          onClose={() => setManagingMembers(null)}
        />
      )}
    </>
  );
}

function GroupDialog({
  initial,
  onClose,
}: {
  initial: Group | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const [name, setName] = useState<string>(initial?.name ?? "");
  const [leadId, setLeadId] = useState<number | "">(
    initial?.lead_membership_id ?? "",
  );

  const save = useMutation({
    mutationFn: () => {
      if (initial) {
        return api.updateGroup(initial.id, {
          name,
          lead_membership_id: leadId === "" ? null : Number(leadId),
          clear_lead: leadId === "",
        });
      }
      return api.createGroup({
        name,
        lead_membership_id: leadId === "" ? null : Number(leadId),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["team"] });
      onClose();
    },
  });

  // Only active members can be picked as lead. We still allow the
  // currently-set lead (even if disabled) so editing an existing
  // group doesn't silently reset the field on open.
  const candidates = (team.data ?? []).filter(
    (m) => !m.disabled_at || m.id === initial?.lead_membership_id,
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar sub-equipo" : "Nuevo sub-equipo"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          placeholder="Ej. Residentes"
          required
        />
        <Select
          label="Responsable (admin del sub-equipo)"
          hint={
            <>
              Esta persona podrá editar las actividades y los miembros
              del sub-equipo. Puedes dejarlo sin asignar y elegirlo
              más tarde.
            </>
          }
          value={leadId}
          onChange={(v) => setLeadId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "— Sin responsable —" },
            ...candidates.map((m) => ({
              value: m.id,
              label: `${m.person_name}${m.category_name ? ` · ${m.category_name}` : ""}`,
            })),
          ]}
        />
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending || !name.trim()}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ManageMembersDialog({
  group,
  onClose,
}: {
  group: Group;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  // Initial selection: members currently in this group.
  const initiallySelected = useMemo(
    () =>
      new Set(
        (team.data ?? [])
          .filter((m) => m.group_id === group.id)
          .map((m) => m.id),
      ),
    [team.data, group.id],
  );
  const [selected, setSelected] = useState<Set<number>>(initiallySelected);
  const [hydrated, setHydrated] = useState(false);
  // Re-hydrate when team data finishes loading (modal open is sync,
  // team query may still be in flight on first render).
  if (!hydrated && team.data) {
    setSelected(new Set(initiallySelected));
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: () => api.replaceGroupMembers(group.id, Array.from(selected)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["team"] });
      onClose();
    },
  });

  const toggle = (id: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sorted: TeamMember[] = [...(team.data ?? [])].sort((a, b) =>
    a.person_name.localeCompare(b.person_name, "es"),
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Miembros — ${group.name}`}
      size="lg"
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          Marca los miembros que pertenecen a este sub-equipo. Los
          que ya estén en otro sub-equipo se moverán aquí. Los
          desactivados aparecen pero no pueden trabajar hasta que
          el responsable los reactive.
        </p>
        <ul className="rounded-md border bg-white divide-y divide-gray-100 max-h-72 overflow-y-auto">
          {sorted.map((m) => {
            const checked = selected.has(m.id);
            const elsewhere = m.group_id !== null && m.group_id !== group.id;
            return (
              <li key={m.id}>
                <label className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(m.id)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span className={m.disabled_at ? "text-gray-400" : "text-gray-900"}>
                    {m.person_name}
                  </span>
                  {m.category_name && (
                    <span className="text-xs text-gray-500">
                      · {m.category_name}
                    </span>
                  )}
                  {elsewhere && m.group_name && (
                    <span
                      className="ml-auto inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700"
                      title={`Actualmente en ${m.group_name}. Se moverá aquí si guardas.`}
                    >
                      {m.group_name}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
          {sorted.length === 0 && (
            <li className="px-3 py-2 text-xs text-gray-500">
              Aún no hay miembros en el equipo.
            </li>
          )}
        </ul>
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

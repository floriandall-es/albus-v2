"use client";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  personLastName,
  type Assignment,
  type TeamMember,
} from "@/lib/api";

/**
 * Modal launched when a member taps one of their own shifts (from
 * the /me Inicio cards or the /me/turnos list). Submits a swap
 * offer to the API and invalidates the swap-offers query so the
 * Cambios sidebar count refreshes.
 *
 * Audience picker (migration 0063): the requester chooses who
 * receives the request. Default = everyone in the requester's
 * own categoría (mirrors hospital convention — an "adjunto"
 * asking for guardia coverage normally wants other adjuntos to
 * see it, not the residentes). Header per categoría = toggle-all
 * for the group; individual checkboxes for finer control.
 */
export function RequestCoverageModal({
  assignment,
  onClose,
}: {
  assignment: Assignment;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  // The requester themselves should never be in the audience —
  // they can't respond to their own offer anyway, and including
  // them would just confuse the count + send them a "you have a
  // new request" email.
  const myMembershipId = useMemo(() => {
    if (!me.data) return null;
    const m = me.data.memberships.find(
      (mm) => mm.tenant_id === me.data!.current_tenant.id,
    );
    return m?.id ?? null;
  }, [me.data]);

  // Audience candidates: active main-team memberships of the tenant,
  // minus the requester. Sub-team swaps aren't supported yet (the
  // create_offer endpoint blocks group_id != NULL outright), so a
  // sub-team requester wouldn't even see this modal; but the
  // audience selection always excludes sub-team members too — they
  // can't accept a main-team swap.
  const audienceCandidates = useMemo(() => {
    if (!team.data) return [] as TeamMember[];
    return team.data.filter(
      (m) =>
        m.id !== myMembershipId
        && m.disabled_at === null
        && m.group_id === null,
    );
  }, [team.data, myMembershipId]);

  // Group candidates by categoría (with a "Sin categoría" bucket
  // for memberships whose admin hasn't assigned one yet).
  const SIN_CATEGORIA = -1;
  const grouped = useMemo(() => {
    const byCat = new Map<
      number,
      { key: number; name: string; members: TeamMember[] }
    >();
    for (const m of audienceCandidates) {
      const key = m.category_id ?? SIN_CATEGORIA;
      const existing = byCat.get(key);
      if (existing) {
        existing.members.push(m);
      } else {
        byCat.set(key, {
          key,
          name: m.category_name ?? "Sin categoría",
          members: [m],
        });
      }
    }
    const groups = Array.from(byCat.values());
    // Sort: requester's own categoría first, then alphabetical;
    // "Sin categoría" goes last.
    const myCatId = me.data?.memberships.find(
      (mm) => mm.tenant_id === me.data?.current_tenant.id,
    )?.category_id ?? null;
    groups.sort((a, b) => {
      if (a.key === myCatId && b.key !== myCatId) return -1;
      if (b.key === myCatId && a.key !== myCatId) return 1;
      if (a.key === SIN_CATEGORIA) return 1;
      if (b.key === SIN_CATEGORIA) return -1;
      return a.name.localeCompare(b.name, "es");
    });
    // Sort members within each group by last name.
    for (const g of groups) {
      g.members.sort((x, y) => {
        const xn = personLastName({
          name: x.person_name,
          last_name: null,
        });
        const yn = personLastName({
          name: y.person_name,
          last_name: null,
        });
        return xn.localeCompare(yn, "es");
      });
    }
    return groups;
  }, [audienceCandidates, me.data]);

  // Selected audience as a Set for O(1) toggle checks. We
  // initialise from `null` so we can tell "user hasn't seeded the
  // default yet" apart from "user actively unchecked everyone".
  const [selected, setSelected] = useState<Set<number> | null>(null);

  // Default-seed: once me + team have loaded, pre-check everyone
  // in the requester's own categoría. Only runs once per modal
  // open (the null guard).
  useEffect(() => {
    if (selected !== null) return;
    if (!me.data || !team.data) return;
    const myCatId = me.data.memberships.find(
      (mm) => mm.tenant_id === me.data!.current_tenant.id,
    )?.category_id ?? null;
    const seed = new Set<number>();
    for (const m of audienceCandidates) {
      if (m.category_id === myCatId) seed.add(m.id);
    }
    setSelected(seed);
  }, [me.data, team.data, audienceCandidates, selected]);

  const selectedCount = selected?.size ?? 0;

  const toggleMember = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleGroup = (members: TeamMember[]) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      const allSelected = members.every((m) => next.has(m.id));
      for (const m of members) {
        if (allSelected) next.delete(m.id);
        else next.add(m.id);
      }
      return next;
    });
  };

  const submit = useMutation({
    mutationFn: () =>
      api.createSwapOffer({
        assignment_id: assignment.id,
        notes: notes || null,
        audience_membership_ids:
          selected && selected.size > 0 ? [...selected] : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swap-offers"] });
      onClose();
    },
  });

  const wd = new Date(assignment.date).getUTCDay();
  const dayLabel = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd];
  const dateLabel = `${dayLabel} ${assignment.date.slice(8, 10)}/${assignment.date.slice(5, 7)}/${assignment.date.slice(0, 4)}`;

  const canSubmit =
    selectedCount > 0 && !submit.isPending && !me.isLoading && !team.isLoading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
          <h2 className="text-base font-semibold">Pedir cobertura</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3 overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) submit.mutate();
          }}
        >
          <div className="rounded-md bg-gray-50 p-3 text-sm">
            <div className="text-xs text-gray-500">Turno a cubrir</div>
            <div className="font-medium">
              {dateLabel} · {assignment.slot_name}
              {assignment.team_role_label && (
                <span className="text-gray-500">
                  {" "}· {assignment.team_role_label}
                </span>
              )}
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Nota (opcional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Por qué necesitas cobertura, preferencias de cambio, etc."
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">
                Avisar a
              </span>
              <span className="text-xs text-gray-500">
                {selectedCount}{" "}
                {selectedCount === 1 ? "persona" : "personas"}
              </span>
            </div>
            <p className="mb-2 text-xs text-gray-500">
              Sólo las personas seleccionadas recibirán el email y
              podrán responder. Por defecto se avisa a quienes
              comparten tu categoría.
            </p>

            {(me.isLoading || team.isLoading) && (
              <p className="text-xs text-gray-500">Cargando equipo…</p>
            )}

            {selected !== null && grouped.length === 0 && (
              <p className="text-xs text-gray-500">
                No hay compañeros del equipo principal a los que enviar
                la solicitud.
              </p>
            )}

            {selected !== null && grouped.length > 0 && (
              <div className="space-y-3 rounded-md border border-gray-200 p-2 max-h-64 overflow-y-auto">
                {grouped.map((g) => {
                  const selectedInGroup = g.members.filter((m) =>
                    selected.has(m.id),
                  ).length;
                  const allSelected = selectedInGroup === g.members.length;
                  return (
                    <div key={g.key}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.members)}
                        className="w-full flex items-baseline justify-between text-left text-xs font-semibold uppercase tracking-wide text-gray-600 hover:text-gray-900"
                      >
                        <span>{g.name}</span>
                        <span
                          className={
                            "text-[11px] font-normal normal-case "
                            + (allSelected
                              ? "text-brand-700"
                              : "text-gray-400")
                          }
                        >
                          {selectedInGroup}/{g.members.length}
                          {" · "}
                          {allSelected ? "Quitar todos" : "Seleccionar todos"}
                        </span>
                      </button>
                      <ul className="mt-1 space-y-0.5">
                        {g.members.map((m) => (
                          <li key={m.id}>
                            <label className="flex items-center gap-2 rounded px-1 py-0.5 text-sm cursor-pointer hover:bg-gray-50">
                              <input
                                type="checkbox"
                                checked={selected.has(m.id)}
                                onChange={() => toggleMember(m.id)}
                                className="h-3.5 w-3.5 accent-brand-600"
                              />
                              <span className="text-gray-800">
                                {m.person_name}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {submit.isError && (
            <p className="text-sm text-red-700">
              {(submit.error as Error).message}
            </p>
          )}

          <p className="text-xs text-gray-500 leading-relaxed">
            Quienes reciban el aviso podrán responder de dos formas:
            <br />·{" "}
            <span className="font-medium text-gray-700">Cubrir</span>{" "}
            — hacen el turno y tú no les debes nada.
            <br />·{" "}
            <span className="font-medium text-gray-700">
              Proponer cambio
            </span>{" "}
            — intercambian este turno por uno suyo.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submit.isPending ? "Enviando…" : "Pedir cobertura"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

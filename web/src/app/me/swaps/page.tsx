"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import {
  api,
  type SwapAssignmentSummary,
  type SwapOffer,
  type SwapResponse,
} from "@/lib/api";
import { EmptyState, StatusPill } from "@/components/admin/ui";

export default function SwapsPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const offers = useQuery({
    queryKey: ["swap-offers"],
    queryFn: () => api.listSwapOffers(),
  });

  const myPersonId = me.data?.person.id;
  const myMembershipId = me.data?.memberships.find(
    (m) => m.tenant_id === me.data!.current_tenant.id,
  )?.id;

  const partition = useMemo(() => {
    const all = offers.data ?? [];
    const mine = all.filter(
      (o) => o.requested_by_membership_id === myMembershipId,
    );
    const open = all.filter(
      (o) =>
        o.status === "open"
        && o.requested_by_membership_id !== myMembershipId,
    );
    const historical = all.filter(
      (o) =>
        o.status !== "open"
        && o.requested_by_membership_id !== myMembershipId,
    );
    return { mine, open, historical };
  }, [offers.data, myMembershipId]);

  if (me.isLoading || offers.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Cambios de turno</h1>
        <p className="mt-1 text-sm text-gray-600">
          Pide cobertura para tus turnos o cubre/cambia turnos de otros
          compañeros.
        </p>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-800">
          Mis solicitudes
        </h2>
        <NewOfferButton myPersonId={myPersonId ?? null} />
        {partition.mine.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight className="h-5 w-5" />}
            title="Aún no has pedido ningún cambio"
            description="Desde Mis turnos puedes hacer clic en uno de los tuyos para pedir cobertura."
          />
        ) : (
          <div className="space-y-3">
            {partition.mine.map((o) => (
              <MyOfferCard key={o.id} offer={o} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-800">
          Disponibles
        </h2>
        {partition.open.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight className="h-5 w-5" />}
            title="Ningún compañero ha pedido cambio"
            description="Cuando alguien ofrezca uno de sus turnos lo verás aquí."
          />
        ) : (
          <div className="space-y-3">
            {partition.open.map((o) => (
              <OpenOfferCard
                key={o.id}
                offer={o}
                myMembershipId={myMembershipId ?? null}
              />
            ))}
          </div>
        )}
      </section>

      {partition.historical.length > 0 && (
        <section>
          <details className="rounded-md border bg-white">
            <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-gray-700">
              Histórico ({partition.historical.length})
            </summary>
            <div className="space-y-3 p-4">
              {partition.historical.map((o) => (
                <OpenOfferCard
                  key={o.id}
                  offer={o}
                  myMembershipId={myMembershipId ?? null}
                  readOnly
                />
              ))}
            </div>
          </details>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shiftLabel(a: SwapAssignmentSummary): string {
  const d = a.date;
  const wd = new Date(d).getUTCDay();
  const day = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd];
  return `${day} ${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} · ${a.slot_name}`;
}

function StatusBadge({ status }: { status: string }) {
  const tone = (
    {
      open: "warning",
      pending: "warning",
      fulfilled: "success",
      accepted: "success",
      cancelled: "neutral",
      declined: "neutral",
      withdrawn: "neutral",
    } as const
  )[status] ?? "neutral";
  const label: Record<string, string> = {
    open: "Abierta",
    pending: "Pendiente",
    fulfilled: "Cumplida",
    accepted: "Aceptada",
    cancelled: "Cancelada",
    declined: "Rechazada",
    withdrawn: "Retirada",
  };
  return <StatusPill tone={tone}>{label[status] ?? status}</StatusPill>;
}

// ---------------------------------------------------------------------------
// My offers
// ---------------------------------------------------------------------------

function MyOfferCard({ offer }: { offer: SwapOffer }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelSwapOffer(offer.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swap-offers"] }),
  });
  const accept = useMutation({
    mutationFn: (responseId: number) =>
      api.acceptSwapResponse(offer.id, responseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swap-offers"] }),
  });
  const decline = useMutation({
    mutationFn: (responseId: number) =>
      api.declineSwapResponse(offer.id, responseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swap-offers"] }),
  });

  return (
    <div className="rounded-md border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">
            {shiftLabel(offer.assignment)}
          </div>
          {offer.notes && (
            <div className="mt-0.5 text-xs text-gray-600">{offer.notes}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={offer.status} />
          {offer.status === "open" && (
            <button
              className="text-xs text-red-700 hover:underline"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              Cancelar
            </button>
          )}
        </div>
      </div>

      {offer.responses.length > 0 && (
        <ul className="mt-3 space-y-2 border-t pt-3">
          {offer.responses.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-3 text-sm"
            >
              <div>
                <div className="font-medium">
                  {r.responder_person_name}{" "}
                  <span className="font-normal text-gray-600">
                    {r.kind === "cover"
                      ? "se ofrece a cubrir"
                      : "propone cambio"}
                  </span>
                </div>
                {r.kind === "swap" && r.swap_assignment && (
                  <div className="text-xs text-gray-600">
                    Te ofrece a cambio:{" "}
                    <span className="font-medium text-gray-800">
                      {shiftLabel(r.swap_assignment)}
                    </span>
                  </div>
                )}
                {r.notes && (
                  <div className="mt-0.5 text-xs text-gray-500">
                    {r.notes}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge status={r.status} />
                {r.status === "pending" && offer.status === "open" && (
                  <>
                    <button
                      className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                      onClick={() => accept.mutate(r.id)}
                      disabled={accept.isPending}
                    >
                      Aceptar
                    </button>
                    <button
                      className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      onClick={() => decline.mutate(r.id)}
                      disabled={decline.isPending}
                    >
                      Rechazar
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {(accept.isError || decline.isError || cancel.isError) && (
        <p className="mt-2 text-xs text-red-700">
          {((accept.error || decline.error || cancel.error) as Error)?.message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New offer: pick from my upcoming published assignments
// ---------------------------------------------------------------------------

function NewOfferButton({ myPersonId }: { myPersonId: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3">
      <button
        className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
        onClick={() => setOpen(true)}
      >
        Pedir cobertura
      </button>
      {open && myPersonId !== null && (
        <NewOfferModal
          myPersonId={myPersonId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function NewOfferModal({
  myPersonId,
  onClose,
}: {
  myPersonId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });
  const publishedIds = useMemo(
    () =>
      (schedules.data ?? [])
        .filter((s) => s.status === "published")
        .map((s) => s.id),
    [schedules.data],
  );
  // Load each published schedule and flatten my assignments.
  const details = useQuery({
    queryKey: ["my-published-assignments", publishedIds],
    enabled: publishedIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        publishedIds.map((id) => api.getSchedule(id)),
      );
      const today = new Date().toISOString().slice(0, 10);
      const all = results.flatMap((d) =>
        d.assignments
          .filter(
            (a) =>
              a.person_id === myPersonId
              && a.date >= today
              && !a.locked_at,
          )
          .map((a) => ({
            id: a.id,
            schedule_id: a.schedule_id,
            date: a.date,
            slot_id: a.slot_id,
            slot_name: a.slot_name,
            person_id: a.person_id,
            person_name: a.person_name,
            team_role_label: a.team_role_label,
          })),
      );
      all.sort((x, y) => x.date.localeCompare(y.date));
      return all as SwapAssignmentSummary[];
    },
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createSwapOffer({
        assignment_id: selectedId!,
        notes: notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swap-offers"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Pedir cobertura</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (selectedId !== null) create.mutate();
          }}
        >
          <p className="text-xs text-gray-500">
            Solo se pueden ofrecer turnos de planificaciones publicadas
            todavía por venir y no bloqueadas.
          </p>
          {details.isLoading && (
            <p className="text-sm text-gray-500">Cargando turnos…</p>
          )}
          {details.data && details.data.length === 0 && (
            <p className="text-sm text-gray-500">
              No tienes turnos publicados disponibles para ofrecer.
            </p>
          )}
          {details.data && details.data.length > 0 && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Turno</span>
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(Number(e.target.value))}
                required
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  Elige un turno…
                </option>
                {details.data.map((a) => (
                  <option key={a.id} value={a.id}>
                    {shiftLabel(a)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Nota (opcional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          {create.isError && (
            <p className="text-sm text-red-700">
              {(create.error as Error).message}
            </p>
          )}
          <p className="text-xs text-gray-500 leading-relaxed">
            Los demás miembros del equipo podrán responder de dos
            formas:
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
              disabled={selectedId === null || create.isPending}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {create.isPending ? "Enviando…" : "Pedir cobertura"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open offers from other team members
// ---------------------------------------------------------------------------

function OpenOfferCard({
  offer,
  myMembershipId,
  readOnly = false,
}: {
  offer: SwapOffer;
  myMembershipId: number | null;
  readOnly?: boolean;
}) {
  const [respondMode, setRespondMode] = useState<null | "cover" | "swap">(
    null,
  );
  const myResponse = offer.responses.find(
    (r) => r.responder_membership_id === myMembershipId,
  );

  return (
    <div className="rounded-md border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-gray-500">
            {offer.requested_by_person_name} pide cobertura para
          </div>
          <div className="text-sm font-semibold">
            {shiftLabel(offer.assignment)}
          </div>
          {offer.notes && (
            <div className="mt-0.5 text-xs text-gray-600">{offer.notes}</div>
          )}
        </div>
        <StatusBadge status={offer.status} />
      </div>

      {!readOnly && offer.status === "open" && !myResponse && (
        <div className="mt-3 border-t pt-3 space-y-2">
          {/* Honour the requester's accepts preference. The
              wording + buttons reflect what they actually want;
              backend rejects the disallowed kind too as a
              safety net. "either" is the legacy / default. */}
          {offer.accepts === "either" && (
            <p className="text-xs text-gray-600 leading-relaxed">
              <span className="font-medium text-gray-800">Cubrir</span>:
              haces el turno y la persona no te debe nada.{" "}
              <span className="font-medium text-gray-800">
                Proponer cambio
              </span>
              : intercambias este turno por uno tuyo.
            </p>
          )}
          {offer.accepts === "cover_only" && (
            <p className="text-xs text-gray-600 leading-relaxed">
              {offer.requested_by_person_name} sólo busca{" "}
              <span className="font-medium text-gray-800">cobertura</span>
              : si aceptas, haces el turno y no te debe nada.
            </p>
          )}
          {offer.accepts === "swap_only" && (
            <p className="text-xs text-gray-600 leading-relaxed">
              {offer.requested_by_person_name} sólo busca un{" "}
              <span className="font-medium text-gray-800">cambio</span>:
              tendrás que ofrecer un turno tuyo a cambio.
            </p>
          )}
          <div className="flex gap-2">
            {offer.accepts !== "swap_only" && (
              <button
                className="rounded-md bg-gray-900 px-3 py-1 text-xs text-white hover:bg-gray-700"
                onClick={() => setRespondMode("cover")}
              >
                Cubrir
              </button>
            )}
            {offer.accepts !== "cover_only" && (
              <button
                className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                onClick={() => setRespondMode("swap")}
              >
                Proponer cambio
              </button>
            )}
          </div>
        </div>
      )}

      {myResponse && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-sm">
          <div>
            <span className="font-medium">Tu respuesta: </span>
            {myResponse.kind === "cover"
              ? "ofreces cubrir"
              : "propones cambio"}
            {myResponse.kind === "swap" && myResponse.swap_assignment && (
              <span className="ml-1 text-gray-600">
                ({shiftLabel(myResponse.swap_assignment)})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={myResponse.status} />
            {myResponse.status === "pending" && (
              <WithdrawButton
                offerId={offer.id}
                responseId={myResponse.id}
              />
            )}
          </div>
        </div>
      )}

      {respondMode !== null && (
        <RespondModal
          offer={offer}
          mode={respondMode}
          onClose={() => setRespondMode(null)}
        />
      )}
    </div>
  );
}

function WithdrawButton({
  offerId,
  responseId,
}: {
  offerId: number;
  responseId: number;
}) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.withdrawSwapResponse(offerId, responseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swap-offers"] }),
  });
  return (
    <button
      className="text-xs text-red-700 hover:underline disabled:opacity-50"
      onClick={() => m.mutate()}
      disabled={m.isPending}
    >
      Retirar
    </button>
  );
}

function RespondModal({
  offer,
  mode,
  onClose,
}: {
  offer: SwapOffer;
  mode: "cover" | "swap";
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: api.listSchedules,
  });
  const publishedIds = useMemo(
    () =>
      (schedules.data ?? [])
        .filter((s) => s.status === "published")
        .map((s) => s.id),
    [schedules.data],
  );
  const myAssignments = useQuery({
    queryKey: ["my-published-assignments", publishedIds],
    enabled: mode === "swap" && publishedIds.length > 0 && !!me.data,
    queryFn: async () => {
      if (!me.data) return [];
      const results = await Promise.all(
        publishedIds.map((id) => api.getSchedule(id)),
      );
      const today = new Date().toISOString().slice(0, 10);
      const pid = me.data.person.id;
      const all = results.flatMap((d) =>
        d.assignments
          .filter(
            (a) =>
              a.person_id === pid
              && a.date >= today
              && !a.locked_at,
          )
          .map((a) => ({
            id: a.id,
            schedule_id: a.schedule_id,
            date: a.date,
            slot_id: a.slot_id,
            slot_name: a.slot_name,
            person_id: a.person_id,
            person_name: a.person_name,
            team_role_label: a.team_role_label,
          })),
      );
      all.sort((x, y) => x.date.localeCompare(y.date));
      return all as SwapAssignmentSummary[];
    },
  });

  const [swapAssignmentId, setSwapAssignmentId] = useState<number | null>(
    null,
  );
  const [notes, setNotes] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      api.respondToSwapOffer(offer.id, {
        kind: mode,
        swap_assignment_id: mode === "swap" ? swapAssignmentId : null,
        notes: notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swap-offers"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">
            {mode === "cover" ? "Cubrir turno" : "Proponer cambio"}
          </h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "swap" && swapAssignmentId === null) return;
            submit.mutate();
          }}
        >
          <div className="rounded-md bg-gray-50 p-3 text-sm">
            <div className="text-xs text-gray-500">Cubres / cambias con:</div>
            <div className="font-medium">
              {offer.requested_by_person_name}
            </div>
            <div className="mt-1">{shiftLabel(offer.assignment)}</div>
          </div>

          {mode === "swap" && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Tu turno a cambio
              </span>
              {myAssignments.isLoading && (
                <p className="mt-1 text-sm text-gray-500">Cargando…</p>
              )}
              {myAssignments.data && myAssignments.data.length === 0 && (
                <p className="mt-1 text-sm text-gray-500">
                  No tienes turnos publicados disponibles para cambiar.
                </p>
              )}
              {myAssignments.data && myAssignments.data.length > 0 && (
                <select
                  value={swapAssignmentId ?? ""}
                  onChange={(e) =>
                    setSwapAssignmentId(Number(e.target.value))
                  }
                  required
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="" disabled>
                    Elige un turno…
                  </option>
                  {myAssignments.data.map((a) => (
                    <option key={a.id} value={a.id}>
                      {shiftLabel(a)}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Nota (opcional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>

          {submit.isError && (
            <p className="text-sm text-red-700">
              {(submit.error as Error).message}
            </p>
          )}

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
              disabled={
                submit.isPending
                || (mode === "swap" && swapAssignmentId === null)
              }
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {submit.isPending ? "Enviando…" : "Enviar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

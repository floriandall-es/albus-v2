"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AvailabilityBlock,
  type AvailabilityBlockType,
} from "@/lib/api";
import { DateRangeField } from "@/components/admin/date-range";

const TYPE_LABEL: Record<AvailabilityBlockType, string> = {
  vacation: "Vacaciones",
  sick: "Baja médica",
  training: "Formación",
  personal: "Personal",
  other: "Otro",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  denied: "bg-red-100 text-red-800",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  denied: "Denegada",
};

export default function BloqueosPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["my-availability"],
    queryFn: api.listMyAvailabilityRequests,
  });
  const [open, setOpen] = useState(false);
  const del = useMutation({
    mutationFn: (id: number) => api.deleteMyAvailabilityRequest(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-availability"] }),
  });

  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Mis bloqueos</h1>
        <button
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
          onClick={() => setOpen(true)}
        >
          Nueva solicitud
        </button>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        Pide bloqueos (vacaciones, baja, formación…) para días en los que
        no puedes trabajar. El admin revisa y aprueba o rechaza.
      </p>

      <div className="max-w-2xl rounded-md border bg-white p-4">
        {list.isLoading && (
          <p className="text-sm text-gray-500">Cargando…</p>
        )}
        {list.data && list.data.length === 0 && (
          <p className="text-sm text-gray-500">No has pedido bloqueos.</p>
        )}
        {list.data && list.data.length > 0 && (
          <ul className="divide-y">
            {list.data.map((b: AvailabilityBlock) => (
              <li
                key={b.id}
                className="py-2 flex items-start justify-between gap-3"
              >
                <div className="text-sm">
                  <div className="font-medium">
                    {b.start_date} → {b.end_date}{" "}
                    <span className="text-gray-500 font-normal">
                      · {TYPE_LABEL[b.block_type] ?? b.block_type}
                    </span>
                  </div>
                  {b.notes && (
                    <div className="text-xs text-gray-600 mt-0.5">
                      {b.notes}
                    </div>
                  )}
                  {b.status === "denied" && b.review_notes && (
                    <div className="text-xs text-red-700 mt-0.5">
                      Motivo: {b.review_notes}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      STATUS_BADGE[b.status] ?? "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {STATUS_LABEL[b.status] ?? b.status}
                  </span>
                  {b.status === "pending" && (
                    <button
                      className="text-xs text-red-700 hover:underline"
                      onClick={() => del.mutate(b.id)}
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && <NewRequestModal onClose={() => setOpen(false)} />}
    </>
  );
}

function NewRequestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [type, setType] = useState<AvailabilityBlockType>("vacation");
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.createMyAvailabilityRequest({
        start_date: start,
        end_date: end,
        block_type: type,
        notes: notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-availability"] });
      onClose();
    },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Nueva solicitud</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DateRangeField
            startDate={start}
            endDate={end}
            onChange={(s, e) => {
              setStart(s);
              setEnd(e);
            }}
            required
          />
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Tipo</span>
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as AvailabilityBlockType)
              }
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="vacation">Vacaciones</option>
              <option value="sick">Baja médica</option>
              <option value="training">Formación</option>
              <option value="personal">Personal</option>
              <option value="other">Otro</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Notas</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          {save.isError && (
            <p className="text-sm text-red-600">
              {(save.error as Error).message}
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
              disabled={save.isPending}
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {save.isPending ? "Enviando…" : "Enviar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

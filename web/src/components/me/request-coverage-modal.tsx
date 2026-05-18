"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";

/**
 * Modal launched when a member taps one of their own shifts (from
 * the /me Inicio cards or the /me/turnos list). Submits a swap
 * offer to the API and invalidates the swap-offers query so the
 * Cambios sidebar count refreshes.
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

  const submit = useMutation({
    mutationFn: () =>
      api.createSwapOffer({
        assignment_id: assignment.id,
        notes: notes || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swap-offers"] });
      onClose();
    },
  });

  const wd = new Date(assignment.date).getUTCDay();
  const dayLabel = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][wd];
  const dateLabel = `${dayLabel} ${assignment.date.slice(8, 10)}/${assignment.date.slice(5, 7)}/${assignment.date.slice(0, 4)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
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
            submit.mutate();
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

          {submit.isError && (
            <p className="text-sm text-red-700">
              {(submit.error as Error).message}
            </p>
          )}

          <p className="text-xs text-gray-500 leading-relaxed">
            Los demás miembros del equipo recibirán un email y podrán
            responder de dos formas:
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
              disabled={submit.isPending}
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

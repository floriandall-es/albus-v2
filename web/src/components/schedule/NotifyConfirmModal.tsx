"use client";
import { useState } from "react";
import { Button, Modal } from "@/components/admin/ui";

/**
 * Lifecycle confirmation dialog with an opt-in "notify by email" box.
 *
 * Used by every action that flips a schedule's visibility for team
 * members: publish (draft → published), reopen (published → draft),
 * and the period-level versions of both. The checkbox defaults ON
 * because that's the legacy behaviour — admins who want a silent
 * change have to actively untick it. `notifyMembers` is forwarded
 * to the API call so the backend can decide whether to fan out the
 * "tu planificación ya está disponible" / "se ha reabierto" emails.
 *
 * Lives under components/schedule/ rather than ui/ because the
 * notify-email semantics are specific to the schedule lifecycle.
 */
export function NotifyConfirmModal({
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

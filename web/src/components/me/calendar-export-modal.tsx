"use client";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, type Assignment } from "@/lib/api";
import { todayIso } from "@/lib/dates";

/**
 * Modal launched from /me/turnos → "Añadir al calendario". Lets the
 * member pick a date range and a subset of slot types, then downloads
 * an .ics they can import into Apple/Google/Outlook Calendar.
 *
 * Defaults:
 *  - Range: today → today + 3 months (the common "I want my shifts
 *    on my phone for the next quarter" case)
 *  - Slot types: every slot the member has any assignment for inside
 *    that range from the data we already loaded, all pre-checked.
 *    The user can uncheck a guardia type if they only want regular
 *    surgical shifts, etc.
 */
export function CalendarExportModal({
  myAssignments,
  onClose,
}: {
  /** ALL of the member's own assignments currently loaded into the
   * page (for any schedules we've fetched). Used only to populate
   * the slot-type checkbox list — the actual export query runs
   * server-side and isn't limited by what's in memory. */
  myAssignments: Assignment[];
  onClose: () => void;
}) {
  const today = useMemo(() => todayIso(), []);
  const defaultEnd = useMemo(() => {
    const [yy, mm, dd] = today.split("-").map(Number);
    const t = new Date(yy, mm - 1, dd);
    t.setMonth(t.getMonth() + 3);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }, [today]);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(defaultEnd);

  // Distinct slots in the user's loaded assignments, sorted by slot
  // position (matches the planning grid). We key checkboxes by slot
  // id, and label with the slot name.
  const slotOptions = useMemo(() => {
    const map = new Map<number, { id: number; name: string; pos: number }>();
    for (const a of myAssignments) {
      if (!map.has(a.slot_id)) {
        map.set(a.slot_id, {
          id: a.slot_id,
          name: a.slot_name,
          pos: a.slot_position ?? 0,
        });
      }
    }
    return Array.from(map.values()).sort((x, y) => {
      if (x.pos !== y.pos) return x.pos - y.pos;
      return x.name.localeCompare(y.name);
    });
  }, [myAssignments]);

  const [selectedSlotIds, setSelectedSlotIds] = useState<Set<number>>(
    () => new Set(slotOptions.map((s) => s.id)),
  );

  const toggleSlot = (id: number) => {
    setSelectedSlotIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allChecked =
    selectedSlotIds.size === slotOptions.length && slotOptions.length > 0;
  const toggleAll = () => {
    if (allChecked) setSelectedSlotIds(new Set());
    else setSelectedSlotIds(new Set(slotOptions.map((s) => s.id)));
  };

  const download = useMutation({
    mutationFn: () => {
      // Empty selection means "include everything" from the API's
      // perspective if we omit the param. But the user UNCHECKING
      // every box should produce an empty file — pass the empty
      // list explicitly so the API honours the filter.
      const slotIds =
        slotOptions.length > 0 && selectedSlotIds.size < slotOptions.length
          ? Array.from(selectedSlotIds)
          : undefined;
      return api.downloadMyShiftsIcs({ from, to, slotIds });
    },
    onSuccess: () => onClose(),
  });

  const rangeInverted = to < from;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Añadir al calendario</h2>
          <button onClick={onClose} className="text-gray-500 text-lg">
            ×
          </button>
        </div>
        <form
          className="p-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (rangeInverted) return;
            download.mutate();
          }}
        >
          <p className="text-xs text-gray-500 leading-relaxed">
            Descarga un archivo <code className="rounded bg-gray-100 px-1">.ics</code>{" "}
            con tus turnos publicados. Puedes importarlo en Apple Calendar,
            Google Calendar u Outlook. Si el responsable cambia un turno,
            vuelve a descargarlo para actualizarlo.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Desde</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                required
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Hasta</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                required
              />
            </label>
          </div>
          {rangeInverted && (
            <p className="text-xs text-red-700">
              La fecha &ldquo;hasta&rdquo; es anterior a la fecha
              {" "}&ldquo;desde&rdquo;.
            </p>
          )}

          {slotOptions.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-700">
                  Tipos de turno
                </span>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-brand-700 hover:underline"
                >
                  {allChecked ? "Quitar todos" : "Marcar todos"}
                </button>
              </div>
              <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white divide-y divide-gray-100">
                {slotOptions.map((s) => {
                  const checked = selectedSlotIds.has(s.id);
                  return (
                    <li key={s.id}>
                      <label className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSlot(s.id)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <span className="text-gray-800">{s.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-[11px] text-gray-500">
                La lista se construye con los turnos que ya tienes cargados
                en pantalla. Tipos de otros meses se incluyen igual si están
                marcados aquí.
              </p>
            </div>
          )}

          {download.isError && (
            <p className="text-sm text-red-700">
              {(download.error as Error).message}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
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
                download.isPending
                || rangeInverted
                || (slotOptions.length > 0 && selectedSlotIds.size === 0)
              }
              className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {download.isPending ? "Generando…" : "Descargar .ics"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

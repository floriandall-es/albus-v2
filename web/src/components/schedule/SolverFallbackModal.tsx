"use client";
import { AlertTriangle } from "lucide-react";
import { Button, Modal } from "@/components/admin/ui";

/**
 * Shown after a generate when the CP-SAT path failed to equilibrate
 * and the API fell back to the greedy generator. The pill in the
 * header has always called this "Simplificada" — same word here,
 * accessible to a non-technical jefe de servicio. We do NOT say
 * "solver" anywhere in the UI.
 *
 * Important honesty caveat: the greedy fallback respects eligibility,
 * availability blocks, pre-pins and locked cells, but it does NOT
 * guarantee every cross-slot rule (succession, same-day
 * incompatibility, frequency caps) is satisfied. The earlier draft of
 * this modal said "cumple todas las reglas estrictas" which is wrong
 * — the violations panel routinely flags conflicts after a fallback.
 * The copy here points the admin at the conflicts list and asks them
 * to review.
 *
 * Common root causes the suggestion list addresses:
 *
 *  1. Too many activities + roles vs. headcount.
 *  2. Too few eligible people for the slot's allow-list / categoría.
 *  3. Too many cross-slot rules interacting at "Estricta".
 *  4. Per-window frequency caps that are tight relative to days.
 *  5. Rotation orders shorter than the period.
 *
 * Period-level callers pass the labels of the months that fell back;
 * month-level callers pass a one-element list. The body adapts copy
 * automatically — singular vs plural, period vs month context.
 */
export function SolverFallbackModal({
  affectedMonths,
  onClose,
}: {
  /** Spanish month labels (e.g. ["julio 2026", "agosto 2026"]). At
   * least one entry — the modal only opens when something fell back. */
  affectedMonths: string[];
  onClose: () => void;
}) {
  const isPlural = affectedMonths.length > 1;
  const monthLabel = affectedMonths.join(", ");
  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Planificación generada con limitaciones"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div className="text-sm text-amber-900">
            <p className="font-medium">
              {isPlural
                ? `Hemos generado la planificación de ${monthLabel}, pero no hemos podido aplicar todas las reglas a la vez.`
                : `Hemos generado la planificación de ${monthLabel}, pero no hemos podido aplicar todas las reglas a la vez.`}
            </p>
            <p className="mt-1 text-amber-900/85">
              Es posible que algunas reglas no se hayan cumplido y que
              el reparto entre personas no sea equilibrado. Revisa los
              conflictos detectados que aparezcan en cada mes y ajusta
              a mano lo que haga falta.
            </p>
          </div>
        </div>
        <div className="text-sm text-gray-700">
          <p className="font-medium text-gray-900">
            ¿Por qué ha pasado?
          </p>
          <p className="mt-1">
            Suele indicar que hay demasiadas reglas activas o muy poca
            plantilla disponible para cumplirlas todas. La planificación
            se ha generado igualmente, pero algunas restricciones han
            tenido que saltarse para asignar a todo el mundo.
          </p>
        </div>
        <div className="text-sm text-gray-700">
          <p className="font-medium text-gray-900">
            Para obtener un resultado mejor:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>
              <strong>Reduce actividades simultáneas</strong> o
              sub-actividades que tengan menos personas elegibles que
              plazas a cubrir.
            </li>
            <li>
              <strong>Amplía el equipo autorizado</strong> de las
              actividades con pocas personas (en la actividad, en
              &quot;Equipo autorizado&quot; o &quot;Categorías&quot;).
            </li>
            <li>
              <strong>Relaja reglas estrictas</strong>: pasa a
              &quot;Blanda&quot; las reglas de sucesión o
              incompatibilidad que no sean obligatorias.
            </li>
            <li>
              <strong>Sube los límites de frecuencia</strong> (p. ej.
              de 2/mes a 3/mes) si la plantilla está reducida.
            </li>
            <li>
              <strong>Revisa las rotaciones</strong>: si la lista de
              rotación es más corta que el periodo, alguna persona
              repetirá. Añade gente a la rotación o cambia el tipo de
              regla.
            </li>
            <li>
              <strong>En un periodo especial</strong>, usa la pestaña
              &quot;Reglas&quot; para desactivar o aflojar reglas
              solo durante el periodo, sin cambiarlas globalmente.
            </li>
          </ul>
        </div>
        <div className="flex justify-end pt-1">
          <Button onClick={onClose}>Entendido</Button>
        </div>
      </div>
    </Modal>
  );
}

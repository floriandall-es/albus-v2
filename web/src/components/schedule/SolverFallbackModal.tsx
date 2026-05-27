"use client";
import { AlertTriangle } from "lucide-react";
import { Button, Modal } from "@/components/admin/ui";

/**
 * Shown right after a generate completes when the CP-SAT solver
 * couldn't equilibrate the problem and fell back to the greedy
 * solver. The schedule it produced IS valid (every hard rule is
 * still satisfied) but the reparto across people may be uneven and
 * soft rules may have been broken — the admin should know.
 *
 * Common root causes the suggestion list addresses:
 *
 *  1. Too many activities + roles vs. headcount — the model has more
 *     fixed cells than it can fairly distribute.
 *  2. Too few eligible people for the slot's allow-list / categoría
 *     filter.
 *  3. Too many cross-slot rules (succession + same-day) interacting,
 *     especially when severities are all "Estricta".
 *  4. Per-window frequency caps that are tight relative to the
 *     number of available days.
 *  5. Rotation orders that force the same person onto consecutive
 *     blocks because the rotation list is shorter than the period.
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
      title="Generada con el solver simplificado"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div className="text-sm text-amber-900">
            <p className="font-medium">
              {isPlural
                ? `Se ha usado el solver simplificado en: ${monthLabel}.`
                : `Se ha usado el solver simplificado en ${monthLabel}.`}
            </p>
            <p className="mt-1 text-amber-900/85">
              La planificación es válida — cumple todas las reglas
              estrictas. Pero el reparto entre personas puede ser
              desigual y algunas reglas blandas pueden haberse roto.
            </p>
          </div>
        </div>
        <div className="text-sm text-gray-700">
          <p className="font-medium text-gray-900">
            ¿Qué ha pasado?
          </p>
          <p className="mt-1">
            El solver equilibrado no pudo encontrar una solución que
            equilibrara el reparto dentro del tiempo asignado. Suele
            indicar que el problema está demasiado restringido para
            la plantilla disponible.
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
              actividades con pocas personas (allow-list o
              restricción por categoría).
            </li>
            <li>
              <strong>Relaja reglas estrictas</strong>: pasa a
              &quot;Blanda&quot; las reglas de sucesión o
              incompatibilidad que no sean obligatorias. El solver
              puede romperlas si no hay alternativa.
            </li>
            <li>
              <strong>Sube los límites de frecuencia</strong> (p. ej.
              de 2/mes a 3/mes) si la plantilla está reducida.
            </li>
            <li>
              <strong>Revisa las rotaciones</strong>: si la lista de
              rotación es más corta que el periodo, alguna persona
              repetirá. Añade gente a la rotación o usa otro tipo de
              regla.
            </li>
            <li>
              <strong>En un periodo especial</strong>, usa la pestaña
              &quot;Reglas&quot; para desactivar o aflojar reglas
              durante el periodo sin cambiarlas globalmente.
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

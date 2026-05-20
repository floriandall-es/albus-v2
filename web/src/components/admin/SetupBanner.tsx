"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Sparkles } from "lucide-react";
import { api, type SetupArea } from "@/lib/api";
import { Button } from "@/components/admin/ui";

/**
 * Banner that sits at the top of one of the four post-signup
 * subpages (/admin/slots, /admin/rules, /admin/team,
 * /admin/groups). Two states, swapped by the tenant's
 * setup_<area>_completed_at flag:
 *
 *   pending (NULL flag):
 *     Brand-tinted card with an explanation of what to do on the
 *     page and a primary "Marcar como completado" button.
 *
 *   done (timestamp set):
 *     Small emerald "Completado" chip with a "Marcar como
 *     pendiente" link so the admin can un-mark if they need to
 *     revisit.
 *
 * The /admin Inicio dashboard reads the same flags to gate which
 * cards remain visible; this banner is the only place the flag
 * gets toggled from.
 */
export function SetupBanner({
  area,
  title,
  description,
}: {
  area: SetupArea;
  /** Heading shown in the pending state. Short noun phrase, no
   * trailing punctuation ("Actividades del servicio"). */
  title: string;
  /** 1–3 sentences explaining what the admin should do on this
   * page in the pending state. */
  description: string;
}) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  const flagField = `setup_${area}_completed_at` as const;
  const flagValue = me.data?.current_tenant[flagField] ?? null;
  const done = flagValue !== null;

  const toggle = useMutation({
    mutationFn: (next: boolean) => api.setSetupArea(area, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  // Don't render anything until /me has loaded — avoids a brief
  // pending-state flash on a page the admin already finished.
  if (!me.data) return null;

  if (done) {
    return (
      <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-emerald-50 ring-1 ring-emerald-200 px-3 py-1 text-xs text-emerald-800">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="font-medium">Configuración completada</span>
        <button
          type="button"
          onClick={() => toggle.mutate(false)}
          disabled={toggle.isPending}
          className="text-emerald-700 hover:underline disabled:opacity-50"
        >
          Marcar como pendiente
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50/60 p-4 flex items-start gap-3">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white text-brand-700 ring-1 ring-brand-200 shrink-0">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900 mb-1">
          {title}
        </div>
        <p className="text-sm text-brand-900/80 leading-relaxed mb-3">
          {description}
        </p>
        <Button
          onClick={() => toggle.mutate(true)}
          disabled={toggle.isPending}
        >
          {toggle.isPending ? "Guardando…" : "Marcar como completado"}
        </Button>
      </div>
    </div>
  );
}

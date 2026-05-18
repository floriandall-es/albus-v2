"use client";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Stethoscope,
  ScissorsLineDashed,
  Check,
} from "lucide-react";
import { api, type PresetKind } from "@/lib/api";
import { ErrorText } from "@/components/admin/ui";
import { StepNav } from "../_nav";

/**
 * First wizard step. The admin picks one of three onboarding
 * templates; the choice is persisted on the tenant and (on first
 * selection) seeds the default Categorías for that vertical so the
 * next step opens with them pre-checked.
 *
 * Re-visiting this page after the choice is made keeps the
 * highlight on the selected card; clicking a different one updates
 * the stored preset but does NOT touch categories the admin has
 * since edited (server-side seeding only runs on first selection).
 */

type PresetCard = {
  kind: PresetKind;
  icon: typeof Stethoscope;
  title: string;
  subtitle: string;
  /** Short bullet list shown under the title — concrete examples of
   * what the admin will see seeded for them. */
  bullets: string[];
};

const PRESETS: PresetCard[] = [
  {
    kind: "quirurgico",
    icon: ScissorsLineDashed,
    title: "Servicio quirúrgico",
    subtitle: "Hospital, con quirófano + consulta + guardia",
    bullets: [
      "Categorías: Jefe de servicio, Adjunto, Residente R1–R5",
      "Pensado para Cirugía, ORL, Trauma, Urología, Gineco…",
      "Personaliza los turnos en el paso 4",
    ],
  },
  {
    kind: "medico",
    icon: Stethoscope,
    title: "Servicio médico",
    subtitle: "Hospital, sin quirófano (planta, consulta, guardia)",
    bullets: [
      "Categorías: Jefe de servicio, Adjunto, Residente R1–R5",
      "Pensado para Medicina interna, Cardio, Pediatría…",
      "Sin plantillas de quirófano",
    ],
  },
  {
    kind: "otro",
    icon: Building2,
    title: "Otro — empezar en blanco",
    subtitle: "Configuro mis categorías y turnos desde cero",
    bullets: [
      "Ninguna categoría predefinida",
      "Útil si tu equipo no encaja con los anteriores",
      "Tardarás un poco más en los siguientes pasos",
    ],
  },
];

export default function PresetStep() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  const choose = useMutation({
    mutationFn: (kind: PresetKind) => api.setOnboardingPreset(kind),
    onSuccess: () => {
      // Categories may have just been seeded server-side — invalidate
      // both `me` (tenant.preset_kind moved) and `categories` (the
      // next step's source of truth) so the user sees the fresh data.
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      router.push("/onboarding/categories");
    },
  });

  const currentKind = me.data?.current_tenant.preset_kind ?? null;
  const busyKind = choose.isPending ? choose.variables : null;

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">
        Paso 1 — ¿Qué tipo de equipo gestionas?
      </h2>
      <p className="text-sm text-gray-600 mb-6">
        Elige la plantilla que más se parece a tu servicio. Pre-rellenamos
        los siguientes pasos con valores razonables; puedes editar todo
        después.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {PRESETS.map((p) => {
          const Icon = p.icon;
          const isSelected = currentKind === p.kind;
          const isBusy = busyKind === p.kind;
          return (
            <button
              key={p.kind}
              type="button"
              onClick={() => choose.mutate(p.kind)}
              disabled={choose.isPending}
              className={
                "group relative text-left rounded-xl border bg-white p-4 transition-all "
                + "hover:border-brand-300 hover:shadow-soft disabled:opacity-60 disabled:cursor-wait "
                + (isSelected
                  ? "border-brand-500 ring-2 ring-brand-200 shadow-soft"
                  : "border-gray-200")
              }
            >
              {isSelected && (
                <span className="absolute top-2 right-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white">
                  <Check className="h-3 w-3" />
                </span>
              )}
              <span
                className={
                  "inline-flex h-9 w-9 items-center justify-center rounded-lg mb-3 "
                  + (isSelected
                    ? "bg-brand-100 text-brand-700"
                    : "bg-gray-100 text-gray-700 group-hover:bg-brand-100 group-hover:text-brand-700")
                }
              >
                <Icon className="h-5 w-5" />
              </span>
              <div className="text-base font-semibold text-gray-900">
                {p.title}
              </div>
              <div className="text-xs text-gray-500 mb-3">{p.subtitle}</div>
              <ul className="space-y-1 text-xs text-gray-600">
                {p.bullets.map((b) => (
                  <li key={b} className="flex gap-1.5">
                    <span className="text-gray-400">·</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              {isBusy && (
                <div className="mt-3 text-xs text-brand-700">Guardando…</div>
              )}
            </button>
          );
        })}
      </div>

      {choose.isError && (
        <div className="mt-4">
          <ErrorText>{(choose.error as Error).message}</ErrorText>
        </div>
      )}

      <p className="mt-6 text-xs text-gray-500">
        Tu elección sólo afecta a los valores por defecto en los siguientes
        pasos. Cualquier categoría que añadamos por ti la puedes quitar en
        el paso siguiente.
      </p>

      <StepNav currentSlug="preset" />
    </div>
  );
}

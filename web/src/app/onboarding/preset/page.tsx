"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Stethoscope,
  ScissorsLineDashed,
  Check,
  PartyPopper,
  Sparkles,
  HeartPulse,
  X,
} from "lucide-react";
import { api, type PresetKind } from "@/lib/api";
import { ErrorText } from "@/components/admin/ui";
import { StepNav } from "../_nav";
import { StepHeader } from "../_step-header";

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
    bullets: ["Pensado para Cirugía, ORL, Trauma, Urología, Gineco…"],
  },
  {
    kind: "medico",
    icon: Stethoscope,
    title: "Servicio médico",
    subtitle: "Hospital, sin quirófano (planta, consulta, guardia)",
    bullets: ["Pensado para Medicina interna, Cardio, Pediatría…"],
  },
  {
    kind: "otro",
    icon: Building2,
    title: "Otro — empezar en blanco",
    subtitle: "Configuro mis categorías y actividades desde cero",
    bullets: ["Útil si tu equipo no encaja con los anteriores"],
  },
];

export default function PresetStep() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  // Picking a preset card flags it as selected and saves to the
  // server, but DOES NOT advance the wizard. That lets the user
  // also touch the region picker below the cards on the same step
  // before continuing. Explicit "Continuar" button at the bottom
  // owns the navigation.
  const choose = useMutation({
    mutationFn: (kind: PresetKind) => api.setOnboardingPreset(kind),
    onSuccess: () => {
      // Categories may have just been seeded server-side — invalidate
      // both `me` (tenant.preset_kind moved) and `categories` (the
      // next step's source of truth) so the user sees the fresh data.
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  // Holiday import — used to be triggered by an explicit region
  // picker on this step. Now the region is derived server-side
  // from the picked hospital's autonomous_community, so we just
  // fan-out the import once on mount (current + next year). The
  // endpoint dedupes on (tenant, date, name) so re-running is
  // harmless if the user navigates back. Gated on a per-tenant
  // localStorage flag so we don't hit the endpoint on every visit.
  const runHolidayImport = useMutation({
    mutationFn: async ({
      country,
      region,
    }: { country: string; region: string }) => {
      const year = new Date().getFullYear();
      await Promise.allSettled([
        api.importHolidays({
          country_code: country,
          region_code: region,
          year,
        }),
        api.importHolidays({
          country_code: country,
          region_code: region,
          year: year + 1,
        }),
      ]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["holidays"] });
    },
  });

  // Sprint 28: trasplantes flag moved here from /signup. Writes
  // the tenant via the same /api/tenants/me PATCH endpoint as the
  // region picker; the value lives on the tenant so the
  // /admin/trasplantes sidebar visibility picks it up immediately.
  const setTransplants = useMutation({
    mutationFn: (v: boolean) =>
      api.updateTenantDefaults({ transplants_enabled: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const currentKind = me.data?.current_tenant.preset_kind ?? null;
  const currentTransplants =
    me.data?.current_tenant.transplants_enabled ?? false;
  const busyKind = choose.isPending ? choose.variables : null;

  // Fire the holiday import once per tenant on first visit, now
  // that region_code is set implicitly at signup. Idempotent on
  // the server, but the localStorage gate keeps us from hammering
  // the endpoint on every revisit.
  const tenantIdForHolidays = me.data?.current_tenant.id;
  const regionForHolidays = me.data?.current_tenant.region_code;
  const countryForHolidays =
    me.data?.current_tenant.country_code
    ?? me.data?.current_tenant.country
    ?? "ES";
  useEffect(() => {
    if (!tenantIdForHolidays || !regionForHolidays) return;
    const key = `onboarding-holidays-imported-${tenantIdForHolidays}`;
    try {
      if (localStorage.getItem(key)) return;
    } catch {
      // ignore localStorage errors; we'll just retry next mount.
    }
    runHolidayImport.mutate(
      { country: countryForHolidays, region: regionForHolidays },
      {
        onSettled: () => {
          try {
            localStorage.setItem(key, "1");
          } catch {
            // ignore
          }
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantIdForHolidays, regionForHolidays, countryForHolidays]);

  // First-visit welcome modal — congratulates the user on creating
  // their servicio (which they just did in the 4-step signup) and
  // sets expectations for this wizard. Gated on a per-tenant
  // localStorage key so revisiting the page later doesn't re-show
  // it. Different tenant → different key, so an admin who creates
  // a second equipo sees it again (intended).
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const tenantId = me.data?.current_tenant.id;
  useEffect(() => {
    if (!tenantId) return;
    try {
      const key = `onboarding-welcome-shown-${tenantId}`;
      if (!localStorage.getItem(key)) {
        setWelcomeOpen(true);
      }
    } catch {
      // localStorage can be blocked (incognito, strict modes).
      // Silently skip the modal — it's a delighter, not critical.
    }
  }, [tenantId]);
  const closeWelcome = () => {
    setWelcomeOpen(false);
    if (tenantId) {
      try {
        localStorage.setItem(`onboarding-welcome-shown-${tenantId}`, "1");
      } catch {
        // ignore
      }
    }
  };

  return (
    <div>
      <StepHeader
        icon={Sparkles}
        title="Paso 1 — Tipo de equipo"
        subtitle="Elige la plantilla que más se parece a tu servicio. Pre-rellenamos los siguientes pasos con valores razonables."
      />

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

      {/* Region picker used to live here. Now we derive region_code
          server-side from the hospital's autonomous_community at
          signup, and fan-out the holiday import implicitly on first
          mount (see runHolidayImport useEffect above). The admin
          can still override the region from /admin/holidays if the
          CNH mapping misses a variant or they want a different one. */}

      {/* Trasplantes opt-in module — same source as the signup
          checkbox used to be. Tenants that don't run a transplant
          program leave it unchecked; the module stays hidden. */}
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 flex items-start gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700 shrink-0">
          <HeartPulse className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={currentTransplants}
              onChange={(e) => setTransplants.mutate(e.target.checked)}
              disabled={setTransplants.isPending}
              className="mt-0.5 shrink-0"
            />
            <span>
              <span className="block text-sm font-semibold text-gray-900">
                ¿Tu servicio realiza trasplantes?
              </span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Activa el módulo de trasplantes — registro de
                casos (EXPLANTE / IMPLANTE), estadísticas y
                filtros. Puedes dejarlo en blanco si no aplica.
              </span>
            </span>
          </label>
        </div>
      </div>

      <StepNav currentSlug="preset" />

      <WelcomeModal
        open={welcomeOpen}
        onClose={closeWelcome}
        servicioName={me.data?.current_tenant.servicio_name ?? null}
        equipoName={me.data?.current_tenant.name ?? null}
      />
    </div>
  );
}

// ===========================================================================
// First-visit welcome modal
// ===========================================================================
// Florian's observation: by the time the user lands here they've
// just walked through the 4-step signup wizard (persona → hospital
// → servicio → equipo). Jumping straight to "Paso 1 — Tipo de
// equipo" can feel jarring with no acknowledgement of what they
// just did. A short modal congratulates them on the servicio they
// created and frames this wizard as the second leg of getting set
// up. Gated on a per-tenant localStorage flag so it only appears
// once.
function WelcomeModal({
  open,
  onClose,
  servicioName,
  equipoName,
}: {
  open: boolean;
  onClose: () => void;
  servicioName: string | null;
  equipoName: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Bienvenida"
    >
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-soft ring-1 ring-gray-200">
        <button
          type="button"
          aria-label="Cerrar"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="p-6">
          <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
            <PartyPopper className="h-5 w-5" />
          </div>
          <h3 className="pr-8 text-lg font-semibold text-gray-900">
            {servicioName ? `¡${servicioName} ya está en marcha!` : "¡Servicio creado!"}
          </h3>
          <p className="mt-2 text-sm text-gray-600 leading-relaxed">
            Acabas de dar de alta el servicio
            {servicioName ? <> <strong className="text-gray-800">{servicioName}</strong></> : null}
            {equipoName ? <> con tu equipo <strong className="text-gray-800">{equipoName}</strong></> : null}.
            {" "}
            Este asistente te ayuda con la configuración inicial en
            5 pasos cortos: tipo de equipo, categorías, actividades,
            equipo y resumen.
          </p>
          <p className="mt-3 text-xs text-gray-500 leading-relaxed">
            Puedes saltarte pasos y volver más tarde — los valores
            por defecto son razonables para empezar.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 shadow-soft transition-colors"
          >
            Empezar
            <Sparkles className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}


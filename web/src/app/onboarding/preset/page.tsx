"use client";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Stethoscope,
  ScissorsLineDashed,
  Check,
  MapPin,
  Sparkles,
  Users,
  HeartPulse,
} from "lucide-react";
import { api, type PresetKind } from "@/lib/api";
import { ErrorText, Select } from "@/components/admin/ui";
import { ES_REGIONS } from "@/lib/regions";
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

  // Region picker — saves region_code on the tenant and triggers a
  // best-effort holiday import for the current + next year. Both
  // calls are fire-and-forget from the UI's perspective (we
  // invalidate /me on success); the admin can still fix things via
  // /admin/holidays after onboarding.
  const setRegion = useMutation({
    mutationFn: async (regionCode: string) => {
      await api.updateTenantDefaults({ region_code: regionCode });
      const country =
        me.data?.current_tenant.country_code
        ?? me.data?.current_tenant.country
        ?? "ES";
      const year = new Date().getFullYear();
      // Two years: current + next. The import endpoint dedupes on
      // (tenant, date, name) so re-running it is harmless.
      await Promise.allSettled([
        api.importHolidays({
          country_code: country,
          region_code: regionCode,
          year,
        }),
        api.importHolidays({
          country_code: country,
          region_code: regionCode,
          year: year + 1,
        }),
      ]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["holidays"] });
    },
  });

  // Sprint 28: sub-equipos + trasplantes flags moved here from
  // /signup. Both write the tenant via the same /api/tenants/me
  // PATCH endpoint as the region picker; the value lives on the
  // tenant so the /admin Inicio checklist (and the Trasplantes
  // sidebar visibility) pick it up immediately.
  const setHasSubteams = useMutation({
    mutationFn: (v: boolean) => api.updateTenantDefaults({ has_subteams: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const setTransplants = useMutation({
    mutationFn: (v: boolean) =>
      api.updateTenantDefaults({ transplants_enabled: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const currentKind = me.data?.current_tenant.preset_kind ?? null;
  const currentRegion =
    me.data?.current_tenant.region_code ?? "";
  const currentHasSubteams = me.data?.current_tenant.has_subteams ?? false;
  const currentTransplants =
    me.data?.current_tenant.transplants_enabled ?? false;
  const busyKind = choose.isPending ? choose.variables : null;

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

      {/* Region picker — kept on this step so the regional festivos
          import happens before the admin gets to the planning. Placed
          after the preset cards (so it doesn't visually interrupt the
          question → cards flow) but reachable because picking a card
          no longer auto-advances. Optional: the explicit Continuar
          button below doesn't require a region to be set. */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-4 flex items-start gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700 shrink-0">
          <MapPin className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            Comunidad autónoma
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Lo usamos para cargar los festivos regionales junto con los
            nacionales. Lo puedes cambiar luego en Festivos.
          </p>
          <div className="max-w-xs">
            <Select
              label=""
              value={currentRegion}
              onChange={(v) => {
                if (v && v !== currentRegion) setRegion.mutate(String(v));
              }}
              options={[
                { value: "", label: "— Selecciona —" },
                ...ES_REGIONS.map((r) => ({ value: r.code, label: r.label })),
              ]}
            />
          </div>
          {setRegion.isPending && (
            <p className="mt-1 text-xs text-brand-700">Cargando festivos…</p>
          )}
          {setRegion.isSuccess && !setRegion.isPending && (
            <p className="mt-1 text-xs text-emerald-700">Festivos cargados.</p>
          )}
          {setRegion.isError && (
            <p className="mt-1 text-xs text-rose-700">
              {(setRegion.error as Error).message}
            </p>
          )}
        </div>
      </div>

      {/* Sub-equipos question — moved out of /signup so the
          credentials page stays focused on credentials. Yes/No
          pill row mirroring the original signup layout. The
          answer drives whether /admin Inicio surfaces a
          "Configura sub-equipos" card and whether the StepNav
          shows a sub-equipos step. */}
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 flex items-start gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700 shrink-0">
          <Users className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900">
            ¿Tienes sub-equipos que gestionan su propia planificación?
          </div>
          <p className="text-xs text-gray-500 mb-2">
            Por ejemplo residentes o becarios con un jefe que organiza
            sus turnos por separado. Si tu equipo solo tiene categorías
            (ej. adjuntos y residentes en la misma planificación),
            elige <strong>No</strong> — las categorías se configuran en
            el paso siguiente.
          </p>
          <div className="grid grid-cols-2 gap-2 max-w-xs">
            <SubteamOption
              label="Sí"
              active={currentHasSubteams === true}
              busy={setHasSubteams.isPending}
              onClick={() => setHasSubteams.mutate(true)}
            />
            <SubteamOption
              label="No"
              active={currentHasSubteams === false}
              busy={setHasSubteams.isPending}
              onClick={() => setHasSubteams.mutate(false)}
            />
          </div>
        </div>
      </div>

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
    </div>
  );
}

// Yes/No pill row for the sub-equipos answer. Mirrors the look the
// signup form had before the question moved here so admins coming
// back to flip the answer see something familiar.
function SubteamOption({
  label,
  active,
  busy,
  onClick,
}: {
  label: string;
  active: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={busy}
      className={
        "rounded-lg px-3 py-2 text-sm font-medium transition-colors "
        + (active
          ? "bg-brand-600 text-white shadow-soft"
          : "ring-1 ring-gray-300 bg-white text-gray-800 hover:bg-gray-50")
        + " disabled:opacity-60 disabled:cursor-wait"
      }
    >
      {label}
    </button>
  );
}

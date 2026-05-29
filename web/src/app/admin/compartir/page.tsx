"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CalendarOff, Eye, EyeOff } from "lucide-react";
import { api, type SharePolicy, type Slot } from "@/lib/api";
import { Card, EmptyState, PageHeader } from "@/components/admin/ui";

/** Migration 0085. Cargo string match must agree with the backend
 * (_person_is_jefe_de_servicio in routes/availability.py): strip
 * whitespace + lowercase, exact equality. Keeps the UI gate
 * consistent with the API gate so a jefe never sees the toggle
 * card without being able to use it (or vice versa). */
const JEFE_CARGO = "jefe de servicio";
function personIsJefe(cargos: string[] | undefined | null): boolean {
  return (cargos ?? []).some(
    (c) => (c ?? "").trim().toLowerCase() === JEFE_CARGO,
  );
}

/**
 * /admin/compartir — admin-only share-policy configuration.
 *
 * Sits under Configuración in the admin sidebar. The cross-equipo
 * read view (/me/servicio) is open to every member; only the
 * tenant admin can decide what THIS equipo shares with the rest
 * of the Servicio, and that decision lives here.
 *
 * Three policies:
 *   - Nada              → invisible.
 *   - Algunas actividades → only the slots ticked in the inline
 *                          picker (below the radios). The picker
 *                          edits each slot's shared_with_servicio
 *                          flag via PATCH /api/slots/{id}.
 *   - Todo el equipo     → every published assignment.
 *
 * Server-side: PATCH /api/equipos/me/share-policy + PATCH
 * /api/slots/{id}. Both gated on admin role; non-admins reach
 * /me/servicio via the useEffect bounce below (and the /admin
 * layout already redirects them away on load).
 */

const POLICY_LABEL: Record<SharePolicy, string> = {
  none: "Nada",
  selected: "Algunas actividades",
  full: "Todo el equipo",
};

const POLICY_HELP: Record<SharePolicy, string> = {
  none:
    "Tu equipo no aparece en la vista conjunta del servicio. Es el "
    + "valor por defecto para equipos nuevos.",
  selected:
    "Tu equipo aparece solo en las actividades que marques debajo.",
  full:
    "Tu equipo aparece con toda su planificación publicada en la "
    + "vista conjunta del servicio. Los borradores no se incluyen.",
};

export default function CompartirPage() {
  const qc = useQueryClient();
  const router = useRouter();

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const servicioId = me.data?.current_tenant.servicio_id ?? null;
  const currentPolicy: SharePolicy =
    me.data?.current_tenant.share_policy ?? "none";

  const isAdmin =
    me.data?.memberships.some(
      (m) =>
        m.tenant_id === me.data?.current_tenant.id
        && m.roles.includes("admin"),
    ) ?? false;
  useEffect(() => {
    if (me.data && !isAdmin) {
      router.replace("/me/servicio");
    }
  }, [me.data, isAdmin, router]);

  const updatePolicy = useMutation({
    mutationFn: (next: SharePolicy) =>
      api.updateMySharePolicy({ share_policy: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["servicio", servicioId] });
      qc.invalidateQueries({ queryKey: ["servicio-timeline", servicioId] });
    },
  });

  if (me.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }

  if (servicioId === null) {
    return (
      <>
        <PageHeader title="Compartir" />
        <EmptyState
          icon={<Building2 className="h-5 w-5" />}
          title="Sin servicio asignado"
          description={
            "Este equipo no está vinculado a un servicio, así que no "
            + "hay otros equipos con los que compartir."
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Compartir" />
      <p className="-mt-4 mb-6 max-w-2xl text-sm text-gray-600">
        Controla qué ven los otros equipos del servicio en{" "}
        <a
          href="/me/servicio"
          className="text-brand-700 underline-offset-2 hover:underline"
        >
          la vista conjunta
        </a>
        . Lectura solamente — ningún otro equipo puede editar tu
        planificación.
      </p>

      <Card>
        <div className="p-4 space-y-2">
          {(["none", "selected", "full"] as SharePolicy[]).map((p) => (
            <label
              key={p}
              className={
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
                + (currentPolicy === p
                  ? "border-brand-300 bg-brand-50/40"
                  : "border-gray-200 hover:bg-gray-50")
              }
            >
              <input
                type="radio"
                name="share-policy"
                className="mt-1"
                checked={currentPolicy === p}
                disabled={updatePolicy.isPending}
                onChange={() => updatePolicy.mutate(p)}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">
                    {POLICY_LABEL[p]}
                  </span>
                  <PolicyBadge policy={p} />
                </div>
                <div className="mt-0.5 text-xs text-gray-600">
                  {POLICY_HELP[p]}
                </div>
              </div>
            </label>
          ))}
        </div>
      </Card>

      {/* ------------------------------------------------------------ */}
      {/* Per-slot picker — only meaningful when policy is 'selected'.   */}
      {/* Rendered as a separate Card so the policy + picker read as     */}
      {/* a primary section + drill-down rather than nested controls.    */}
      {/* ------------------------------------------------------------ */}
      {currentPolicy === "selected" && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">
            Actividades a compartir
          </h2>
          <SlotPicker />
        </section>
      )}

      {/* Migration 0085. Bloqueo routing toggle, only rendered when
          the caller's cargo includes "Jefe de Servicio". Cargo gate
          matches the backend's _require_jefe_admin. Non-jefes don't
          even see the section header, so the feature is silently
          out of view for them. */}
      {personIsJefe(me.data?.person.cargos) && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">
            Aprobación de bloqueos
          </h2>
          <BloqueoRoutingCard />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bloqueo routing (migration 0085)
// ---------------------------------------------------------------------------

function BloqueoRoutingCard() {
  const qc = useQueryClient();
  const routing = useQuery({
    queryKey: ["bloqueo-routing"],
    queryFn: api.getBloqueoRouting,
  });
  const save = useMutation({
    mutationFn: (next: "delegated" | "centralised") =>
      api.updateBloqueoRouting({ mode: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bloqueo-routing"] });
      // The /me/bloqueos picker queries this too — invalidate so a
      // tab open elsewhere refreshes the next time it's used.
      qc.invalidateQueries({ queryKey: ["my-servicio-admins"] });
    },
  });

  if (routing.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (routing.isError) {
    // Defensive: if the cargo check race-conditioned (jefe lost
    // the cargo mid-session) the server may now 403. Render a
    // clean message rather than the raw error.
    return (
      <Card>
        <p className="px-4 py-3 text-sm text-rose-700">
          No se ha podido cargar este ajuste.
        </p>
      </Card>
    );
  }
  const data = routing.data!;
  const mode = data.mode;
  const jefeName = data.jefe?.person_name ?? null;
  const jefeTenant = data.jefe?.tenant_name ?? null;

  return (
    <Card>
      <div className="p-4 space-y-3">
        <p className="text-xs text-gray-600 max-w-xl">
          Decide cómo se enrutan las solicitudes de bloqueo del servicio.
          Por defecto las solicitudes se centralizan en el Jefe de
          Servicio. Si prefieres que cada miembro elija a qué admin
          enviarlas, cámbialo a descentralizado.
        </p>

        <div className="space-y-2">
          {/* Recommended default first. Order matters for visual
              hierarchy — the toggle reads "this is the safe choice,
              flip only if you want the alternative". */}
          <label
            className={
              "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
              + (mode === "centralised"
                ? "border-amber-300 bg-amber-50/40"
                : "border-gray-200 hover:bg-gray-50")
            }
          >
            <input
              type="radio"
              name="bloqueo-routing"
              className="mt-1"
              checked={mode === "centralised"}
              disabled={save.isPending}
              onChange={() => save.mutate("centralised")}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">
                {data.caller_is_jefe
                  ? "Centralizado en mí"
                  : jefeName
                    ? `Centralizado en ${jefeName}`
                    : "Centralizado en el Jefe de Servicio"}{" "}
                <span className="text-xs font-normal text-gray-500">
                  (por defecto)
                </span>
              </div>
              <div className="mt-0.5 text-xs text-gray-600">
                <CalendarOff className="-mt-0.5 mr-1 inline h-3 w-3 text-amber-700" />
                {data.caller_is_jefe
                  ? "Todas las solicitudes del servicio llegarán a ti."
                  : jefeName
                    ? `Todas las solicitudes irán a ${jefeName}` +
                      (jefeTenant ? ` (${jefeTenant}).` : ".")
                    : "Todas las solicitudes irán al Jefe de Servicio cuando lo asignes."}
              </div>
            </div>
          </label>

          <label
            className={
              "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
              + (mode === "delegated"
                ? "border-brand-300 bg-brand-50/40"
                : "border-gray-200 hover:bg-gray-50")
            }
          >
            <input
              type="radio"
              name="bloqueo-routing"
              className="mt-1"
              checked={mode === "delegated"}
              disabled={save.isPending}
              onChange={() => save.mutate("delegated")}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900">
                Descentralizado
              </div>
              <div className="mt-0.5 text-xs text-gray-600">
                Cada miembro elige a qué admin del servicio envía su
                solicitud de bloqueo.
              </div>
            </div>
          </label>
        </div>

        {mode === "centralised" && !data.jefe && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Modo centralizado activado pero ningún miembro tiene el
            cargo &ldquo;Jefe de Servicio&rdquo;. Hasta que se asigne,
            las solicitudes seguirán el flujo descentralizado (el
            miembro elige el admin).
          </p>
        )}

        {save.isError && (
          <p className="text-xs text-rose-700">
            {(save.error as Error).message}
          </p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Per-slot picker
// ---------------------------------------------------------------------------

function SlotPicker() {
  const qc = useQueryClient();

  const slots = useQuery({
    queryKey: ["slots"],
    queryFn: () => api.listSlots(),
  });

  const toggleSlot = useMutation({
    mutationFn: (vars: { id: number; next: boolean }) =>
      api.updateSlot(vars.id, { shared_with_servicio: vars.next }),
    onMutate: async (vars) => {
      // Optimistic toggle so the row flips instantly. Roll back on
      // error via onError; refetch via onSettled to reconcile with
      // server state (which also picks up any side-effects like
      // updated_at).
      await qc.cancelQueries({ queryKey: ["slots"] });
      const prev = qc.getQueryData<Slot[]>(["slots"]);
      qc.setQueryData<Slot[]>(["slots"], (old) =>
        old
          ? old.map((s) =>
              s.id === vars.id
                ? { ...s, shared_with_servicio: vars.next }
                : s,
            )
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["slots"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["slots"] });
      // The servicio timeline + the servicio overview both reflect
      // these flags when share_policy='selected' — invalidate so
      // they re-render with the new visibility on next visit.
      qc.invalidateQueries({ queryKey: ["servicio"] });
      qc.invalidateQueries({ queryKey: ["servicio-timeline"] });
    },
  });

  if (slots.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  const list = (slots.data ?? []).slice().sort((a, b) => a.position - b.position);
  if (list.length === 0) {
    return (
      <Card>
        <p className="px-4 py-3 text-sm text-gray-500">
          Este equipo aún no tiene actividades configuradas.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <ul className="divide-y divide-gray-100">
        {list.map((s) => {
          const checked = s.shared_with_servicio;
          return (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <input
                id={`slot-share-${s.id}`}
                type="checkbox"
                checked={checked}
                disabled={toggleSlot.isPending}
                onChange={(e) =>
                  toggleSlot.mutate({ id: s.id, next: e.target.checked })
                }
              />
              <label
                htmlFor={`slot-share-${s.id}`}
                className="min-w-0 flex-1 cursor-pointer text-sm"
              >
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-sm align-middle"
                  style={{ backgroundColor: s.color ?? "#9ca3af" }}
                />
                <span className="font-medium text-gray-900">{s.name}</span>
              </label>
              {checked ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                  <Eye className="h-3 w-3" />
                  Visible
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                  <EyeOff className="h-3 w-3" />
                  Oculta
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function PolicyBadge({ policy }: { policy: SharePolicy }) {
  if (policy === "full") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
        <Eye className="h-3 w-3" />
        Todo
      </span>
    );
  }
  if (policy === "selected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">
        <Eye className="h-3 w-3" />
        Algunas
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
      <EyeOff className="h-3 w-3" />
      Nada
    </span>
  );
}

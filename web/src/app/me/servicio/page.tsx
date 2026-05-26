"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, EyeOff, Eye, ChevronDown } from "lucide-react";
import {
  api,
  personLastName,
  type SharePolicy,
  type ServicioTimelineCell,
} from "@/lib/api";
import { Card, PageHeader, EmptyState } from "@/components/admin/ui";
import {
  MonthPicker,
  isoFromMonthYear,
} from "@/components/admin/month-picker";

/**
 * /admin/servicio — Phase C.2.
 *
 * The first cross-equipo surface. Three sections stacked on one
 * page:
 *
 *   1. Equipos del servicio — list of every peer Equipo with its
 *      share_policy + approval_state badges.
 *   2. Qué comparte tu equipo — radio picker for your equipo's
 *      share_policy (admin-only on the API; we render disabled
 *      for non-admins). Per-slot picker (when 'selected') lives
 *      on /admin/slots — a hint in the description points there.
 *   3. Timeline del servicio — month-pickable read-only grid
 *      showing visible assignments from every equipo, respecting
 *      each one's policy. Grouped by equipo → slot. Color-coded
 *      by slot.
 *
 * The page is gated by tenant.servicio_id: callers without one
 * see an empty-state asking the operator to attach a hospital +
 * servicio. (Pre-Phase-A tenants — should be none in production.)
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
    "Tu equipo aparece solo en las actividades que marques como "
    + "compartidas en /admin/slots.",
  full:
    "Tu equipo aparece con toda su planificación publicada en la "
    + "vista conjunta del servicio. Los borradores no se incluyen.",
};

export default function ServicioPage() {
  const qc = useQueryClient();

  // Caller's own tenant → which servicio to load
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const servicioId = me.data?.current_tenant.servicio_id ?? null;
  const callerTenantId = me.data?.current_tenant.id ?? null;
  const isAdmin =
    me.data?.memberships.some(
      (m) =>
        m.tenant_id === me.data?.current_tenant.id
        && m.roles.includes("admin"),
    ) ?? false;
  const currentPolicy: SharePolicy =
    me.data?.current_tenant.share_policy ?? "none";

  const servicio = useQuery({
    queryKey: ["servicio", servicioId],
    queryFn: () => api.getServicio(servicioId as number),
    enabled: servicioId !== null,
  });

  // Default month = current month, like every other range-driven page.
  const today = new Date();
  const [period, setPeriod] = useState<string>(
    isoFromMonthYear(today.getMonth(), today.getFullYear()),
  );
  const fromIso = period;
  const toIso = useMemo(() => {
    // Last day of the month referenced by `period`.
    const y = Number(period.slice(0, 4));
    const m = Number(period.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${period.slice(0, 7)}-${String(last).padStart(2, "0")}`;
  }, [period]);

  const timeline = useQuery({
    queryKey: ["servicio-timeline", servicioId, fromIso, toIso],
    queryFn: () =>
      api.getServicioTimeline(servicioId as number, fromIso, toIso),
    enabled: servicioId !== null,
  });

  const updatePolicy = useMutation({
    mutationFn: (next: SharePolicy) =>
      api.updateMySharePolicy({ share_policy: next }),
    onSuccess: () => {
      // Refresh /me so the radio reflects the new value + the
      // servicio's equipos list updates the local equipo badge.
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
        <PageHeader title="Servicio" />
        <EmptyState
          icon={<Building2 className="h-5 w-5" />}
          title="Sin servicio asignado"
          description={
            "Este equipo no está vinculado a un servicio todavía. "
            + "El administrador del sistema debe atribuirle un hospital "
            + "y un servicio para que aparezca aquí."
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Servicio" />
      {servicio.data && (
        <p className="-mt-4 mb-6 text-sm text-gray-600">
          {servicio.data.name}
          <span className="text-gray-400"> · </span>
          {servicio.data.hospital_name}
        </p>
      )}

      {/* ------------------------------------------------------------ */}
      {/* Equipos list                                                  */}
      {/* ------------------------------------------------------------ */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          Equipos del servicio
        </h2>
        <Card>
          <ul className="divide-y divide-gray-100">
            {(servicio.data?.equipos ?? []).map((e) => {
              const isMine = e.tenant_id === callerTenantId;
              const isPending = e.approval_state === "pending";
              return (
                <li
                  key={e.tenant_id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="truncate font-medium text-gray-900">
                        {e.tenant_name}
                      </span>
                      {isMine && (
                        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-800">
                          Tu equipo
                        </span>
                      )}
                      {isPending && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">
                          Pendiente de aprobación
                        </span>
                      )}
                    </div>
                  </div>
                  <SharePolicyBadge policy={e.share_policy} />
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* Share policy picker                                            */}
      {/* ------------------------------------------------------------ */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          Qué comparte tu equipo
        </h2>
        <Card>
          <div className="p-4">
            <p className="mb-3 text-xs text-gray-500">
              Controla qué ven los otros equipos del servicio
              {" en la "}
              <span className="font-medium">vista conjunta</span>
              {". Solo lectura — los demás equipos nunca pueden editar tu planificación."}
            </p>
            <div className="space-y-2">
              {(["none", "selected", "full"] as SharePolicy[]).map((p) => (
                <label
                  key={p}
                  className={
                    "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
                    + (currentPolicy === p
                      ? "border-brand-300 bg-brand-50/40"
                      : "border-gray-200 hover:bg-gray-50")
                    + (isAdmin ? "" : " cursor-not-allowed opacity-60")
                  }
                >
                  <input
                    type="radio"
                    name="share-policy"
                    className="mt-1"
                    checked={currentPolicy === p}
                    disabled={!isAdmin || updatePolicy.isPending}
                    onChange={() => updatePolicy.mutate(p)}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">
                      {POLICY_LABEL[p]}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-600">
                      {POLICY_HELP[p]}
                    </div>
                    {p === "selected" && currentPolicy === "selected" && (
                      <div className="mt-1 text-[11px] text-gray-500">
                        Marca las actividades a compartir en{" "}
                        <a
                          href="/admin/slots"
                          className="text-brand-700 underline-offset-2 hover:underline"
                        >
                          /admin/slots
                        </a>
                        .
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
            {!isAdmin && (
              <p className="mt-3 text-xs text-gray-500">
                Solo el administrador del equipo puede cambiar este
                ajuste.
              </p>
            )}
          </div>
        </Card>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* Timeline                                                       */}
      {/* ------------------------------------------------------------ */}
      <section>
        <div className="mb-2 flex flex-wrap items-end gap-3">
          <h2 className="text-sm font-semibold text-gray-700">
            Vista conjunta del servicio
          </h2>
          <div className="ml-auto w-60">
            <MonthPicker
              label="Mes"
              value={period}
              onChange={setPeriod}
            />
          </div>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Asignaciones publicadas de los equipos del servicio en el mes
          seleccionado. Lectura solamente.
        </p>
        {timeline.isLoading && (
          <p className="text-sm text-gray-500">Cargando…</p>
        )}
        {timeline.data && timeline.data.cells.length === 0 && (
          <EmptyState
            icon={<EyeOff className="h-5 w-5" />}
            title="Sin asignaciones visibles"
            description={
              "Ningún equipo del servicio comparte planificación "
              + "publicada en este mes. Esto puede deberse a políticas de "
              + "compartir 'Nada' o a que aún no hay nada publicado."
            }
          />
        )}
        {timeline.data && timeline.data.cells.length > 0 && (
          <TimelineGrid
            cells={timeline.data.cells}
            fromIso={fromIso}
            toIso={toIso}
          />
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SharePolicyBadge({ policy }: { policy: SharePolicy }) {
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

/** Cross-equipo grid. Rows = (equipo, slot). Columns = days of the
 * range. Cells = person last name. Sorted: equipos alpha,
 * slots alpha (we don't have slot.position cross-tenant, so name
 * is the next-best stable order). */
function TimelineGrid({
  cells,
  fromIso,
  toIso,
}: {
  cells: ServicioTimelineCell[];
  fromIso: string;
  toIso: string;
}) {
  // Day columns
  const days = useMemo(() => {
    const out: string[] = [];
    const start = new Date(fromIso + "T00:00:00");
    const end = new Date(toIso + "T00:00:00");
    const cur = new Date(start);
    while (cur <= end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [fromIso, toIso]);

  // Group cells into rows: per (tenant_id, slot_id)
  const rows = useMemo(() => {
    type Row = {
      key: string;
      tenant_id: number;
      tenant_name: string;
      slot_id: number;
      slot_name: string;
      slot_color: string | null;
      // date → cells (a slot can have multiple persons per day)
      byDate: Map<string, ServicioTimelineCell[]>;
    };
    const map = new Map<string, Row>();
    for (const c of cells) {
      const k = `${c.tenant_id}::${c.slot_id}`;
      let row = map.get(k);
      if (!row) {
        row = {
          key: k,
          tenant_id: c.tenant_id,
          tenant_name: c.tenant_name,
          slot_id: c.slot_id,
          slot_name: c.slot_name,
          slot_color: c.slot_color,
          byDate: new Map(),
        };
        map.set(k, row);
      }
      const arr = row.byDate.get(c.date) ?? [];
      arr.push(c);
      row.byDate.set(c.date, arr);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.tenant_name !== b.tenant_name) {
        return a.tenant_name.localeCompare(b.tenant_name, "es");
      }
      return a.slot_name.localeCompare(b.slot_name, "es");
    });
  }, [cells]);

  // Group rows by equipo for the visual header bands.
  type Band = { tenant_id: number; tenant_name: string; rows: typeof rows };
  const bands = useMemo(() => {
    const bs: Band[] = [];
    for (const r of rows) {
      let band = bs[bs.length - 1];
      if (!band || band.tenant_id !== r.tenant_id) {
        band = { tenant_id: r.tenant_id, tenant_name: r.tenant_name, rows: [] };
        bs.push(band);
      }
      band.rows.push(r);
    }
    return bs;
  }, [rows]);

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-gray-50">
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
            <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 font-semibold">
              Equipo / Actividad
            </th>
            {days.map((d) => (
              <th
                key={d}
                className="px-1.5 py-2 text-center font-semibold"
                title={d}
              >
                {d.slice(8)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bands.map((band) => (
            <BandRows key={band.tenant_id} band={band} days={days} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BandRows({
  band,
  days,
}: {
  band: {
    tenant_id: number;
    tenant_name: string;
    rows: {
      key: string;
      slot_name: string;
      slot_color: string | null;
      byDate: Map<string, ServicioTimelineCell[]>;
    }[];
  };
  days: string[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <tr className="bg-gray-50/70">
        <th
          colSpan={days.length + 1}
          className="sticky left-0 bg-gray-50/70 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-700"
        >
          <button
            type="button"
            onClick={() => setOpen((x) => !x)}
            className="inline-flex items-center gap-1.5 text-gray-700 hover:text-gray-900"
          >
            <ChevronDown
              className={
                "h-3.5 w-3.5 transition-transform "
                + (open ? "" : "-rotate-90")
              }
            />
            {band.tenant_name}
            <span className="ml-2 text-[10px] font-normal text-gray-500">
              ({band.rows.length} actividad{band.rows.length === 1 ? "" : "es"})
            </span>
          </button>
        </th>
      </tr>
      {open
        && band.rows.map((r) => (
          <tr key={r.key} className="border-t border-gray-100">
            <td className="sticky left-0 z-[1] whitespace-nowrap bg-white px-3 py-1.5 font-medium text-gray-800">
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle"
                style={{ backgroundColor: r.slot_color ?? "#9ca3af" }}
              />
              {r.slot_name}
            </td>
            {days.map((d) => {
              const cellsForDay = r.byDate.get(d) ?? [];
              return (
                <td
                  key={d}
                  className="px-1 py-1 text-center align-top text-[11px] leading-snug text-gray-700"
                >
                  {cellsForDay.map((c) => (
                    <div key={c.assignment_id} className="truncate">
                      {c.person_name
                        ? personLastName({
                            name: c.person_name,
                            last_name: c.person_last_name,
                          })
                        : (
                          <span className="text-gray-300">—</span>
                        )}
                    </div>
                  ))}
                </td>
              );
            })}
          </tr>
        ))}
    </>
  );
}

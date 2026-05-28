"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronDown, Eye, EyeOff } from "lucide-react";
import {
  api,
  personLastName,
  type SharePolicy,
  type ServicioTimelineCell,
} from "@/lib/api";
import { EmptyState } from "@/components/admin/ui";
import {
  formatPeriod,
  isoFromMonthYear,
} from "@/components/admin/month-picker";

/**
 * /me/servicio — read-only Vista conjunta del servicio (Phase C.2).
 *
 * Visual twin of /me/turnos: same header layout (h1 + inline month
 * select), same grid chrome (rounded-xl bg-white shadow-soft ring-1
 * ring-gray-200, sticky first column, weekday + day-of-month column
 * headers, today / weekend / holiday banding), same colour
 * vocabulary. The only structural difference is the per-equipo
 * collapsible band header that groups slot rows by their owning
 * tenant — that's content-essential here (cross-team) and absent in
 * /me/turnos (single-team).
 *
 * NO write controls — share-policy management lives on the
 * admin-only /admin/compartir page. This page is linked from both
 * /me and /admin sidebars so members and admins land on the same
 * view.
 *
 * Gated by tenant.servicio_id: callers without one see an empty-
 * state. Pre-Phase-A tenants — should be none in production.
 */

const MONTHS_ES_SHORT = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

/** Build the YYYY-MM-01 values offered in the month dropdown. We
 * mirror /me/turnos's `<select>` shape (one option per available
 * period) rather than the two-select MonthPicker — the goal is
 * visual parity. Range = current month ± 6 months, which comfortably
 * covers a half-year of planning in either direction. */
function buildMonthOptions(): { iso: string; label: string }[] {
  const now = new Date();
  const out: { iso: string; label: string }[] = [];
  for (let offset = -6; offset <= 6; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const iso = isoFromMonthYear(d.getMonth(), d.getFullYear());
    out.push({ iso, label: formatPeriod(iso) });
  }
  return out;
}

export default function ServicioPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const servicioId = me.data?.current_tenant.servicio_id ?? null;
  const callerTenantId = me.data?.current_tenant.id ?? null;

  const servicio = useQuery({
    queryKey: ["servicio", servicioId],
    queryFn: () => api.getServicio(servicioId as number),
    enabled: servicioId !== null,
  });

  // Default month = current month, same convention as every other
  // range-driven page.
  const today = new Date();
  const [period, setPeriod] = useState<string>(
    isoFromMonthYear(today.getMonth(), today.getFullYear()),
  );
  const monthOptions = useMemo(buildMonthOptions, []);
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

  // Holidays for the active year — drives the amber tint on holiday
  // columns, matching how /me/turnos shades them. Same query key
  // shape as turnos so the cache is shared.
  const periodYear = Number(period.slice(0, 4));
  const holidays = useQuery({
    queryKey: ["holidays-detail", `${periodYear}-01-01`],
    queryFn: () => api.listHolidays(periodYear),
    enabled: servicioId !== null,
  });
  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  if (me.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }

  if (servicioId === null) {
    return (
      <>
        <h1 className="text-2xl font-semibold mb-6">Servicio</h1>
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
      {/* Header — mirrors /me/turnos exactly: h1, inline month
          select, hospital · servicio caption below. */}
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Servicio</h1>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
        >
          {monthOptions.map((o) => (
            <option key={o.iso} value={o.iso}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {servicio.data && (
        <p className="mb-6 text-sm text-gray-600">
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
        <div className="overflow-hidden rounded-xl bg-white shadow-soft ring-1 ring-gray-200">
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
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* Vista conjunta                                                 */}
      {/* ------------------------------------------------------------ */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-gray-700">
          Vista conjunta del servicio
        </h2>
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
            holidayDates={holidayDates}
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

/** Spanish short weekday name, indexed by Date.getDay() (0=dom). Same
 * vocabulary the canonical PlanningGrid uses, so the two surfaces
 * read identically. */
const DOW_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/** Cross-equipo grid. Visually mirrors PlanningGrid (rounded-xl
 * card, shadow-soft, sticky first col, weekday + day-of-month
 * column headers, today / weekend / holiday banding). Structurally
 * groups rows by equipo via a collapsible band header — the
 * concept-level addition over /me/turnos's single-team grid. */
function TimelineGrid({
  cells,
  fromIso,
  toIso,
  holidayDates,
}: {
  cells: ServicioTimelineCell[];
  fromIso: string;
  toIso: string;
  holidayDates: Set<string>;
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

  // Group rows by equipo for the visual band headers.
  type Band = {
    tenant_id: number;
    tenant_name: string;
    rows: typeof rows;
  };
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

  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <div className="overflow-x-auto rounded-xl bg-white shadow-soft ring-1 ring-gray-200">
      {/* `border-separate border-spacing-0` is what makes `sticky`
          work on the first column — same trick PlanningGrid uses.
          Tailwind preflight sets tables to `border-collapse:
          collapse`, which prevents browsers from honouring
          `position: sticky` on td/th. */}
      <table className="text-xs border-separate border-spacing-0">
        <thead className="bg-gray-50">
          <tr>
            <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-r border-gray-200 whitespace-nowrap">
              Actividad
            </th>
            {days.map((d) => {
              const isHoliday = holidayDates.has(d);
              const dt = new Date(d);
              const wd = dt.getDay();
              const isWeekend = wd === 0 || wd === 6;
              const isToday = d === todayIso;
              return (
                <th
                  key={d}
                  className={
                    "px-1 py-2.5 text-center min-w-[84px] border-b "
                    + (isToday
                      ? "bg-brand-50 border-brand-200 "
                      : isHoliday
                        ? "bg-amber-50 border-amber-200 "
                        : isWeekend
                          ? "bg-slate-100 border-gray-200 "
                          : "border-gray-200 ")
                  }
                >
                  <div
                    className={
                      "text-sm font-semibold "
                      + (isToday
                        ? "text-brand-700"
                        : isHoliday
                          ? "text-amber-900"
                          : isWeekend
                            ? "text-gray-500"
                            : "text-gray-900")
                    }
                  >
                    {d.slice(8)}
                  </div>
                  <div
                    className={
                      "font-medium text-[10px] uppercase tracking-wide "
                      + (isToday
                        ? "text-brand-600"
                        : isHoliday
                          ? "text-amber-700"
                          : isWeekend
                            ? "text-gray-400"
                            : "text-gray-500")
                    }
                  >
                    {DOW_ES[wd]}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {bands.map((band) => (
            <BandRows
              key={band.tenant_id}
              band={band}
              days={days}
              todayIso={todayIso}
              holidayDates={holidayDates}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BandRows({
  band,
  days,
  todayIso,
  holidayDates,
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
  todayIso: string;
  holidayDates: Set<string>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <tr>
        <th
          colSpan={days.length + 1}
          className="sticky left-0 bg-brand-50/60 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-brand-800 border-b border-brand-100"
        >
          <button
            type="button"
            onClick={() => setOpen((x) => !x)}
            className="inline-flex items-center gap-1.5 text-brand-800 hover:text-brand-900"
          >
            <ChevronDown
              className={
                "h-3.5 w-3.5 transition-transform "
                + (open ? "" : "-rotate-90")
              }
            />
            {band.tenant_name}
            <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-brand-700/80">
              {band.rows.length} actividad
              {band.rows.length === 1 ? "" : "es"}
            </span>
          </button>
        </th>
      </tr>
      {open
        && band.rows.map((r, rowIdx) => (
          <tr
            key={r.key}
            className={rowIdx % 2 === 1 ? "bg-gray-50/40" : ""}
          >
            <td
              className={
                "sticky left-0 z-[1] px-3 py-2 border-r border-b border-gray-100 font-medium text-gray-800 whitespace-nowrap "
                + (rowIdx % 2 === 1 ? "bg-gray-50/90" : "bg-white")
              }
            >
              <span className="flex items-center gap-2">
                {r.slot_color && (
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: r.slot_color }}
                  />
                )}
                <span>{r.slot_name}</span>
              </span>
            </td>
            {days.map((d) => {
              const cellsForDay = r.byDate.get(d) ?? [];
              const wd = new Date(d).getDay();
              const isWeekend = wd === 0 || wd === 6;
              const isHoliday = holidayDates.has(d);
              const isToday = d === todayIso;
              const empty = cellsForDay.length === 0;
              return (
                <td
                  key={d}
                  className={
                    "align-top px-1.5 py-2 border-b border-gray-100 "
                    + (isToday
                      ? "bg-brand-50/30 "
                      : isHoliday
                        ? "bg-amber-50 "
                        : isWeekend
                          ? "bg-slate-100 "
                          : "")
                  }
                >
                  {empty ? (
                    <span className="text-[11px] text-gray-300">—</span>
                  ) : (
                    cellsForDay.map((c) => (
                      <div
                        key={c.assignment_id}
                        className="truncate text-[11px] leading-snug text-gray-800"
                      >
                        {c.person_name ? (
                          personLastName({
                            name: c.person_name,
                            last_name: c.person_last_name,
                          })
                        ) : (
                          <span className="text-rose-700 font-medium">
                            Sin cubrir
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </td>
              );
            })}
          </tr>
        ))}
    </>
  );
}

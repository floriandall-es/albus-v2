"use client";
import { useMemo, useState } from "react";
import {
  personLastName,
  type Assignment,
  type TeamMember,
} from "@/lib/api";
import { Card } from "@/components/admin/ui";
import { Avatar } from "@/components/schedule/planning-grid";

// ---------------------------------------------------------------------------
// Balance stats: per-person counts of slot assignments. Lets the admin see
// at a glance whether the schedule is fairly distributed. Min/max highlighted
// per column so outliers stand out.
//
// Multi-schedule tolerant: aggregation keys on person_id, not schedule_id, so
// the caller can feed assignments coming from several schedules (e.g. the
// "Ver período completo" view stacks Julio + Agosto into one Reparto table).
// ---------------------------------------------------------------------------

// Sentinel for the "Sin categoría" chip in the filter row. Real category
// names are non-empty strings so the empty string is safe to use as a key
// without colliding.
const NO_CATEGORY = "" as const;

export type BalanceStatsProps = {
  assignments: Assignment[];
  holidayDates: Set<string>;
  /** Used to sort the column headers by (categoría, name) so the
   * Reparto matches the order admins see on /admin/team. Without it
   * the table sorted alphabetically by last-name only and mixed
   * residents and adjuntos in the row. */
  team: TeamMember[];
  /** Inclusive date range. Assignments outside this range are
   * ignored. The per-month page passes the month; the period view
   * passes the full periodo range. When omitted, no filter is
   * applied — every assignment counts. */
  dateRange?: { from: string; to: string };
  /** Section heading above the table. Default: "Reparto por persona". */
  title?: string;
};

export function BalanceStats({
  assignments,
  holidayDates,
  team,
  dateRange,
  title = "Reparto por persona",
}: BalanceStatsProps) {
  // Categorías the admin has toggled OFF in the filter row. Persisted
  // only for the lifetime of the component (no localStorage) — the
  // initial render shows every categoría so admins don't lose track
  // of who's missing from the breakdown.
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(
    new Set(),
  );
  const stats = useMemo(() => {
    // Sprint 16: rows are keyed by (slot_name, team_role_label) so a
    // team_composition slot like Trasplante shows up as three rows
    // (Explante / Implante 1 / Implante 2) instead of one aggregated
    // row that hides whether the role rotation is balanced.
    type RowKey = { slot_name: string; team_role_label: string | null };
    const keyFor = (k: RowKey) =>
      `${k.slot_name}\x00${k.team_role_label ?? ""}`;
    type PersonMeta = {
      name: string;
      avatar_url: string | null;
      // Used to sort columns by (categoría, name). Pulled from the
      // team list since Assignment payloads don't carry category info.
      category_name: string | null;
    };
    const teamByPerson = new Map<
      number,
      { category_name: string | null }
    >();
    for (const m of team) {
      teamByPerson.set(m.person_id, { category_name: m.category_name });
    }
    const persons = new Map<number, PersonMeta>();
    const rows = new Map<string, RowKey>();
    const counts = new Map<string, Map<number, number>>(); // key -> pid -> n
    const weByPerson = new Map<number, number>();          // pid -> we/holiday count
    for (const a of assignments) {
      if (a.person_id === null || a.person_name === null) continue;
      // Sprint 28: dismissed cells aren't actually staffed — exclude
      // them from the per-person count so the Reparto reflects real
      // workload, not "Adán was scheduled but the activity was then
      // cancelled".
      if (a.dismissed_at !== null) continue;
      // Optional date-range filter. The period-view passes a wide
      // window (Jul 1 – Aug 31), the per-month page omits the prop
      // (assignments are already month-bounded). Inclusive on both
      // ends — matches Periodo's start_date/end_date semantics.
      if (dateRange) {
        if (a.date < dateRange.from || a.date > dateRange.to) continue;
      }
      if (!persons.has(a.person_id)) {
        // Render the LAST name in the BalanceStats header for the
        // same reason the planning grid uses it: tight columns. The
        // helper falls back to a heuristic split of `name` when
        // last_name isn't populated yet.
        const lastName = personLastName({
          name: a.person_name,
          last_name: a.person_last_name,
        });
        persons.set(a.person_id, {
          name: lastName,
          avatar_url: a.person_avatar_url ?? null,
          category_name:
            teamByPerson.get(a.person_id)?.category_name ?? null,
        });
      }
      const rk: RowKey = {
        slot_name: a.slot_name,
        team_role_label: a.team_role_label ?? null,
      };
      const ks = keyFor(rk);
      if (!rows.has(ks)) rows.set(ks, rk);
      let row = counts.get(ks);
      if (!row) {
        row = new Map();
        counts.set(ks, row);
      }
      row.set(a.person_id, (row.get(a.person_id) ?? 0) + 1);
      const wd = new Date(a.date).getUTCDay();
      if (wd === 0 || wd === 6 || holidayDates.has(a.date)) {
        weByPerson.set(a.person_id, (weByPerson.get(a.person_id) ?? 0) + 1);
      }
    }
    // Sort columns first by categoría (alphabetical, with null
    // categorías last so admins like Sales don't shove the clinical
    // grouping around), then by last-name. Mirrors the /admin/team
    // page's ordering so the two views line up.
    const personsAllSorted = Array.from(persons.entries()).sort((a, b) => {
      const ca = a[1].category_name;
      const cb = b[1].category_name;
      if (ca !== cb) {
        if (ca === null) return 1;
        if (cb === null) return -1;
        const byCat = ca.localeCompare(cb, "es");
        if (byCat !== 0) return byCat;
      }
      return a[1].name.localeCompare(b[1].name, "es");
    });
    // Distinct categorías present in the assignments — drives the
    // filter chips above the table. Order matches the column sort so
    // the chip row reads left-to-right in the same grouping.
    const allCategories: string[] = [];
    const seenCats = new Set<string>();
    for (const [, meta] of personsAllSorted) {
      const key = meta.category_name ?? NO_CATEGORY;
      if (!seenCats.has(key)) {
        seenCats.add(key);
        allCategories.push(key);
      }
    }
    // Apply the filter. Min/max + totals are recomputed against the
    // filtered set so the rojo/verde highlights reflect "outlier
    // WITHIN the visible cohort", which matches admin intuition
    // (compare residents to residents, adjuntos to adjuntos).
    const personsSorted = personsAllSorted.filter(([, meta]) => {
      const key = meta.category_name ?? NO_CATEGORY;
      return !hiddenCategories.has(key);
    });
    const rowsSorted = Array.from(rows.values()).sort((a, b) => {
      const byName = a.slot_name.localeCompare(b.slot_name);
      if (byName !== 0) return byName;
      // Same slot: keep the no-role row first (rare — shouldn't
      // coexist with role rows, but defensive), then alpha by role.
      if (a.team_role_label === null && b.team_role_label !== null) return -1;
      if (a.team_role_label !== null && b.team_role_label === null) return 1;
      return (a.team_role_label ?? "").localeCompare(b.team_role_label ?? "");
    });

    // Per-row min/max across persons for highlighting.
    const minMaxByRow = new Map<string, { min: number; max: number }>();
    for (const rk of rowsSorted) {
      const ks = keyFor(rk);
      const row = counts.get(ks)!;
      let mn = Infinity;
      let mx = -Infinity;
      for (const [pid] of personsSorted) {
        const v = row.get(pid) ?? 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      minMaxByRow.set(ks, { min: mn, max: mx });
    }

    // Per-person totals + min/max across persons.
    const totalByPerson = new Map<number, number>();
    for (const [pid] of personsSorted) {
      let s = 0;
      for (const rk of rowsSorted) {
        s += counts.get(keyFor(rk))?.get(pid) ?? 0;
      }
      totalByPerson.set(pid, s);
    }
    let totalMin = Infinity;
    let totalMax = -Infinity;
    for (const v of totalByPerson.values()) {
      if (v < totalMin) totalMin = v;
      if (v > totalMax) totalMax = v;
    }
    let weMin = Infinity;
    let weMax = -Infinity;
    for (const [pid] of personsSorted) {
      const v = weByPerson.get(pid) ?? 0;
      if (v < weMin) weMin = v;
      if (v > weMax) weMax = v;
    }
    return {
      personsSorted,
      allCategories,
      rowsSorted,
      keyFor,
      counts,
      minMaxByRow,
      totalByPerson,
      totalMin,
      totalMax,
      weByPerson,
      weMin,
      weMax,
    };
  }, [assignments, holidayDates, team, hiddenCategories, dateRange]);

  if (stats.personsSorted.length === 0 && stats.allCategories.length === 0) {
    return null;
  }
  const toggleCategory = (key: string) => {
    setHiddenCategories((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const showAllCategories = () => setHiddenCategories(new Set());

  const cellClass = (
    v: number,
    mn: number,
    mx: number,
    differs: boolean,
  ) => {
    if (!differs) return "text-gray-700";
    if (v === mx && mx !== mn) return "text-rose-700 font-medium";
    if (v === mn && mx !== mn) return "text-emerald-700";
    return "text-gray-700";
  };

  return (
    <div className="mt-6 inline-block max-w-full overflow-x-auto">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        {stats.allCategories.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-500">Mostrar:</span>
            {stats.allCategories.map((catKey) => {
              const visible = !hiddenCategories.has(catKey);
              const label =
                catKey === NO_CATEGORY ? "Sin categoría" : catKey;
              return (
                <button
                  key={catKey}
                  type="button"
                  onClick={() => toggleCategory(catKey)}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors "
                    + (visible
                      ? "border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100"
                      : "border-gray-300 bg-white text-gray-500 hover:bg-gray-50")
                  }
                >
                  {label}
                </button>
              );
            })}
            {hiddenCategories.size > 0 && (
              <button
                type="button"
                onClick={showAllCategories}
                className="text-[11px] text-gray-500 hover:text-gray-700 hover:underline"
              >
                Mostrar todas
              </button>
            )}
          </div>
        )}
      </div>
      {stats.personsSorted.length === 0 ? (
        <p className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
          Ninguna categoría seleccionada.
        </p>
      ) : (
      <Card>
        <table className="text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 text-left">
            <tr className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2">Actividad</th>
              {stats.personsSorted.map(([pid, meta]) => (
                <th
                  key={pid}
                  className="px-3 py-2 text-right whitespace-nowrap normal-case font-medium text-gray-700 text-xs tracking-normal"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar
                      name={meta.name}
                      mine={false}
                      imageUrl={meta.avatar_url}
                    />
                    <span>{meta.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stats.rowsSorted.map((rk) => {
              const ks = stats.keyFor(rk);
              const row = stats.counts.get(ks)!;
              const mm = stats.minMaxByRow.get(ks)!;
              return (
                <tr key={ks} className="border-b">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="flex flex-col leading-tight">
                      <span>{rk.slot_name}</span>
                      {rk.team_role_label && (
                        <span className="text-[10px] font-normal text-gray-500">
                          {rk.team_role_label}
                        </span>
                      )}
                    </span>
                  </td>
                  {stats.personsSorted.map(([pid]) => {
                    const v = row.get(pid) ?? 0;
                    return (
                      <td
                        key={pid}
                        className={
                          "px-3 py-2 text-right "
                          + cellClass(v, mm.min, mm.max, mm.min !== mm.max)
                        }
                      >
                        {v || "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-b bg-gray-50">
              <td
                className="px-3 py-2 font-medium whitespace-nowrap"
                title="Asignaciones en sábado, domingo o festivo"
              >
                Fines de semana / festivos
              </td>
              {stats.personsSorted.map(([pid]) => {
                const v = stats.weByPerson.get(pid) ?? 0;
                return (
                  <td
                    key={pid}
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        v,
                        stats.weMin,
                        stats.weMax,
                        stats.weMin !== stats.weMax,
                      )
                    }
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
            <tr className="bg-gray-50 font-medium">
              <td className="px-3 py-2">Total</td>
              {stats.personsSorted.map(([pid]) => {
                const v = stats.totalByPerson.get(pid) ?? 0;
                return (
                  <td
                    key={pid}
                    className={
                      "px-3 py-2 text-right "
                      + cellClass(
                        v,
                        stats.totalMin,
                        stats.totalMax,
                        stats.totalMin !== stats.totalMax,
                      )
                    }
                  >
                    {v}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </Card>
      )}
      <p className="mt-2 text-[11px] text-gray-500">
        <span className="text-rose-700">Rojo</span>: máximo de la fila ·{" "}
        <span className="text-emerald-700">verde</span>: mínimo. Diferencias
        grandes indican desbalance.
      </p>
    </div>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schedule } from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";
import {
  MonthPicker,
  formatPeriod,
} from "@/components/admin/month-picker";
import { CalendarDays } from "lucide-react";

const STATUS_TONE = {
  draft: "warning",
  published: "success",
  archived: "neutral",
} as const;

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

// Plain-language explainer rendered next to each status pill so
// non-technical admins immediately understand what the status
// implies for their team. Visibility is the part that confuses
// the most.
const STATUS_SUBTITLE: Record<string, string> = {
  draft: "solo tú la ves",
  published: "visible para el equipo",
  archived: "ya no visible para el equipo",
};

export default function SchedulesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const today = new Date();
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const [period, setPeriod] = useState<string>(defaultPeriod);

  // Only tenant admins can generate a new month (it runs the solver
  // on the main team's slots). Group leads land on this same page
  // but only to open existing schedules and edit their group's
  // cells manually, so the generate UI is hidden for them.
  const isTenantAdmin = !!me.data?.memberships.some((m) =>
    m.roles.includes("admin"),
  );

  const generate = useMutation({
    mutationFn: () => api.generateSchedule(period),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.push(`/admin/schedule/${data.id}`);
    },
  });

  return (
    <>
      <PageHeader title="Planificación" />
      {isTenantAdmin && (
        <Card>
          <div className="p-4 flex items-end gap-3">
            <div className="w-72">
              <MonthPicker label="Mes" value={period} onChange={setPeriod} />
            </div>
            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              {generate.isPending ? "Generando…" : "Generar nueva"}
            </Button>
          </div>
          {generate.isError && (
            <div className="px-4 pb-3">
              <ErrorText>{(generate.error as Error).message}</ErrorText>
            </div>
          )}
        </Card>
      )}
      <div className="mt-6">
        {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
        {list.data && list.data.length === 0 && (
          <EmptyState
            icon={<CalendarDays className="h-5 w-5" />}
            title="Aún no hay ninguna planificación"
            description={
              isTenantAdmin
                ? "Elige un mes arriba y pulsa Generar para crear la primera."
                : "El administrador todavía no ha generado ninguna planificación. Cuando lo haga, podrás asignar a tu sub-equipo aquí."
            }
          />
        )}
        {list.data && list.data.length > 0 && (
          <Card>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left">
                <tr className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2.5">Mes</th>
                  <th className="px-4 py-2.5">Estado</th>
                  <th className="px-4 py-2.5">Generada</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.data.map((s: Schedule) => {
                  const open = () => router.push(`/admin/schedule/${s.id}`);
                  return (
                    <tr
                      key={s.id}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                      role="link"
                      tabIndex={0}
                      aria-label={`Abrir planificación de ${formatPeriod(s.period)}`}
                      className="cursor-pointer hover:bg-brand-50/40 focus:bg-brand-50/40 focus:outline-none transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {formatPeriod(s.period)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2">
                          <StatusPill
                            tone={
                              STATUS_TONE[s.status as keyof typeof STATUS_TONE]
                              ?? "neutral"
                            }
                          >
                            {STATUS_LABEL[s.status] ?? s.status}
                          </StatusPill>
                          {STATUS_SUBTITLE[s.status] && (
                            <span className="text-xs text-gray-500">
                              {STATUS_SUBTITLE[s.status]}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {s.generated_at
                          ? new Date(s.generated_at).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}

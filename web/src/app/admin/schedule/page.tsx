"use client";
import Link from "next/link";
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

export default function SchedulesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules });
  const today = new Date();
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const [period, setPeriod] = useState<string>(defaultPeriod);

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
      <div className="mt-6">
        {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
        {list.data && list.data.length === 0 && (
          <EmptyState
            icon={<CalendarDays className="h-5 w-5" />}
            title="Aún no hay ninguna planificación"
            description="Elige un mes arriba y pulsa Generar para crear la primera."
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
                  <th className="px-4 py-2.5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.data.map((s: Schedule) => (
                  <tr
                    key={s.id}
                    className="hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {formatPeriod(s.period)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        tone={
                          STATUS_TONE[s.status as keyof typeof STATUS_TONE]
                          ?? "neutral"
                        }
                      >
                        {STATUS_LABEL[s.status] ?? s.status}
                      </StatusPill>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {s.generated_at
                        ? new Date(s.generated_at).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/admin/schedule/${s.id}`}>
                        <Button variant="secondary">Abrir</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}

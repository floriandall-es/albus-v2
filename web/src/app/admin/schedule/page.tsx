"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Schedule } from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  PageHeader,
  TextField,
} from "@/components/admin/ui";

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
          <div className="w-56">
            <TextField
              label="Mes (primer día)"
              type="date"
              value={period}
              onChange={setPeriod}
            />
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
          <Empty>Aún no se ha generado ninguna planificación.</Empty>
        )}
        {list.data && list.data.length > 0 && (
          <Card>
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Mes</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium">Generada</th>
                  <th className="px-4 py-2 font-medium text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((s: Schedule) => (
                  <tr key={s.id} className="border-b last:border-b-0">
                    <td className="px-4 py-2">{s.period}</td>
                    <td className="px-4 py-2">
                      {STATUS_LABEL[s.status] ?? s.status}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {s.generated_at
                        ? new Date(s.generated_at).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
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

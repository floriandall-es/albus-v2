"use client";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/admin/ui";
import { StepNav } from "../_nav";

export default function DoneStep() {
  const router = useRouter();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.listSkills });
  const pools = useQuery({ queryKey: ["pools"], queryFn: api.listPools });
  const slots = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const invs = useQuery({ queryKey: ["invitations"], queryFn: api.listInvitations });

  const finish = useMutation({
    mutationFn: () => api.completeOnboarding(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/me");
    },
  });

  const counts = {
    categories: cats.data?.length ?? 0,
    skills: skills.data?.length ?? 0,
    pools: pools.data?.length ?? 0,
    slots: slots.data?.length ?? 0,
    invites: invs.data?.length ?? 0,
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-2">Paso 6 — Resumen</h2>
      <p className="text-sm text-gray-600 mb-6">
        Esto es lo que has configurado:
      </p>

      <ul className="rounded-md border bg-white divide-y text-sm mb-6">
        <SummaryRow label="Categorías" value={counts.categories} />
        <SummaryRow label="Competencias" value={counts.skills} />
        <SummaryRow label="Unidades" value={counts.pools} />
        <SummaryRow label="Turnos" value={counts.slots} />
        <SummaryRow label="Invitaciones pendientes" value={counts.invites} />
      </ul>

      <ImportHolidaysCard />

      <p className="text-sm text-gray-600 mb-6">
        Puedes seguir editando todo desde la sección de administración. Cuando estés
        listo, termina la configuración para entrar al dashboard.
      </p>

      <Button onClick={() => finish.mutate()} disabled={finish.isPending}>
        {finish.isPending ? "Terminando…" : "Terminar configuración"}
      </Button>

      <StepNav currentSlug="done" />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between px-4 py-2">
      <span className="text-gray-600">{label}</span>
      <span className="font-medium">{value}</span>
    </li>
  );
}

function ImportHolidaysCard() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const region = me.data?.current_tenant.region_code ?? null;
  const importMut = useMutation({
    mutationFn: async () => {
      const a = await api.importHolidays({
        country_code: "ES",
        region_code: region,
        year: 2025,
      });
      const b = await api.importHolidays({
        country_code: "ES",
        region_code: region,
        year: 2026,
      });
      return { inserted: a.inserted + b.inserted, skipped: a.skipped + b.skipped };
    },
  });
  return (
    <div className="rounded-md border bg-white p-4 mb-6 text-sm">
      <p className="font-medium mb-1">Festivos de España (2025–2026)</p>
      <p className="text-gray-600 mb-3">
        Importa los festivos nacionales (y autonómicos si has fijado región) para
        que la planificación los respete automáticamente.
      </p>
      <Button
        variant="secondary"
        onClick={() => importMut.mutate()}
        disabled={importMut.isPending}
      >
        {importMut.isPending ? "Importando…" : "Importar festivos de España"}
      </Button>
      {importMut.isSuccess && (
        <p className="mt-2 text-xs text-green-700">
          Importados: {importMut.data.inserted} · Omitidos: {importMut.data.skipped}
        </p>
      )}
      {importMut.isError && (
        <p className="mt-2 text-xs text-red-600">
          {(importMut.error as Error).message}
        </p>
      )}
    </div>
  );
}

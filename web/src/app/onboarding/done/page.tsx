"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Layers } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/admin/ui";
import { StepNav } from "../_nav";
import { StepHeader } from "../_step-header";

export default function DoneStep() {
  const router = useRouter();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const slots = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const invs = useQuery({ queryKey: ["invitations"], queryFn: api.listInvitations });

  const finish = useMutation({
    mutationFn: () => api.completeOnboarding(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      // Only admins land here (the onboarding wizard is admin-only),
      // so /admin is the natural workspace to drop them into.
      router.replace("/admin");
    },
  });

  const counts = {
    categories: cats.data?.length ?? 0,
    slots: slots.data?.length ?? 0,
    invites: invs.data?.length ?? 0,
  };

  return (
    <div>
      <StepHeader
        icon={CheckCircle2}
        title="Paso 5 — Resumen"
        subtitle="Esto es lo que has configurado. Cuando termines, entrarás al panel."
      />

      <ul className="rounded-md border bg-white divide-y text-sm mb-6">
        <SummaryRow label="Categorías" value={counts.categories} />
        <SummaryRow label="Actividades" value={counts.slots} />
        <SummaryRow label="Invitaciones pendientes" value={counts.invites} />
      </ul>

      <ImportHolidaysCard />

      <SubEquiposCard />

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

function SubEquiposCard() {
  // Surfaced on the final onboarding step so admins who run a
  // mixed cohort (e.g. residentes alongside the main team) know
  // the feature exists before they exit the wizard. Lightweight
  // CTA — actual creation happens in /admin/groups, so we don't
  // gate "Terminar configuración" on this.
  return (
    <div className="rounded-md border bg-white p-4 mb-6 text-sm flex items-start gap-3">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700 shrink-0">
        <Layers className="h-5 w-5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium mb-1">¿Tienes residentes u otro sub-equipo?</p>
        <p className="text-gray-600 mb-3">
          Crea un sub-equipo para que su responsable gestione sus
          propias actividades y planificación, sin mezclarse con el
          equipo principal. Puedes hacerlo ahora o más tarde.
        </p>
        <Link
          href="/admin/groups"
          className="inline-flex items-center gap-1.5 rounded-lg ring-1 ring-gray-300 bg-white text-gray-800 hover:bg-gray-50 px-3 py-1.5 text-sm font-medium"
        >
          Ir a Sub-equipos
        </Link>
      </div>
    </div>
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

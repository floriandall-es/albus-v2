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
        <SummaryRow label="Skills" value={counts.skills} />
        <SummaryRow label="Pools" value={counts.pools} />
        <SummaryRow label="Slots" value={counts.slots} />
        <SummaryRow label="Invitaciones pendientes" value={counts.invites} />
      </ul>

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

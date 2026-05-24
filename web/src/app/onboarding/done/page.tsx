"use client";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import {
  api,
  type Category,
  type Invitation,
  type Slot,
} from "@/lib/api";
import { Button } from "@/components/admin/ui";
import { StepNav } from "../_nav";
import { StepHeader } from "../_step-header";

export default function DoneStep() {
  const router = useRouter();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const slots = useQuery({ queryKey: ["slots"], queryFn: () => api.listSlots() });
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
        <ExpandableSummaryRow
          label="Categorías"
          count={counts.categories}
          empty="Aún no has añadido categorías."
        >
          <CategoriesDetail items={cats.data ?? []} />
        </ExpandableSummaryRow>
        <ExpandableSummaryRow
          label="Actividades"
          count={counts.slots}
          empty="Aún no has añadido actividades."
        >
          <SlotsDetail items={slots.data ?? []} />
        </ExpandableSummaryRow>
        <ExpandableSummaryRow
          label="Invitaciones pendientes"
          count={counts.invites}
          empty="No hay invitaciones pendientes."
        >
          <InvitesDetail items={invs.data ?? []} />
        </ExpandableSummaryRow>
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

/** Expandable summary row. Header shows label + count and acts
 * as a disclosure toggle; when open it renders the children
 * below (the actual items). Closed by default to keep the page
 * scannable — admins who care about details click; admins who
 * just want a quick check see the counts at a glance. */
function ExpandableSummaryRow({
  label,
  count,
  empty,
  children,
}: {
  label: string;
  count: number;
  /** Copy shown in the expanded body when count === 0. */
  empty: string;
  /** Detail renderer for the non-empty case. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Disable expand when count is 0 — the empty state still
  // works fine, but visually highlighting the header as
  // interactive when there's nothing to show under it is just
  // misleading. Click still works to surface the "empty" hint.
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-gray-50"
      >
        <span className="flex items-center gap-2 text-gray-700">
          {open ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
          {label}
        </span>
        <span className="font-medium tabular-nums">{count}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 text-xs text-gray-700">
          {count === 0 ? (
            <p className="text-gray-500">{empty}</p>
          ) : (
            children
          )}
        </div>
      )}
    </li>
  );
}

function CategoriesDetail({ items }: { items: Category[] }) {
  const sorted = [...items].sort((a, b) =>
    a.name.localeCompare(b.name, "es"),
  );
  return (
    <ul className="flex flex-wrap gap-1.5">
      {sorted.map((c) => (
        <li
          key={c.id}
          className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-700"
        >
          {c.name}
        </li>
      ))}
    </ul>
  );
}

function SlotsDetail({ items }: { items: Slot[] }) {
  const sorted = [...items].sort((a, b) =>
    a.name.localeCompare(b.name, "es"),
  );
  return (
    <ul className="flex flex-wrap gap-1.5">
      {sorted.map((s) => (
        <li
          key={s.id}
          className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-700"
        >
          {s.name}
        </li>
      ))}
    </ul>
  );
}

function InvitesDetail({ items }: { items: Invitation[] }) {
  // Pendientes = not accepted, not revoked. Sort by name so the
  // expanded view reads as the team list does on /admin/team.
  const pending = items
    .filter((i) => !i.accepted_at && !i.revoked_at)
    .sort((a, b) => a.person_name.localeCompare(b.person_name, "es"));
  if (pending.length === 0) {
    return (
      <p className="text-gray-500">
        Todas las invitaciones han sido aceptadas.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {pending.map((i) => (
        <li key={i.id} className="flex items-baseline gap-2">
          <span className="font-medium text-gray-800">
            {i.person_name}
          </span>
          <span className="truncate text-gray-500">{i.email}</span>
        </li>
      ))}
    </ul>
  );
}

// ImportHolidaysCard was here until sprint 28. The import is
// already triggered automatically by the region picker on step 1
// (/onboarding/preset → setRegion mutation imports current + next
// year as a side effect), so this card was duplicative AND
// confusing — admins picked a region, saw "Festivos cargados",
// then arrived here and wondered if they had to import again.
// Removed in favour of the single point of action on step 1.

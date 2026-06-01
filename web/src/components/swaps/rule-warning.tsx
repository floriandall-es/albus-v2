"use client";

/**
 * <SwapRuleWarning /> — dry-runs a swap response through the rule
 * engine (GET …/simulate) and shows whether applying it would NEWLY
 * break any shift-assignment rule (incompatibilities, succession,
 * frequency caps, post-shift rest, time overlaps). Advisory only — it
 * never blocks the swap; it just lets the requester / admin decide with
 * eyes open. Used on the admin approval card and the member accept flow.
 *
 * Fails quiet: a simulation error renders nothing (the swap flow must
 * keep working even if the check can't run).
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import { api } from "@/lib/api";

export function SwapRuleWarning({
  offerId,
  responseId,
}: {
  offerId: number;
  responseId: number;
}) {
  const sim = useQuery({
    queryKey: ["swap-sim", offerId, responseId],
    queryFn: () => api.simulateSwapResponse(offerId, responseId),
    staleTime: 30_000,
  });

  if (sim.isLoading) {
    return (
      <p className="mt-2 text-[11px] text-gray-400">Comprobando reglas…</p>
    );
  }
  if (sim.isError || !sim.data) return null;
  if (!sim.data.would_violate) {
    return (
      <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-emerald-700">
        <Check className="h-3.5 w-3.5 shrink-0" />
        Sin conflictos de reglas
      </p>
    );
  }
  const n = sim.data.violations.length;
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
      <div className="flex items-center gap-1 font-semibold">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Este cambio rompería {n} regla{n === 1 ? "" : "s"}:
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {sim.data.violations.map((v, i) => (
          <li key={i}>{v.message}</li>
        ))}
      </ul>
    </div>
  );
}

"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/admin/ui";

/**
 * Notification card used by the Inicio "Pendientes" panels on both
 * /admin and /me. Visual contract: a small chip icon, a coloured
 * count pill, a label + sublabel, and a chevron — the whole card
 * deeplinks to the page that actions the items.
 *
 * Each Inicio surface picks its own tones per category so the eye
 * can sort cards at a glance without reading. Tone palette is
 * intentionally small (4 options) — adding more risks the cards
 * becoming a rainbow that competes for attention with the page
 * content underneath.
 */
export function PendientesCard({
  icon,
  count,
  label,
  sublabel,
  href,
  tone,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  sublabel: string;
  href: string;
  tone: "amber" | "violet" | "sky" | "emerald";
}) {
  const toneClasses = {
    amber: {
      chip: "bg-amber-100 text-amber-700 group-hover:bg-amber-200",
      pill: "bg-amber-600",
    },
    violet: {
      chip: "bg-violet-100 text-violet-700 group-hover:bg-violet-200",
      pill: "bg-violet-600",
    },
    sky: {
      chip: "bg-sky-100 text-sky-700 group-hover:bg-sky-200",
      pill: "bg-sky-600",
    },
    emerald: {
      chip: "bg-emerald-100 text-emerald-700 group-hover:bg-emerald-200",
      pill: "bg-emerald-600",
    },
  }[tone];
  return (
    <Link href={href} className="block group">
      <Card>
        <div className="p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors rounded-xl">
          <span
            className={
              "inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0 transition-colors "
              + toneClasses.chip
            }
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span
                className={
                  "inline-flex min-w-[1.5rem] justify-center rounded-full px-2 py-0.5 text-xs font-semibold leading-tight text-white "
                  + toneClasses.pill
                }
              >
                {count}
              </span>
              <span className="truncate text-sm font-semibold text-gray-900">
                {label}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-gray-500 truncate">
              {sublabel}
            </div>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-gray-400 shrink-0 group-hover:text-gray-600" />
        </div>
      </Card>
    </Link>
  );
}

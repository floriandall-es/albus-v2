"use client";
import type { LucideIcon } from "lucide-react";

/**
 * Shared header at the top of every onboarding step. Brand-tinted
 * icon chip + title + one-line subtitle. Keeps the five Pasos
 * visually consistent and avoids each page reinventing its own
 * heading block.
 */
export function StepHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-700 shrink-0">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <h2 className="text-2xl font-semibold text-gray-900 leading-tight">
          {title}
        </h2>
        <p className="text-sm text-gray-600">{subtitle}</p>
      </div>
    </div>
  );
}

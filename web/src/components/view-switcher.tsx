"use client";
import Link from "next/link";
import type { MeResponse } from "@/lib/api";

/**
 * Pill switcher rendered at the top of the sidebar for users who
 * have more than one "view" available to them. Three possible
 * views, in priority order:
 *
 *   - Admin (any membership with the "admin" role)
 *   - Sub-equipo (the lead of any Group — via Group.lead_membership_id)
 *   - Personal (anyone with a membership in the current tenant)
 *
 * The switcher is hidden when only one view is available — the
 * common case for pure surgeons, pure residents, and non-clinical
 * tenant admins. It shows up for the legitimate dual-role cases:
 *
 *   - Tenant admin who is also a clinical team member (e.g. the
 *     surgeon who runs planning) → [Admin] [Personal]
 *   - Group lead who is also a clinical member of their group
 *     (e.g. the chief resident) → [Sub-equipo] [Personal]
 *   - Edge case: admin who's also a lead of some group →
 *     [Admin] [Sub-equipo] [Personal]
 *
 * Visually compact — a single-row segmented control. Doesn't
 * compete with the main navigation below it.
 */
export function ViewSwitcher({
  me,
  current,
}: {
  me: MeResponse;
  current: "admin" | "lead" | "me";
}) {
  const isAdmin = me.memberships.some((m) => m.roles.includes("admin"));
  const isLead = me.lead_group_id !== null;

  // Build the list of views available to this user, in the same
  // order they appear in the pill.
  const views: { key: "admin" | "lead" | "me"; href: string; label: string }[] =
    [];
  if (isAdmin) views.push({ key: "admin", href: "/admin", label: "Admin" });
  if (isLead) views.push({ key: "lead", href: "/lead", label: "Sub-equipo" });
  views.push({ key: "me", href: "/me", label: "Personal" });

  if (views.length < 2) return null;

  return (
    <div className="px-3 pt-3">
      <div className="flex rounded-md bg-gray-100 p-0.5">
        {views.map((v) => {
          const active = v.key === current;
          return (
            <Link
              key={v.key}
              href={v.href}
              aria-current={active ? "page" : undefined}
              className={
                "flex-1 rounded-md py-1 text-center text-xs font-medium transition-colors "
                + (active
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900")
              }
            >
              {v.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

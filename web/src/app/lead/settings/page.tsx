"use client";
import { PageHeader } from "@/components/admin/ui";
import { ProfileCards } from "@/components/settings/profile-cards";

// Same ProfileCards used by /admin/settings and /me/settings; the
// underlying /api/me/* endpoints act on ctx.person regardless of
// role, so the surface is identical.
export default function LeadSettingsPage() {
  return (
    <>
      <PageHeader title="Mi cuenta" />
      <ProfileCards />
    </>
  );
}

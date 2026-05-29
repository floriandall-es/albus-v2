"use client";
import Link from "next/link";
import { CreditCard, ChevronRight } from "lucide-react";
import { Card } from "@/components/admin/ui";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { ProfileCards } from "@/components/settings/profile-cards";

export default function MeSettingsPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold mb-6">Mi cuenta</h1>
      <ProfileCards />
      {/* Notificaciones (migration 0089). Self-hides when push
          isn't supported (old browser / SSR); shows install hint
          when supported but the user isn't in the installed PWA. */}
      <NotificationsPanel />
      {/* Facturación moved here out of the sidebar — members don't
          need to see it on every page; it lives inside Mi cuenta
          as a single deep-link card. */}
      <div className="mt-6 max-w-xl">
        <Card>
          <Link
            href="/me/billing"
            className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50"
          >
            <span className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-gray-500" />
              <span>
                <span className="block text-sm font-medium text-gray-900">
                  Facturación
                </span>
                <span className="block text-xs text-gray-500">
                  Tu suscripción, tarjeta y facturas.
                </span>
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-gray-400" />
          </Link>
        </Card>
      </div>
    </>
  );
}

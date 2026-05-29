"use client";
import Link from "next/link";
import { CreditCard, ChevronRight } from "lucide-react";
import { Card, PageHeader } from "@/components/admin/ui";
import { ProfileCards } from "@/components/settings/profile-cards";

export default function AdminSettingsPage() {
  return (
    <>
      <PageHeader title="Mi cuenta" />
      <ProfileCards />
      {/* Facturación moved here out of the sidebar — admins don't
          need to see it on every page; it lives inside Mi cuenta
          as a single deep-link card. */}
      <div className="mt-6 max-w-xl">
        <Card>
          <Link
            href="/admin/billing"
            className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50"
          >
            <span className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-gray-500" />
              <span>
                <span className="block text-sm font-medium text-gray-900">
                  Facturación
                </span>
                <span className="block text-xs text-gray-500">
                  Plan, tarjeta, facturas y modelo de cobro del equipo.
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

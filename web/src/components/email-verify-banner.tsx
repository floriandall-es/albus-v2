"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * Persistent banner shown across the three app shells (/admin,
 * /lead, /me) while the signed-in user has NOT yet clicked the
 * signup verification link.
 *
 * Soft enforcement: we don't gate any feature on verification.
 * The banner is just a nudge with a "reenviar" button so the
 * user can re-request the email if they lost it or typo'd their
 * address.
 *
 * Existing accounts were backfilled to "verified" by migration
 * 0038 — so this banner only ever appears for fresh signups,
 * and for them only until they confirm.
 */
export function EmailVerifyBanner() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't render until /me loads. Don't render for verified
  // accounts (the overwhelming majority). The frontend treats a
  // missing `email_verified_at` field as legacy = verified, so
  // older API responses don't flash the banner.
  if (!me.data) return null;
  if (me.data.person.email_verified_at != null) return null;

  const resend = async () => {
    setSending(true);
    setError(null);
    try {
      await api.resendVerification();
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se ha podido reenviar");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900 flex items-center gap-4 justify-between">
      <div className="min-w-0">
        <span className="font-medium">Verifica tu correo.</span>{" "}
        <span className="text-amber-800">
          Te hemos enviado un enlace a{" "}
          <span className="font-medium">{me.data.person.email}</span>.
          Confirma para que no perdamos el contacto.
        </span>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {sent ? (
          <span className="text-emerald-700 text-xs">
            Enviado.
          </span>
        ) : (
          <button
            type="button"
            onClick={resend}
            disabled={sending}
            className="rounded-md bg-white ring-1 ring-amber-300 text-amber-900 hover:bg-amber-100 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            {sending ? "Enviando…" : "Reenviar"}
          </button>
        )}
        {error && (
          <span className="text-rose-700 text-xs">{error}</span>
        )}
      </div>
    </div>
  );
}

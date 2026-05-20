"use client";
import { useState } from "react";
import { StatusPill } from "@/components/admin/ui";
import type { Invitation } from "@/lib/api";

/**
 * One-line delivery status for an invitation row. Reads
 * `last_email_sent_at` + `last_email_error` and picks one of:
 *
 *   - "Falló"     (rose) — last attempt errored; error in tooltip
 *   - "Enviado X" (emerald) — last attempt succeeded
 *   - "No enviado" (warning) — never attempted (admin shared the
 *     accept_url manually, or the row predates email tracking)
 *
 * Hovering shows the precise timestamp / error string so admins
 * can debug SMTP issues without leaving the team page.
 */
export function InviteDeliveryPill({ inv }: { inv: Invitation }) {
  const [hover, setHover] = useState(false);

  if (inv.last_email_error) {
    return (
      <span
        title={inv.last_email_error}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <StatusPill tone="danger">Falló</StatusPill>
        {hover && (
          <span className="ml-2 text-[11px] text-rose-700 break-words">
            {truncate(inv.last_email_error, 80)}
          </span>
        )}
      </span>
    );
  }

  if (inv.last_email_sent_at) {
    const when = formatRelative(inv.last_email_sent_at);
    return (
      <span title={new Date(inv.last_email_sent_at).toLocaleString()}>
        <StatusPill tone="success">Enviado {when}</StatusPill>
      </span>
    );
  }

  return <StatusPill tone="warning">No enviado</StatusPill>;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Coarse "hace 5 min / hace 2 h / ayer / hace 3 d" formatter.
 * Good enough for an inline pill; admins can hover for the
 * full timestamp when they need precision. */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return "ahora";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.round(diffSec / 3600);
  if (hr < 24) return `hace ${hr} h`;
  const day = Math.round(diffSec / 86400);
  if (day < 7) return `hace ${day} d`;
  return new Date(iso).toLocaleDateString();
}

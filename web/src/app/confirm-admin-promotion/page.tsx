"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, type AdminPromotionPreviewData } from "@/lib/api";

/**
 * Landing page for the admin-promotion consent flow (migration 0087).
 *
 * Reached via the link in the email we send to the target on
 * promotion. Public — no Trivu session required. Token-only.
 *
 * URL shape: /confirm-admin-promotion?token=XXX&action=accept|decline
 *
 * `action` is read on first render to decide the default — but the
 * user still has to click the confirm button. We don't auto-fire
 * the decision on page load because email pre-fetchers (Outlook
 * link safety scans, etc.) hit the URL silently and we'd otherwise
 * burn the token. The default-action just biases the UI's primary
 * button so the link "Aceptar" in the email lands on a page where
 * Aceptar is highlighted.
 *
 * Mirrors the shape of /confirm-email so users feel at home.
 */
export default function ConfirmAdminPromotionPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
          <p className="text-sm text-gray-500">Cargando…</p>
        </main>
      }
    >
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const defaultAction =
    searchParams?.get("action") === "decline" ? "decline" : "accept";

  type State =
    | { kind: "loading" }
    | {
        kind: "preview";
        preview: AdminPromotionPreviewData;
      }
    | {
        kind: "done";
        preview: AdminPromotionPreviewData;
        decision: "accepted" | "declined";
      }
    | { kind: "err"; message: string };
  const [state, setState] = useState<State>({ kind: "loading" });
  const [submitting, setSubmitting] = useState<
    "accept" | "decline" | null
  >(null);

  useEffect(() => {
    if (!token) {
      setState({
        kind: "err",
        message: "Falta el token en el enlace.",
      });
      return;
    }
    let cancelled = false;
    api
      .previewAdminPromotion(token)
      .then((preview) => {
        if (cancelled) return;
        setState({ kind: "preview", preview });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Error";
        setState({ kind: "err", message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const decide = async (action: "accept" | "decline") => {
    setSubmitting(action);
    try {
      const preview =
        action === "accept"
          ? await api.acceptAdminPromotion(token)
          : await api.declineAdminPromotion(token);
      qc.invalidateQueries({ queryKey: ["me"] });
      setState({
        kind: "done",
        preview,
        decision: action === "accept" ? "accepted" : "declined",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error";
      setState({ kind: "err", message: msg });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">
          Promoción a admin
        </h1>

        {state.kind === "loading" && (
          <p className="text-sm text-gray-600">Cargando solicitud…</p>
        )}

        {state.kind === "preview" && state.preview.status === "pending" && (
          <>
            <p className="text-sm text-gray-700">
              <span className="font-medium text-gray-900">
                {state.preview.inviter_person_name ?? "Un admin"}
              </span>{" "}
              te propone el rol de admin en{" "}
              <span className="font-medium text-gray-900">
                {state.preview.tenant_name}
              </span>
              . Si aceptas, podrás gestionar el equipo, las
              actividades, las reglas y la planificación.
            </p>
            <p className="text-xs text-gray-500">
              Si tu equipo paga por miembros, tu suscripción de Trivu
              pasaría al precio Admin a partir de la próxima factura.
              Puedes ver los importes desde tu Portal de Stripe.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => decide("accept")}
                disabled={submitting !== null}
                className={
                  "flex-1 rounded-lg px-4 py-2 text-sm font-medium text-white "
                  + (defaultAction === "accept"
                    ? "bg-brand-600 hover:bg-brand-700"
                    : "bg-gray-700 hover:bg-gray-800")
                  + " disabled:opacity-50"
                }
              >
                {submitting === "accept" ? "Aceptando…" : "Aceptar"}
              </button>
              <button
                type="button"
                onClick={() => decide("decline")}
                disabled={submitting !== null}
                className={
                  "flex-1 rounded-lg px-4 py-2 text-sm font-medium "
                  + (defaultAction === "decline"
                    ? "bg-rose-700 text-white hover:bg-rose-800"
                    : "border border-gray-300 text-gray-700 hover:bg-gray-50")
                  + " disabled:opacity-50"
                }
              >
                {submitting === "decline" ? "Rechazando…" : "Rechazar"}
              </button>
            </div>
          </>
        )}

        {state.kind === "preview" && state.preview.status !== "pending" && (
          <p className="text-sm text-gray-700">
            Esta solicitud ya está{" "}
            <span className="font-medium">
              {labelForStatus(state.preview.status)}
            </span>
            . No hay nada que confirmar.
          </p>
        )}

        {state.kind === "done" && (
          <>
            <p className="text-sm text-emerald-700">
              {state.decision === "accepted"
                ? `Has aceptado el rol de admin en ${state.preview.tenant_name}.`
                : `Has rechazado la promoción en ${state.preview.tenant_name}.`}
            </p>
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Ir a Trivu
            </button>
          </>
        )}

        {state.kind === "err" && (
          <p className="text-sm text-rose-700">{state.message}</p>
        )}
      </div>
    </main>
  );
}

function labelForStatus(s: string): string {
  return (
    {
      accepted: "aceptada",
      declined: "rechazada",
      cancelled: "cancelada por el admin",
      expired: "caducada",
    } as Record<string, string>
  )[s] ?? s;
}

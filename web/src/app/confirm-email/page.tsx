"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, getToken } from "@/lib/api";

// Next 14 requires anything calling useSearchParams() to live under
// a <Suspense> boundary so the static prerender pass can bail
// cleanly. The page export wraps the real component for that
// reason.
export default function ConfirmEmailPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
          <p className="text-sm text-gray-500">Cargando…</p>
        </main>
      }
    >
      <ConfirmEmailInner />
    </Suspense>
  );
}

/**
 * Landing page for two related email confirmation flows.
 *
 * 1. `kind=verify` — signup verification. The token alone is proof
 *    the recipient controls the mailbox; no logged-in session is
 *    required (the user may be reading on a phone, signed up on
 *    a laptop). Marks person.email_verified_at and clears the
 *    "verifica tu correo" banner.
 *
 * 2. `kind=change` (or omitted, legacy) — email-change confirmation.
 *    Requires BOTH the token AND a logged-in session matching the
 *    token's person_id, so a forwarded link alone can't hijack an
 *    account.
 */
function ConfirmEmailInner() {
  const router = useRouter();
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const kind = searchParams?.get("kind") === "verify" ? "verify" : "change";

  type State =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok_change"; email: string }
    | { kind: "ok_verify"; email: string }
    | { kind: "not_logged_in" }
    | { kind: "err"; message: string };
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (!token) {
      setState({
        kind: "err",
        message: "Falta el token de confirmación en el enlace.",
      });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    if (kind === "verify") {
      // Public endpoint. The token's signature proves address
      // ownership; no bearer required.
      api
        .verifyEmail(token)
        .then((person) => {
          if (cancelled) return;
          // If the user happens to also have a session in this
          // browser, refresh /me so the banner disappears.
          qc.invalidateQueries({ queryKey: ["me"] });
          setState({ kind: "ok_verify", email: person.email });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : "Error";
          setState({ kind: "err", message: msg });
        });
    } else {
      // Email-change confirmation needs the active session matching
      // the token's person_id. If we're not logged in, prompt and
      // bail rather than calling the API and showing a confusing 401.
      if (!getToken()) {
        setState({ kind: "not_logged_in" });
        return;
      }
      api
        .confirmEmailChange(token)
        .then((person) => {
          if (cancelled) return;
          qc.invalidateQueries({ queryKey: ["me"] });
          setState({ kind: "ok_change", email: person.email });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : "Error";
          setState({ kind: "err", message: msg });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [token, kind, qc]);

  const title =
    kind === "verify" ? "Verifica tu email" : "Confirmar nuevo email";

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">{title}</h1>

        {state.kind === "loading" && (
          <p className="text-sm text-gray-600">Verificando enlace…</p>
        )}

        {state.kind === "ok_change" && (
          <>
            <p className="text-sm text-emerald-700">
              Tu email se ha actualizado a{" "}
              <span className="font-medium">{state.email}</span>.
            </p>
            <button
              type="button"
              onClick={() => router.push("/me/settings")}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Ir a mi configuración
            </button>
          </>
        )}

        {state.kind === "ok_verify" && (
          <>
            <p className="text-sm text-emerald-700">
              Tu email{" "}
              <span className="font-medium">{state.email}</span> ha
              sido verificado. Ya puedes seguir usando Trivu con
              normalidad.
            </p>
            <button
              type="button"
              onClick={() =>
                router.push(getToken() ? "/admin" : "/login")
              }
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              {getToken() ? "Ir al panel" : "Iniciar sesión"}
            </button>
          </>
        )}

        {state.kind === "not_logged_in" && (
          <>
            <p className="text-sm text-gray-700">
              Para terminar de cambiar el email necesitas iniciar sesión
              con la cuenta que solicitó el cambio. Después te
              devolveremos aquí automáticamente.
            </p>
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Inicia sesión
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

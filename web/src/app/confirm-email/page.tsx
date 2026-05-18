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
 * Landing page for the email-change confirmation link sent to the
 * NEW address. The token in the URL proves the recipient controls
 * that address; the API additionally requires an authenticated
 * session matching the token's person_id so a forwarded link alone
 * can't be used to hijack the account.
 *
 * UX states:
 * - LOADING: token present, calling the API.
 * - SUCCESS: email swapped, brief message + link to /me/settings.
 * - NOT_LOGGED_IN: the user reached the link from a browser without
 *   a session — show a "Inicia sesión" button that bounces to
 *   /login and back here afterwards.
 * - ERROR: 400/403/409 from the API — show the server message.
 */
function ConfirmEmailInner() {
  const router = useRouter();
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  type State =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; email: string }
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
    if (!getToken()) {
      setState({ kind: "not_logged_in" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .confirmEmailChange(token)
      .then((person) => {
        if (cancelled) return;
        // Invalidate /me so the new email shows up in the sidebar +
        // settings card without a full reload.
        qc.invalidateQueries({ queryKey: ["me"] });
        setState({ kind: "ok", email: person.email });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Error";
        setState({ kind: "err", message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [token, qc]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">
          Confirmar nuevo email
        </h1>

        {state.kind === "loading" && (
          <p className="text-sm text-gray-600">Verificando enlace…</p>
        )}

        {state.kind === "ok" && (
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

        {state.kind === "not_logged_in" && (
          <>
            <p className="text-sm text-gray-700">
              Para terminar de cambiar el email necesitas iniciar sesión
              con la cuenta que solicitó el cambio. Después te
              devolveremos aquí automáticamente.
            </p>
            <button
              type="button"
              onClick={() => {
                // Stash the current URL so the login flow can bounce
                // us back. Login itself doesn't currently honour a
                // "next" parameter; we just send the user to the
                // login page and ask them to reopen the email link
                // after.
                router.push("/login");
              }}
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

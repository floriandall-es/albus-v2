"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, setToken } from "@/lib/api";
import { Button, ErrorText, TextField } from "@/components/admin/ui";
import { CARGO_OPTIONS } from "@/components/settings/profile-cards";

export default function AcceptInvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token ?? "";

  const preview = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => api.getInvitationByToken(token),
    retry: false,
    enabled: !!token,
  });

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [prefillDone, setPrefillDone] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  // Billing chunk 8. Null until the invitee picks under
  // members_pay — we gate submit on a non-null value so they
  // can't accidentally skip the question. Under team_pays the
  // picker is hidden entirely and submit ignores this value.
  const [startTrial, setStartTrial] = useState<boolean | null>(null);
  // Optional cargos picked at first activation — same UI as the
  // settings page. Empty by default; the invitee can pick zero,
  // one, or several. Backend treats omission as "leave alone"
  // and empty array as "clear", but on first-time activation
  // the field is empty anyway so both behave the same.
  const [cargos, setCargos] = useState<string[]>([]);
  function toggleCargo(value: string) {
    setCargos((prev) =>
      prev.includes(value)
        ? prev.filter((c) => c !== value)
        : [...prev, value],
    );
  }

  // When preview loads, prefill the name fields. Prefer the
  // structured first_name + last_name from the underlying Person
  // row (present for pendiente migrated users and cross-tenant
  // invitees). Fall back to splitting person_name on whitespace
  // only when no structured fields are available — and even then,
  // if the composite is a single token, treat it as the LAST name
  // (more common than first-name-only and matches the legacy CSV
  // shape we see).
  if (preview.data && !prefillDone) {
    const { first_name, last_name, person_name } = preview.data;
    if (first_name !== null || last_name !== null) {
      setFirstName(first_name ?? "");
      setLastName(last_name ?? "");
    } else {
      const tokens = person_name.trim().split(/\s+/);
      if (tokens.length >= 2) {
        setFirstName(tokens[0] ?? "");
        setLastName(tokens.slice(1).join(" "));
      } else {
        setFirstName("");
        setLastName(tokens[0] ?? "");
      }
    }
    setPrefillDone(true);
  }

  const accept = useMutation({
    mutationFn: () =>
      api.acceptInvitation(token, {
        password,
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        // Only send cargos when the user actually picked at least
        // one — sending an empty array would be interpreted as
        // "clear" on cross-tenant accepts (which already ignore
        // it server-side, but no point sending noise).
        cargos: cargos.length > 0 ? cargos : undefined,
        accept_terms: acceptTerms,
        // Billing chunk 8. Only send when the picker is active
        // (members_pay) AND the invitee chose. Under team_pays
        // the server flips the invitee to 'active' regardless,
        // so this field is meaningless.
        start_trial:
          preview.data?.tenant_billing_model === "members_pay"
            && startTrial !== null
            ? startTrial
            : undefined,
      }),
    onSuccess: (data) => {
      setToken(data.access_token);
      router.replace("/me");
    },
  });

  if (preview.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Cargando invitación…</div>;
  }
  if (preview.isError) {
    return (
      <div className="p-8 max-w-md mx-auto">
        <h1 className="text-xl font-semibold mb-2">Invitación no válida</h1>
        <p className="text-sm text-gray-600">
          Este enlace no existe, ha caducado o ya se utilizó. Pide a quien te invitó que
          genere uno nuevo.
        </p>
      </div>
    );
  }

  const inv = preview.data!;
  const passwordsMatch = password === confirm;
  // Under members_pay we require the invitee to pick a trial
  // option explicitly — the question is too important to default-
  // through. Under team_pays the picker doesn't render and the
  // value stays null without blocking submit.
  const needsTrialPick = inv.tenant_billing_model === "members_pay";
  const canSubmit =
    password.length >= 8
    && passwordsMatch
    && acceptTerms
    && (!needsTrialPick || startTrial !== null)
    && !accept.isPending;

  return (
    <div className="p-8 max-w-md mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Únete a {inv.tenant_name}</h1>
      <p className="text-sm text-gray-600 mb-6">
        Has sido invitado a {inv.tenant_name} con el email <strong>{inv.email}</strong>.
        Configura tu contraseña para entrar.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) accept.mutate();
        }}
      >
        <TextField
          label="Tu nombre"
          value={firstName}
          onChange={setFirstName}
          required
          autoComplete="given-name"
          name="given-name"
        />
        <TextField
          label="Apellidos"
          value={lastName}
          onChange={setLastName}
          required
          autoComplete="family-name"
          name="family-name"
        />
        <div>
          <span className="text-sm font-medium text-gray-700">
            Cargo <span className="font-normal text-gray-400">(opcional)</span>
          </span>
          <p className="mt-1 mb-2 text-xs text-gray-500">
            Marca los cargos que ocupes. Aparecen como etiquetas
            en tu tarjeta del directorio del hospital. Puedes
            cambiarlo más tarde en tu cuenta.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {CARGO_OPTIONS.map((opt) => {
              const checked = cargos.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggleCargo(opt)}
                  aria-pressed={checked}
                  className={
                    // Filled pill when active so the selection
                    // reads as obvious — the previous brand-50
                    // tint was nearly invisible against a white
                    // form, especially on pale accents.
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors "
                    + (checked
                      ? "border-brand-600 bg-brand-600 text-white hover:bg-brand-700"
                      : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50")
                  }
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
        <TextField
          label="Contraseña (mínimo 8 caracteres)"
          type="password"
          value={password}
          onChange={setPassword}
          required
          autoComplete="new-password"
          name="new-password"
        />
        <TextField
          label="Confirmar contraseña"
          type="password"
          value={confirm}
          onChange={setConfirm}
          required
          autoComplete="new-password"
          name="confirm-password"
        />
        {!passwordsMatch && confirm.length > 0 && (
          <ErrorText>Las contraseñas no coinciden.</ErrorText>
        )}

        {/* Billing chunk 8. Under members_pay, the invitee chooses
            between starting a 30-day trial or staying on paper.
            Under team_pays we render a short courtesy note instead
            — the admin covers their access automatically. */}
        {inv.tenant_billing_model === "members_pay" && (
          <div className="rounded-md border border-gray-200 bg-gray-50/60 p-3">
            <div className="text-sm font-medium text-gray-800">
              Acceso a la app móvil
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Tu admin sigue imprimiendo la planificación, así que esto
              es opcional. Si quieres recibirla en el móvil con tus
              cambios y avisos, prueba 30 días gratis.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setStartTrial(true)}
                aria-pressed={startTrial === true}
                className={
                  "text-left rounded-md border p-3 transition-colors "
                  + (startTrial === true
                    ? "border-brand-500 ring-2 ring-brand-500/30 bg-brand-50/40"
                    : "border-gray-200 bg-white hover:bg-gray-50")
                }
              >
                <div className="text-sm font-semibold text-gray-900">
                  Probar 30 días gratis
                </div>
                <div className="mt-1 text-xs text-gray-600">
                  Sin tarjeta. Luego 4,90 €/mes si decides quedarte.
                </div>
              </button>
              <button
                type="button"
                onClick={() => setStartTrial(false)}
                aria-pressed={startTrial === false}
                className={
                  "text-left rounded-md border p-3 transition-colors "
                  + (startTrial === false
                    ? "border-gray-400 ring-2 ring-gray-300 bg-white"
                    : "border-gray-200 bg-white hover:bg-gray-50")
                }
              >
                <div className="text-sm font-semibold text-gray-900">
                  No, gracias — seguiré en papel
                </div>
                <div className="mt-1 text-xs text-gray-600">
                  Puedes activarlo más tarde desde tu cuenta.
                </div>
              </button>
            </div>
          </div>
        )}
        {inv.tenant_billing_model === "team_pays" && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-900">
            <div className="font-medium">
              Tu equipo paga tu acceso a la app
            </div>
            <p className="mt-1 text-xs text-emerald-800">
              No tienes que hacer nada — al aceptar la invitación
              entrarás en la app directamente.
            </p>
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
            required
            className="mt-0.5 shrink-0"
          />
          <span>
            Acepto los{" "}
            <Link
              href="/terms"
              target="_blank"
              className="text-brand-700 hover:underline"
            >
              términos y condiciones
            </Link>{" "}
            y la{" "}
            <Link
              href="/privacy"
              target="_blank"
              className="text-brand-700 hover:underline"
            >
              política de privacidad
            </Link>
            .
          </span>
        </label>
        {accept.isError && <ErrorText>{(accept.error as Error).message}</ErrorText>}
        <Button type="submit" disabled={!canSubmit}>
          {accept.isPending ? "Aceptando…" : "Aceptar invitación"}
        </Button>
      </form>
    </div>
  );
}

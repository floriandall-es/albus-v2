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
  const canSubmit =
    password.length >= 8
    && passwordsMatch
    && acceptTerms
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
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors "
                    + (checked
                      ? "border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100"
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

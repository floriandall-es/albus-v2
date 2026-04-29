"use client";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, setToken } from "@/lib/api";
import { Button, ErrorText, TextField } from "@/components/admin/ui";

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

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // When preview loads, prefill name
  if (preview.data && name === "") {
    setName(preview.data.person_name);
  }

  const accept = useMutation({
    mutationFn: () =>
      api.acceptInvitation(token, {
        password,
        person_name: name || undefined,
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
  const canSubmit = password.length >= 8 && passwordsMatch && !accept.isPending;

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
        <TextField label="Tu nombre" value={name} onChange={setName} required />
        <TextField
          label="Contraseña (mínimo 8 caracteres)"
          type="password"
          value={password}
          onChange={setPassword}
          required
        />
        <TextField
          label="Confirmar contraseña"
          type="password"
          value={confirm}
          onChange={setConfirm}
          required
        />
        {!passwordsMatch && confirm.length > 0 && (
          <ErrorText>Las contraseñas no coinciden.</ErrorText>
        )}
        {accept.isError && <ErrorText>{(accept.error as Error).message}</ErrorText>}
        <Button type="submit" disabled={!canSubmit}>
          {accept.isPending ? "Aceptando…" : "Aceptar invitación"}
        </Button>
      </form>
    </div>
  );
}

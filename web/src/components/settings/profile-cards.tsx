"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  ErrorText,
  TextField,
} from "@/components/admin/ui";

// Three independent settings cards — profile / email / password — that
// both /admin/settings and /me/settings render. Both routes call the same
// /api/me/* endpoints (they act on ctx.person, the logged-in user).
export function ProfileCards() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  if (me.isLoading) return <p className="text-sm text-gray-500">Cargando…</p>;
  if (me.isError) return <ErrorText>{(me.error as Error).message}</ErrorText>;
  if (!me.data) return null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["me"] });

  return (
    <div className="space-y-6 max-w-xl">
      <ProfileSection
        initialName={me.data.person.name}
        onSaved={invalidate}
      />
      <EmailSection
        initialEmail={me.data.person.email}
        onSaved={invalidate}
      />
      <PasswordSection />
    </div>
  );
}

function ProfileSection({
  initialName,
  onSaved,
}: {
  initialName: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  useEffect(() => {
    setName(initialName);
  }, [initialName]);

  const save = useMutation({
    mutationFn: () => api.updateProfile({ name: name.trim() }),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Nombre actualizado." });
      onSaved();
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });

  return (
    <Card>
      <form
        className="p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          save.mutate();
        }}
      >
        <h2 className="text-sm font-semibold text-gray-700">Perfil</h2>
        <TextField label="Nombre" value={name} onChange={setName} required />
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={save.isPending || name.trim() === initialName}
          >
            {save.isPending ? "Guardando…" : "Guardar nombre"}
          </Button>
          {msg && (
            <span
              className={
                "text-xs " +
                (msg.kind === "ok" ? "text-emerald-700" : "text-red-700")
              }
            >
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function EmailSection({
  initialEmail,
  onSaved,
}: {
  initialEmail: string;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [pwd, setPwd] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  useEffect(() => {
    setEmail(initialEmail);
  }, [initialEmail]);

  const save = useMutation({
    mutationFn: () =>
      api.changeEmail({
        current_password: pwd,
        new_email: email.trim().toLowerCase(),
      }),
    onSuccess: () => {
      setPwd("");
      setMsg({ kind: "ok", text: "Email actualizado." });
      onSaved();
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });

  return (
    <Card>
      <form
        className="p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          save.mutate();
        }}
      >
        <h2 className="text-sm font-semibold text-gray-700">Email</h2>
        <p className="text-xs text-gray-500">
          Necesitas confirmar tu contraseña actual para cambiar el email.
        </p>
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required
        />
        <TextField
          label="Contraseña actual"
          type="password"
          value={pwd}
          onChange={setPwd}
          required
        />
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={
              save.isPending
              || email.trim().toLowerCase() === initialEmail
              || pwd.length === 0
            }
          >
            {save.isPending ? "Guardando…" : "Cambiar email"}
          </Button>
          {msg && (
            <span
              className={
                "text-xs " +
                (msg.kind === "ok" ? "text-emerald-700" : "text-red-700")
              }
            >
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const save = useMutation({
    mutationFn: () =>
      api.changePassword({
        current_password: current,
        new_password: next,
      }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ kind: "ok", text: "Contraseña actualizada." });
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <Card>
      <form
        className="p-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setMsg(null);
          if (next !== confirm) {
            setMsg({ kind: "err", text: "Las contraseñas no coinciden." });
            return;
          }
          save.mutate();
        }}
      >
        <h2 className="text-sm font-semibold text-gray-700">Contraseña</h2>
        <TextField
          label="Contraseña actual"
          type="password"
          value={current}
          onChange={setCurrent}
          required
        />
        <TextField
          label="Contraseña nueva"
          type="password"
          value={next}
          onChange={setNext}
          required
        />
        {tooShort && (
          <p className="text-xs text-red-700">Mínimo 8 caracteres.</p>
        )}
        <TextField
          label="Confirmar contraseña nueva"
          type="password"
          value={confirm}
          onChange={setConfirm}
          required
        />
        {mismatch && (
          <p className="text-xs text-red-700">Las contraseñas no coinciden.</p>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={
              save.isPending
              || current.length === 0
              || next.length < 8
              || next !== confirm
            }
          >
            {save.isPending ? "Guardando…" : "Cambiar contraseña"}
          </Button>
          {msg && (
            <span
              className={
                "text-xs " +
                (msg.kind === "ok" ? "text-emerald-700" : "text-red-700")
              }
            >
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

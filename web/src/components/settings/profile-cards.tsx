"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, avatarSrc } from "@/lib/api";
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
      <AvatarSection
        name={me.data.person.name}
        avatarUrl={me.data.person.avatar_url}
        onSaved={invalidate}
      />
      <ProfileSection
        initialName={me.data.person.name}
        initialFirstName={me.data.person.first_name}
        initialLastName={me.data.person.last_name}
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

function AvatarSection({
  name,
  avatarUrl,
  onSaved,
}: {
  name: string;
  avatarUrl: string | null;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadAvatar(file),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Foto actualizada." });
      onSaved();
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAvatar(),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Foto eliminada." });
      onSaved();
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });

  // Initials fallback when there's no photo. Same logic as the planning
  // grid avatar so the look is consistent.
  const initial = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  const src = avatarSrc(avatarUrl);

  return (
    <Card>
      <div className="p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">
          Foto de perfil
        </h2>
        <div className="flex items-center gap-4">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              className="h-16 w-16 rounded-full object-cover ring-1 ring-gray-200"
            />
          ) : (
            <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-lg font-semibold ring-1 ring-gray-200">
              {initial || "?"}
            </span>
          )}
          <div className="flex flex-col gap-2 text-sm">
            <div className="text-xs text-gray-500">
              JPEG, PNG o WebP. Máximo 5 MB. La imagen se recortará a un
              cuadrado y se redimensionará a 128×128.
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => fileRef.current?.click()}
                disabled={upload.isPending}
              >
                {upload.isPending ? "Subiendo…" : src ? "Cambiar" : "Subir foto"}
              </Button>
              {src && (
                <Button
                  variant="danger"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Eliminar
                </Button>
              )}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setMsg(null);
              upload.mutate(f);
              // Reset so picking the same file twice still fires onChange.
              e.target.value = "";
            }}
          />
        </div>
        {msg && (
          <p
            className={
              "text-xs " +
              (msg.kind === "ok" ? "text-emerald-700" : "text-red-700")
            }
          >
            {msg.text}
          </p>
        )}
      </div>
    </Card>
  );
}

function ProfileSection({
  initialName,
  initialFirstName,
  initialLastName,
  onSaved,
}: {
  initialName: string;
  initialFirstName: string | null;
  initialLastName: string | null;
  onSaved: () => void;
}) {
  // Sprint 18: split-name fields. The legacy single `name` is kept
  // in the response for backward compatibility but the form
  // collects first + last. The server composes `name` server-side
  // from the two parts.
  const [firstName, setFirstName] = useState(initialFirstName ?? "");
  const [lastName, setLastName] = useState(initialLastName ?? "");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  useEffect(() => {
    setFirstName(initialFirstName ?? "");
    setLastName(initialLastName ?? "");
  }, [initialFirstName, initialLastName]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      }),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Nombre actualizado." });
      onSaved();
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });

  const dirty =
    firstName.trim() !== (initialFirstName ?? "").trim()
    || lastName.trim() !== (initialLastName ?? "").trim();

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
        {!initialFirstName && !initialLastName && (
          <p className="text-xs text-gray-500">
            Estás registrado como <span className="font-medium">{initialName}</span>.
            Indica nombre y apellidos por separado para que el sistema pueda
            saludarte por tu nombre y mostrar tus apellidos en la
            planificación.
          </p>
        )}
        <TextField
          label="Nombre"
          value={firstName}
          onChange={setFirstName}
          required
        />
        <TextField
          label="Apellidos"
          value={lastName}
          onChange={setLastName}
          required
        />
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={
              save.isPending
              || !dirty
              || firstName.trim().length === 0
              || lastName.trim().length === 0
            }
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
    onSuccess: (resp) => {
      setPwd("");
      setMsg({
        kind: "ok",
        text:
          `Te hemos enviado un correo de verificación a ${resp.sent_to}. `
          + `Confirma desde el enlace para aplicar el cambio. El email actual `
          + `seguirá activo hasta entonces.`,
      });
      // Reset the form field back to the current email so the UI
      // reflects that no swap has happened yet.
      setEmail(initialEmail);
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
        </div>
        {msg && (
          <p
            className={
              "text-xs leading-relaxed " +
              (msg.kind === "ok" ? "text-emerald-700" : "text-red-700")
            }
          >
            {msg.text}
          </p>
        )}
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
          // Client-side guards mirror the API constraints so the user
          // never sees the raw Pydantic 422. Order matters: the empty
          // / length checks fire before the mismatch check because
          // showing "must be 8 chars" is more actionable than
          // "passwords don't match" when the user is still typing.
          if (current.length === 0) {
            setMsg({ kind: "err", text: "Introduce tu contraseña actual." });
            return;
          }
          if (next.length < 8) {
            setMsg({
              kind: "err",
              text: "La contraseña nueva debe tener al menos 8 caracteres.",
            });
            return;
          }
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

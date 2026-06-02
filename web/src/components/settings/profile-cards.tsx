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
import {
  ACCENT_COOKIE,
  ACCENT_PRESETS,
  type AccentName,
  accentCssEntries,
  accentHex,
  resolveAccent,
} from "@/lib/accent";

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
        initialCargos={me.data.person.cargos}
        onSaved={invalidate}
      />
      <EmailSection
        initialEmail={me.data.person.email}
        onSaved={invalidate}
      />
      {/* Hospital directory opt-out — only renders when the
          tenant has a parent hospital. Standalone tenants don't
          have a directory to opt out of. */}
      {me.data.current_tenant.hospital_id != null && (
        <>
          <DirectoryVisibilitySection
            hospitalName={me.data.current_tenant.hospital_name}
            currentValue={
              me.data.memberships.find(
                (m) => m.tenant_id === me.data.current_tenant.id,
              )?.directory_visible ?? true
            }
            onSaved={invalidate}
          />
          <ContactChannelsSection
            initialWorkPhone={me.data.person.work_phone}
            initialPersonalPhone={me.data.person.personal_phone}
            currentMembership={
              me.data.memberships.find(
                (m) => m.tenant_id === me.data.current_tenant.id,
              ) ?? null
            }
            onSaved={invalidate}
          />
        </>
      )}
      <AppearanceSection
        currentAccent={me.data.person.preferred_accent}
        onSaved={invalidate}
      />
      <PasswordSection />
    </div>
  );
}

/** Per-user accent picker (migration 0065). Renders a swatch grid;
 * clicking one writes the cookie + sets CSS variables on
 * documentElement immediately (instant feedback) and fires the
 * API call in the background. We don't gate the visual change on
 * the API success — if the network hiccups we still optimistically
 * apply locally and let the next /me reconcile. */
function AppearanceSection({
  currentAccent,
  onSaved,
}: {
  currentAccent: string;
  onSaved: () => void;
}) {
  const initial = resolveAccent(currentAccent);
  const [selected, setSelected] = useState<AccentName>(initial);
  // Re-sync if the parent /me query refreshes with a different value
  // (e.g. user changed it on another device).
  useEffect(() => {
    setSelected(resolveAccent(currentAccent));
  }, [currentAccent]);

  const save = useMutation({
    mutationFn: (next: AccentName) =>
      api.updateAppearance({ preferred_accent: next }),
    onSuccess: () => {
      onSaved();
    },
  });

  const pick = (next: AccentName) => {
    if (next === selected) return;
    setSelected(next);
    // Cookie: max-age = 1 year. SameSite=Lax so it travels on
    // top-level navigations (the SSR layout reads it). Not HttpOnly
    // — the client also reads it as a fallback. Path=/ so every
    // route gets the value.
    if (typeof document !== "undefined") {
      document.cookie =
        `${ACCENT_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
      // Apply locally NOW so the rest of the page repaints without
      // waiting for a navigation.
      for (const [prop, value] of accentCssEntries(next)) {
        document.documentElement.style.setProperty(prop, value);
      }
    }
    save.mutate(next);
  };

  return (
    <Card>
      <div className="p-4 space-y-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            Apariencia
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Personaliza el color de acento. Afecta a botones,
            iconos y al resaltado de tus turnos.
          </p>
        </div>
        <div role="radiogroup" aria-label="Color de acento">
          <ul className="grid grid-cols-4 gap-3 sm:grid-cols-6">
            {(Object.keys(ACCENT_PRESETS) as AccentName[]).map((key) => {
              const preset = ACCENT_PRESETS[key];
              const isSelected = key === selected;
              const swatchColor = accentHex(key, 600);
              const ringColor = accentHex(key, 700);
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={preset.label}
                    title={preset.label}
                    onClick={() => pick(key)}
                    className={
                      "group relative flex h-12 w-full items-center justify-center rounded-lg "
                      + "ring-1 ring-inset ring-black/5 transition "
                      + "hover:scale-[1.03] focus:outline-none focus-visible:ring-2"
                    }
                    style={{
                      backgroundColor: swatchColor,
                      boxShadow: isSelected
                        ? `0 0 0 2px white inset, 0 0 0 4px ${ringColor}`
                        : undefined,
                    }}
                  >
                    {isSelected && (
                      <CheckIcon className="h-5 w-5 text-white drop-shadow-sm" />
                    )}
                  </button>
                  <div
                    className={
                      "mt-1 text-center text-[11px] "
                      + (isSelected
                        ? "font-semibold text-gray-900"
                        : "text-gray-500")
                    }
                  >
                    {preset.label}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        {save.isError && (
          <ErrorText>
            No se ha podido guardar la preferencia. Cambia de color
            otra vez para reintentar.
          </ErrorText>
        )}
      </div>
    </Card>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 010 1.42l-7.997 7.997a1 1 0 01-1.42 0L3.296 10.71a1 1 0 011.42-1.42L8 12.578l7.286-7.286a1 1 0 011.418 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DirectoryVisibilitySection({
  hospitalName,
  currentValue,
  onSaved,
}: {
  hospitalName: string | null;
  currentValue: boolean;
  onSaved: () => void;
}) {
  const save = useMutation({
    mutationFn: (next: boolean) => api.setMyDirectoryVisibility(next),
    onSuccess: onSaved,
  });
  return (
    <Card>
      <div className="p-5">
        <h3 className="text-sm font-semibold text-gray-900">
          Directorio del hospital
        </h3>
        <p className="mt-1 text-xs text-gray-500">
          Cuando está activado, otros profesionales de
          {hospitalName ? ` ${hospitalName}` : " tu hospital"} pueden
          encontrarte por nombre o cargo en el directorio. Es recíproco:
          si lo desactivas no aparecerás, pero tampoco podrás ver el
          directorio del resto.
        </p>
        <label className="mt-3 inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={currentValue}
            onChange={(e) => save.mutate(e.target.checked)}
            disabled={save.isPending}
            className="h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm text-gray-800">
            Aparezco en el directorio
          </span>
        </label>
        {save.isError && (
          <p className="mt-2 text-xs text-rose-700">
            {(save.error as Error).message}
          </p>
        )}
      </div>
    </Card>
  );
}

/** Migration 0057. Two free-format phone fields (work + personal)
 * plus four per-channel opt-ins (work phone, personal phone, email,
 * WhatsApp). WhatsApp is always tied to the personal phone — the
 * toggle is disabled unless a personal phone is on file. The
 * directory card renders one button per enabled channel; this card
 * is what makes those buttons appear. */
function ContactChannelsSection({
  initialWorkPhone,
  initialPersonalPhone,
  currentMembership,
  onSaved,
}: {
  initialWorkPhone: string | null;
  initialPersonalPhone: string | null;
  currentMembership: {
    share_work_phone: boolean;
    share_personal_phone: boolean;
    share_email: boolean;
    share_whatsapp: boolean;
  } | null;
  onSaved: () => void;
}) {
  const qc = useQueryClient();

  const shareWorkPhone = currentMembership?.share_work_phone ?? false;
  const sharePersonalPhone =
    currentMembership?.share_personal_phone ?? false;
  const shareEmail = currentMembership?.share_email ?? false;
  const shareWhatsapp = currentMembership?.share_whatsapp ?? false;

  const setPref = useMutation({
    mutationFn: (
      body: Parameters<typeof api.setMyContactPreferences>[0],
    ) => api.setMyContactPreferences(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  return (
    <Card>
      <div className="p-5 space-y-5">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">
            Cómo me pueden contactar
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            Lo que esté activo aquí aparece en tu tarjeta del directorio.
            Tu email se muestra por defecto — los teléfonos y WhatsApp
            sólo si los activas. WhatsApp se enlaza al teléfono personal.
          </p>
        </div>
        <PhoneField
          label="Teléfono de trabajo"
          help="Centralita, extensión, busca, número de guardia… Cualquier formato."
          initial={initialWorkPhone}
          onSaved={onSaved}
          fieldKey="work_phone"
        />
        <PhoneField
          label="Teléfono personal"
          help="Tu móvil personal. Si lo añades, podrás activar WhatsApp."
          initial={initialPersonalPhone}
          onSaved={onSaved}
          fieldKey="personal_phone"
        />
        <div className="space-y-2">
          <ChannelToggle
            label="Mostrar mi email en el directorio"
            checked={shareEmail}
            disabled={setPref.isPending}
            onChange={(v) => setPref.mutate({ share_email: v })}
          />
          <ChannelToggle
            label="Mostrar mi teléfono de trabajo en el directorio"
            checked={shareWorkPhone}
            disabled={
              setPref.isPending
              || (initialWorkPhone ?? "").trim() === ""
            }
            hint={
              (initialWorkPhone ?? "").trim() === ""
                ? "Añade un número de trabajo primero para activar este canal."
                : null
            }
            onChange={(v) => setPref.mutate({ share_work_phone: v })}
          />
          <ChannelToggle
            label="Mostrar mi teléfono personal en el directorio"
            checked={sharePersonalPhone}
            disabled={
              setPref.isPending
              || (initialPersonalPhone ?? "").trim() === ""
            }
            hint={
              (initialPersonalPhone ?? "").trim() === ""
                ? "Añade un número personal primero para activar este canal."
                : null
            }
            onChange={(v) => setPref.mutate({ share_personal_phone: v })}
          />
          <ChannelToggle
            label="Permitir contactarme por WhatsApp"
            checked={shareWhatsapp}
            disabled={
              setPref.isPending
              || (initialPersonalPhone ?? "").trim() === ""
            }
            hint={
              (initialPersonalPhone ?? "").trim() === ""
                ? "WhatsApp usa el teléfono personal — añádelo primero."
                : null
            }
            onChange={(v) => setPref.mutate({ share_whatsapp: v })}
          />
        </div>
        {setPref.isError && (
          <p className="text-xs text-rose-700">
            {(setPref.error as Error).message}
          </p>
        )}
      </div>
    </Card>
  );
}

/** Single phone input + Guardar button. Free format — backend
 * caps at 50 chars but otherwise accepts any string. Pass an empty
 * string to clear. Extracted so we can render two of them
 * (work + personal) without duplicating the local state plumbing. */
function PhoneField({
  label,
  help,
  initial,
  onSaved,
  fieldKey,
}: {
  label: string;
  help: string;
  initial: string | null;
  onSaved: () => void;
  /** Which API field this control writes to. The two phones use
   * the same updateProfile endpoint with distinct keys. */
  fieldKey: "work_phone" | "personal_phone";
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(initial ?? "");
  const [savedNote, setSavedNote] = useState<string | null>(null);
  useEffect(() => {
    setValue(initial ?? "");
  }, [initial]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({ [fieldKey]: value.trim() } as Parameters<
        typeof api.updateProfile
      >[0]),
    onSuccess: () => {
      setSavedNote("Guardado.");
      window.setTimeout(() => setSavedNote(null), 2000);
      qc.invalidateQueries({ queryKey: ["me"] });
      onSaved();
    },
  });

  const trimmed = value.trim();
  const dirty = trimmed !== (initial ?? "").trim();
  const tooLong = trimmed.length > 50;

  return (
    <div>
      <label className="block">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="tel"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="ej. +34 612 345 678"
            className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <Button
            onClick={() => save.mutate()}
            disabled={!dirty || tooLong || save.isPending}
          >
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-gray-500">{help}</p>
        {tooLong && (
          <p className="mt-1 text-xs text-rose-700">
            Máximo 50 caracteres.
          </p>
        )}
        {save.isError && (
          <p className="mt-1 text-xs text-rose-700">
            {(save.error as Error).message}
          </p>
        )}
        {savedNote && (
          <p className="mt-1 text-xs text-emerald-700">{savedNote}</p>
        )}
      </label>
    </div>
  );
}

function ChannelToggle({
  label,
  checked,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string | null;
  onChange: (v: boolean) => void;
}) {
  return (
    <div>
      <label
        className={
          "inline-flex items-center gap-2 " +
          (disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")
        }
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <span className="text-sm text-gray-800">{label}</span>
      </label>
      {hint && <p className="ml-6 text-xs text-gray-500">{hint}</p>}
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

/** Hard-coded list of common Spanish hospital cargos. Generic
 * masculine / gender-neutral forms — Spanish workplace convention
 * for formal job titles. If a real customer needs a different
 * label, we can add it here without a migration; the column is
 * free text.
 *
 * Exported so the invite-accept page (/invite/[token]) can offer
 * the same multi-select on first-time activation without
 * duplicating the list. */
// Inclusive forms (`/a`) match the style of every other gendered
// label in the app — categorías de onboarding, enfermería, etc.
// Backend matchers (e.g. _person_is_jefe_de_servicio in
// availability.py) accept both the old and new forms so users
// who picked the masculine variants before this rename don't
// lose their gating.
export const CARGO_OPTIONS = [
  "Jefe/a de Servicio",
  "Jefe/a de Sección",
  "Adjunto/a",
  "Tutor/a de Residentes",
  "Residente",
  "Rotante Externo",
  "Profesor/a",
  "Investigador/a",
  "Becario/a",
];

function ProfileSection({
  initialName,
  initialFirstName,
  initialLastName,
  initialCargos,
  onSaved,
}: {
  initialName: string;
  initialFirstName: string | null;
  initialLastName: string | null;
  /** Migration 0061: list of free-text job titles shown on the
   * hospital directory card. Independent of the scheduling
   * categoría (the admin still controls that on /admin/team). */
  initialCargos: string[];
  onSaved: () => void;
}) {
  // Sprint 18: split-name fields. The legacy single `name` is kept
  // in the response for backward compatibility but the form
  // collects first + last. The server composes `name` server-side
  // from the two parts.
  const [firstName, setFirstName] = useState(initialFirstName ?? "");
  const [lastName, setLastName] = useState(initialLastName ?? "");
  const [cargos, setCargos] = useState<string[]>(initialCargos);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  useEffect(() => {
    setFirstName(initialFirstName ?? "");
    setLastName(initialLastName ?? "");
    setCargos(initialCargos);
  }, [initialFirstName, initialLastName, initialCargos]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        cargos,
      }),
    onSuccess: () => {
      setMsg({ kind: "ok", text: "Perfil actualizado." });
      onSaved();
    },
    onError: (e) =>
      setMsg({ kind: "err", text: (e as Error).message ?? "Error" }),
  });

  // Set-equal compare for the cargos array (order-insensitive
  // since the chip layout doesn't expose a user-visible order).
  const cargosDirty = (() => {
    if (cargos.length !== initialCargos.length) return true;
    const a = new Set(cargos);
    return initialCargos.some((c) => !a.has(c));
  })();
  const dirty =
    firstName.trim() !== (initialFirstName ?? "").trim()
    || lastName.trim() !== (initialLastName ?? "").trim()
    || cargosDirty;

  function toggleCargo(value: string) {
    setCargos((prev) =>
      prev.includes(value)
        ? prev.filter((c) => c !== value)
        : [...prev, value],
    );
  }

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
        <div>
          <span className="text-sm font-medium text-gray-700">
            Cargo
          </span>
          <p className="mt-1 mb-2 text-xs text-gray-500">
            Marca todos los cargos que ocupes. Aparecen como
            etiquetas en tu tarjeta del <strong>Directorio del
            hospital</strong> — no afectan cómo se reparten los
            turnos (eso lo controla tu categoría, que asigna el
            administrador).
          </p>
          <div className="flex flex-wrap gap-1.5">
            {/*
              Render the canonical CARGO_OPTIONS first, then append
              any saved cargos the user already has that aren't in
              the current list — keeps "legacy" values (renamed
              defaults, deprecated chips) togglable so the user
              can always untoggle them. The extras come at the end
              so the predefined list stays visually consistent.
            */}
            {[
              ...CARGO_OPTIONS,
              ...cargos.filter((c) => !CARGO_OPTIONS.includes(c)),
            ].map((opt) => {
              const checked = cargos.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggleCargo(opt)}
                  aria-pressed={checked}
                  className={
                    // Filled pill when active so the selection
                    // reads as obvious — matches the invite
                    // flow's cargo picker (kept in lockstep so
                    // the same control feels the same in both
                    // places).
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
            {save.isPending ? "Guardando…" : "Guardar perfil"}
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

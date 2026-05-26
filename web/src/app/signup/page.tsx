"use client";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, setToken, type PublicHospital, type PublicServicio } from "@/lib/api";

/**
 * /signup — Phase D.2 wizard. Four steps, anchored on the
 * Catálogo Nacional de Hospitales (CNH):
 *
 *   1. Persona       — name, email, password, ToS
 *   2. Hospital      — typeahead over the CNH-seeded list
 *   3. Servicio      — pick from existing servicios at the chosen
 *                      hospital, or name a new one
 *   4. Equipo        — name + confirm
 *
 * The hospital is REQUIRED and MUST come from the catalog. We no
 * longer accept free-text hospitals: that prevented bottom-up
 * adoption from drifting into "five different 'Hospital La Fe'
 * rows with slightly different spellings". Phase D.1's seed
 * script populates 848 hospitals.
 *
 * If the user picks an EXISTING servicio at step 3, their new
 * equipo lands with approval_state='pending' and won't show up
 * in the servicio's timeline / cross-equipo invites until a
 * sibling admin approves it. The wizard tells them this on
 * step 4 so it's not a surprise after signup.
 */

type Step = 1 | 2 | 3 | 4;

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);

  // Step 1 — Persona
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);

  // Step 2 — Hospital
  const [hospital, setHospital] = useState<PublicHospital | null>(null);

  // Step 3 — Servicio
  const [servicio, setServicio] = useState<PublicServicio | null>(null);
  const [newServicioName, setNewServicioName] = useState("");
  // null = no choice yet, 'existing' = join, 'new' = create. The
  // step 3 UI starts with no choice and reveals one branch on click.
  const [servicioMode, setServicioMode] = useState<"existing" | "new" | null>(
    null,
  );

  // Step 4 — Equipo
  const [equipoName, setEquipoName] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const personaValid =
    firstName.trim().length > 0
    && email.includes("@")
    && password.length >= 8
    && acceptTerms;

  async function onSubmit() {
    if (!hospital) return;
    setError(null);
    setSubmitting(true);
    try {
      const body: Parameters<typeof api.signup>[0] = {
        first_name: firstName.trim(),
        last_name: lastName.trim() || undefined,
        email: email.trim(),
        password,
        accept_terms: acceptTerms,
        hospital_id: hospital.id,
        equipo_name: equipoName.trim(),
      };
      if (servicioMode === "existing" && servicio) {
        body.servicio_id = servicio.id;
      } else if (servicioMode === "new") {
        body.servicio_name = newServicioName.trim();
      }
      const res = await api.signup(body);
      setToken(res.access_token);
      router.push("/onboarding");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido crear la cuenta");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <Image
            src="/logo.jpeg"
            alt="Trivu"
            width={96}
            height={96}
            priority
            className="h-20 w-20 rounded-2xl shadow-soft"
          />
          <div className="mt-3 text-2xl font-bold tracking-tight text-brand-700">
            Trivu
          </div>
        </div>

        <div className="rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-6">
          <StepHeader step={step} />

          {step === 1 && (
            <Step1Persona
              firstName={firstName}
              setFirstName={setFirstName}
              lastName={lastName}
              setLastName={setLastName}
              email={email}
              setEmail={setEmail}
              password={password}
              setPassword={setPassword}
              acceptTerms={acceptTerms}
              setAcceptTerms={setAcceptTerms}
              canContinue={personaValid}
              onContinue={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <Step2Hospital
              picked={hospital}
              setPicked={setHospital}
              onBack={() => setStep(1)}
              onContinue={() => {
                // Reset servicio choice when hospital changes — the
                // existing-servicio list belongs to a different
                // hospital and is meaningless once we cross over.
                setServicio(null);
                setServicioMode(null);
                setNewServicioName("");
                setStep(3);
              }}
            />
          )}

          {step === 3 && hospital && (
            <Step3Servicio
              hospital={hospital}
              mode={servicioMode}
              setMode={setServicioMode}
              picked={servicio}
              setPicked={setServicio}
              newName={newServicioName}
              setNewName={setNewServicioName}
              onBack={() => setStep(2)}
              onContinue={() => setStep(4)}
            />
          )}

          {step === 4 && hospital && (
            <Step4Equipo
              hospital={hospital}
              servicioMode={servicioMode}
              servicio={servicio}
              newServicioName={newServicioName}
              equipoName={equipoName}
              setEquipoName={setEquipoName}
              submitting={submitting}
              error={error}
              onBack={() => setStep(3)}
              onSubmit={onSubmit}
            />
          )}
        </div>

        <p className="mt-4 text-center text-sm text-gray-600">
          ¿Ya tienes cuenta?{" "}
          <a
            className="text-brand-700 font-medium hover:underline"
            href="/login"
          >
            Inicia sesión
          </a>
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Step header (progress dots + labels)
// ---------------------------------------------------------------------------

function StepHeader({ step }: { step: Step }) {
  const labels = ["Persona", "Hospital", "Servicio", "Equipo"];
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider">
        {labels.map((label, i) => {
          const n = (i + 1) as Step;
          const done = step > n;
          const active = step === n;
          return (
            <div key={label} className="flex flex-col items-center flex-1">
              <div
                className={
                  "flex h-6 w-6 items-center justify-center rounded-full text-[10px] "
                  + (active
                    ? "bg-brand-600 text-white"
                    : done
                      ? "bg-brand-100 text-brand-700"
                      : "bg-gray-200 text-gray-500")
                }
              >
                {done ? "✓" : n}
              </div>
              <div
                className={
                  "mt-1 text-center "
                  + (active ? "text-brand-700" : "text-gray-500")
                }
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Persona
// ---------------------------------------------------------------------------

function Step1Persona({
  firstName,
  setFirstName,
  lastName,
  setLastName,
  email,
  setEmail,
  password,
  setPassword,
  acceptTerms,
  setAcceptTerms,
  canContinue,
  onContinue,
}: {
  firstName: string;
  setFirstName: (v: string) => void;
  lastName: string;
  setLastName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  acceptTerms: boolean;
  setAcceptTerms: (v: boolean) => void;
  canContinue: boolean;
  onContinue: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canContinue) onContinue();
      }}
      className="space-y-4"
    >
      <Field
        label="Nombre"
        value={firstName}
        onChange={setFirstName}
        placeholder="ej. Gabriel"
        autoComplete="given-name"
        name="given-name"
      />
      <Field
        label="Apellidos"
        value={lastName}
        onChange={setLastName}
        placeholder="ej. Pérez García"
        autoComplete="family-name"
        name="family-name"
        required={false}
      />
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        name="email"
      />
      <Field
        label="Contraseña (mínimo 8 caracteres)"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        name="new-password"
      />
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
            términos
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
      <button
        type="submit"
        disabled={!canContinue}
        className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
      >
        Continuar
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Hospital (typeahead)
// ---------------------------------------------------------------------------

function Step2Hospital({
  picked,
  setPicked,
  onBack,
  onContinue,
}: {
  picked: PublicHospital | null;
  setPicked: (h: PublicHospital | null) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [query, setQuery] = useState(picked?.name ?? "");

  // Debounce the search to ~200ms so we don't fire a request per keystroke.
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const search = useQuery({
    queryKey: ["hospitals-search", debounced],
    queryFn: () => api.searchHospitals(debounced),
    enabled: debounced.trim().length >= 2,
  });

  return (
    <div className="space-y-4">
      <div>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            ¿En qué hospital trabajas?
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (picked) setPicked(null);
            }}
            placeholder="ej. La Fe"
            autoComplete="off"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <p className="mt-1 text-xs text-gray-500">
          Lista oficial del Ministerio de Sanidad. Empieza a escribir para buscar.
        </p>
      </div>

      {picked && (
        <div className="rounded-md border border-brand-300 bg-brand-50/40 p-3 text-sm">
          <div className="font-medium text-gray-900">{picked.name}</div>
          {picked.city && (
            <div className="text-xs text-gray-600">
              {picked.city}
              {picked.province && picked.province !== picked.city
                ? ` · ${picked.province}`
                : ""}
            </div>
          )}
        </div>
      )}

      {!picked && debounced.trim().length >= 2 && (
        <div className="max-h-56 overflow-y-auto rounded-md border border-gray-200">
          {search.isLoading && (
            <div className="px-3 py-2 text-xs text-gray-500">Buscando…</div>
          )}
          {search.data && search.data.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-500">
              No encuentro ningún hospital con ese nombre. Prueba con el
              nombre completo o la ciudad.
            </div>
          )}
          {search.data?.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                setPicked(h);
                setQuery(h.name);
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
            >
              <div className="font-medium text-gray-900">{h.name}</div>
              {h.city && (
                <div className="text-[11px] text-gray-500">
                  {h.city}
                  {h.province && h.province !== h.city
                    ? ` · ${h.province}`
                    : ""}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      <NavButtons
        onBack={onBack}
        onContinue={onContinue}
        canContinue={!!picked}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Servicio (existing or new)
// ---------------------------------------------------------------------------

function Step3Servicio({
  hospital,
  mode,
  setMode,
  picked,
  setPicked,
  newName,
  setNewName,
  onBack,
  onContinue,
}: {
  hospital: PublicHospital;
  mode: "existing" | "new" | null;
  setMode: (v: "existing" | "new" | null) => void;
  picked: PublicServicio | null;
  setPicked: (s: PublicServicio | null) => void;
  newName: string;
  setNewName: (v: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const existing = useQuery({
    queryKey: ["hospital-servicios", hospital.id],
    queryFn: () => api.listHospitalServicios(hospital.id),
  });

  const hasExisting = (existing.data?.length ?? 0) > 0;

  // If the hospital has zero approved servicios, default to "new" —
  // the user has no choice, and a button-less screen reads cleaner.
  useEffect(() => {
    if (existing.data && existing.data.length === 0 && mode === null) {
      setMode("new");
    }
  }, [existing.data, mode, setMode]);

  const canContinue = useMemo(() => {
    if (mode === "existing") return picked !== null;
    if (mode === "new") return newName.trim().length > 0;
    return false;
  }, [mode, picked, newName]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700">
        ¿A qué servicio del{" "}
        <span className="font-medium">{hospital.name}</span> perteneces?
      </p>

      {existing.isLoading && (
        <p className="text-xs text-gray-500">Cargando servicios…</p>
      )}

      {hasExisting && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-gray-500">
            Servicios existentes
          </div>
          {existing.data?.map((s) => (
            <label
              key={s.id}
              className={
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
                + (mode === "existing" && picked?.id === s.id
                  ? "border-brand-300 bg-brand-50/40"
                  : "border-gray-200 hover:bg-gray-50")
              }
            >
              <input
                type="radio"
                name="servicio-pick"
                checked={mode === "existing" && picked?.id === s.id}
                onChange={() => {
                  setMode("existing");
                  setPicked(s);
                  setNewName("");
                }}
                className="mt-1"
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">
                  {s.name}
                </div>
                <div className="mt-0.5 text-xs text-gray-600">
                  {s.approved_equipo_count} equipo
                  {s.approved_equipo_count === 1 ? "" : "s"} aprobado
                  {s.approved_equipo_count === 1 ? "" : "s"} · tu equipo
                  quedará pendiente de aprobación
                </div>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-gray-500">
          {hasExisting ? "O crea uno nuevo" : "Crea el primer servicio"}
        </div>
        <label
          className={
            "flex cursor-pointer items-start gap-3 rounded-md border p-3 "
            + (mode === "new"
              ? "border-brand-300 bg-brand-50/40"
              : "border-gray-200 hover:bg-gray-50")
          }
        >
          <input
            type="radio"
            name="servicio-pick"
            checked={mode === "new"}
            onChange={() => {
              setMode("new");
              setPicked(null);
            }}
            className="mt-1"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-900">
              Crear nuevo servicio
            </div>
            <div className="mt-0.5 text-xs text-gray-600">
              Tu equipo será el primero — quedará aprobado automáticamente.
            </div>
            {mode === "new" && (
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="ej. Cirugía Torácica"
                autoFocus
                className="mt-2 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:border-brand-500"
              />
            )}
          </div>
        </label>
      </div>

      <NavButtons
        onBack={onBack}
        onContinue={onContinue}
        canContinue={canContinue}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Equipo
// ---------------------------------------------------------------------------

function Step4Equipo({
  hospital,
  servicioMode,
  servicio,
  newServicioName,
  equipoName,
  setEquipoName,
  submitting,
  error,
  onBack,
  onSubmit,
}: {
  hospital: PublicHospital;
  servicioMode: "existing" | "new" | null;
  servicio: PublicServicio | null;
  newServicioName: string;
  equipoName: string;
  setEquipoName: (v: string) => void;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const willBePending =
    servicioMode === "existing" && (servicio?.approved_equipo_count ?? 0) > 0;
  const servicioLabel =
    servicioMode === "existing" ? servicio?.name : newServicioName;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-relaxed">
        <div className="text-gray-500">Resumen</div>
        <div className="mt-1 text-gray-800">
          <div>
            <span className="text-gray-500">Hospital:</span> {hospital.name}
          </div>
          <div>
            <span className="text-gray-500">Servicio:</span> {servicioLabel}
            {servicioMode === "new" && (
              <span className="ml-1 text-[10px] uppercase tracking-wider text-brand-700">
                · nuevo
              </span>
            )}
          </div>
        </div>
      </div>

      <Field
        label="Nombre de tu equipo"
        value={equipoName}
        onChange={setEquipoName}
        placeholder="ej. Residentes, Adjuntos, Enfermería…"
        autoComplete="off"
        name="equipo-name"
      />
      <p className="-mt-2 text-xs text-gray-500">
        Es el nombre que verán los demás cuando se compartan turnos
        en la vista conjunta del servicio.
      </p>

      {willBePending && (
        <div className="rounded-md border border-amber-200 bg-amber-50/80 p-3 text-xs leading-relaxed text-amber-900">
          Tu equipo quedará{" "}
          <span className="font-semibold">pendiente de aprobación</span>{" "}
          por un administrador existente del servicio{" "}
          <span className="font-semibold">{servicio?.name}</span>. Hasta
          que te aprueben puedes usar Trivu con tu equipo, pero no
          aparecerás en la vista conjunta del servicio ni en las
          invitaciones a reuniones de otros equipos.
        </div>
      )}

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <NavButtons
        onBack={onBack}
        onContinue={onSubmit}
        canContinue={equipoName.trim().length > 0 && !submitting}
        continueLabel={submitting ? "Creando…" : "Crear cuenta"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function NavButtons({
  onBack,
  onContinue,
  canContinue,
  continueLabel = "Continuar",
}: {
  onBack: () => void;
  onContinue: () => void;
  canContinue: boolean;
  continueLabel?: string;
}) {
  return (
    <div className="flex gap-2 pt-2">
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        Atrás
      </button>
      <button
        type="button"
        onClick={onContinue}
        disabled={!canContinue}
        className="flex-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
      >
        {continueLabel}
      </button>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  name?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        required={props.required ?? true}
        autoComplete={props.autoComplete}
        name={props.name}
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}

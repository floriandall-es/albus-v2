"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ErrorText, Select, TextField } from "@/components/admin/ui";
import { BulkInviteModal } from "@/components/admin/BulkInviteModal";
import { StepNav } from "../_nav";
import { StepHeader } from "../_step-header";

type AddedMember = {
  email: string;
  person_name: string;
  category_id: number | null;
};

export default function TeamStep() {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  // We still surface members the admin added in previous onboarding
  // sessions so they don't re-add anyone. The list comes from
  // listInvitations (every add creates a pendiente invitation row
  // under the hood) but the UI no longer talks about emails — those
  // get sent later from /admin/team when the admin is ready.
  const invs = useQuery({ queryKey: ["invitations"], queryFn: api.listInvitations });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [added, setAdded] = useState<AddedMember[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const addMember = useMutation({
    mutationFn: () =>
      api.inviteTeamMember({
        email,
        person_name: name,
        category_id: categoryId === "" ? null : Number(categoryId),
        roles: ["member"],
        // Onboarding: create the Person + Membership + Invitation
        // row but don't email anyone yet. The admin sends the
        // emails later from /admin/team once the rest of the
        // configuration (actividades, reglas) is finalised.
        send_email: false,
      }),
    onSuccess: () => {
      setAdded((cur) => [
        ...cur,
        {
          email,
          person_name: name,
          category_id: categoryId === "" ? null : Number(categoryId),
        },
      ]);
      setEmail("");
      setName("");
      setCategoryId("");
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
  });

  // Map category_id -> name for the "added in this session" list,
  // so we can show a small badge next to each row without an extra
  // query.
  const catNameById = new Map(
    (cats.data ?? []).map((c) => [c.id, c.name] as const),
  );

  // "Previously added" = invitation rows that already existed when
  // the admin opened this step (they came back to onboarding from a
  // different device, or finished a session and reopened). We hide
  // anyone the admin added in THIS session — those appear in the
  // "Añadidos en esta sesión" list above with full UI feedback.
  const addedEmailsThisSession = new Set(
    added.map((a) => a.email.toLowerCase()),
  );
  const previouslyAdded = (invs.data ?? []).filter(
    (inv) => !addedEmailsThisSession.has(inv.email.toLowerCase()),
  );

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-3">
        <StepHeader
          icon={Users}
          title="Paso 4 — Equipo"
          subtitle="Añade a los miembros de tu equipo. De momento sólo los registramos; les enviarás la invitación más tarde desde Admin → Equipo, cuando termines de configurar todo."
        />
        <Button variant="secondary" onClick={() => setBulkOpen(true)}>
          Importar Lista
        </Button>
      </div>
      <BulkInviteModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        sendEmail={false}
      />

      <MyProfileCard />

      <div className="mb-6 rounded-xl border border-brand-100 bg-brand-50/60 p-4 flex items-start gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-brand-700 ring-1 ring-brand-200 shrink-0">
          <Info className="h-4 w-4" />
        </span>
        <p className="text-sm text-brand-900/80 leading-relaxed">
          De momento sólo añadimos a la gente al equipo. Cuando hayas
          terminado de configurar actividades y reglas, podrás
          enviarles la invitación uno a uno desde{" "}
          <strong>Admin → Equipo</strong>.
        </p>
      </div>

      <form
        className="space-y-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (email && name) addMember.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Nombre" value={name} onChange={setName} />
          <TextField label="Email" type="email" value={email} onChange={setEmail} />
        </div>
        <Select
          label="Categoría (opcional)"
          value={categoryId}
          onChange={(v) => setCategoryId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "— Sin categoría —" },
            ...(cats.data ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <Button type="submit" disabled={!email || !name || addMember.isPending}>
          {addMember.isPending ? "Añadiendo…" : "Añadir"}
        </Button>
        {addMember.isError && (
          <ErrorText>{(addMember.error as Error).message}</ErrorText>
        )}
      </form>

      {added.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-medium mb-2">
            Añadidos en esta sesión
          </h3>
          <ul className="rounded-md border bg-white divide-y text-sm">
            {added.map((a, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-2 px-4 py-2"
              >
                <span className="font-medium text-gray-900">
                  {a.person_name}
                </span>
                <span className="text-gray-500">{a.email}</span>
                {a.category_id !== null && catNameById.has(a.category_id) && (
                  <span className="ml-auto inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-700">
                    {catNameById.get(a.category_id)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {previouslyAdded.length > 0 && (
        <section>
          <h3 className="text-sm font-medium mb-2">Añadidos anteriormente</h3>
          <ul className="rounded-md border bg-white divide-y text-sm">
            {previouslyAdded.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center gap-2 px-4 py-2"
              >
                <span className="font-medium text-gray-900">
                  {inv.person_name}
                </span>
                <span className="text-gray-500">{inv.email}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <StepNav currentSlug="team" />
    </div>
  );
}

function MyProfileCard() {
  // The admin's own membership lives in /api/me. We let them set their
  // category here so they can be scheduled like any other team member —
  // typical case is the Jefe de servicio also taking shifts.
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });

  const myMembership = me.data?.memberships?.[0] ?? null;
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [savedFlash, setSavedFlash] = useState(false);

  // Sync local state from server when it loads or refreshes.
  useEffect(() => {
    if (myMembership) {
      setCategoryId(myMembership.category_id ?? "");
    }
  }, [myMembership?.id, myMembership?.category_id]);

  const save = useMutation({
    mutationFn: (newCat: number | null) =>
      api.updateTeamMember(myMembership!.id, { category_id: newCat }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["team"] });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    },
  });

  if (!me.data || !myMembership) {
    return null;
  }

  const onChange = (v: string | number) => {
    const newVal = v === "" ? "" : Number(v);
    setCategoryId(newVal);
    save.mutate(newVal === "" ? null : newVal);
  };

  return (
    <section className="rounded-md border bg-white p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Tu perfil</h3>
        {savedFlash && (
          <span className="text-xs text-green-700">Guardado</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
        <div>
          <div className="text-xs text-gray-500">Nombre</div>
          <div>{me.data.person.name}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Email</div>
          <div className="break-all">{me.data.person.email}</div>
        </div>
      </div>
      <Select
        label="Tu categoría"
        value={categoryId}
        onChange={(v) => onChange(v)}
        options={[
          { value: "", label: "— Sin categoría (solo administro) —" },
          ...(cats.data ?? []).map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <p className="mt-2 text-xs text-gray-500">
        Si también haces turnos clínicos, elige tu categoría profesional. Si solo
        administras Trivu, déjala vacía. Podrás cambiarla luego en Equipo.
      </p>
      {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
    </section>
  );
}

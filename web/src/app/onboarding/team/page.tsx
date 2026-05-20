"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ErrorText, Select, TextField } from "@/components/admin/ui";
import { BulkInviteModal } from "@/components/admin/BulkInviteModal";
import { InviteDeliveryPill } from "@/components/admin/InviteDeliveryPill";
import { StepNav } from "../_nav";
import { StepHeader } from "../_step-header";

type GeneratedInvite = {
  email: string;
  person_name: string;
  accept_url: string;
};

export default function TeamStep() {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const invs = useQuery({ queryKey: ["invitations"], queryFn: api.listInvitations });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [generated, setGenerated] = useState<GeneratedInvite[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      api.inviteTeamMember({
        email,
        person_name: name,
        category_id: categoryId === "" ? null : Number(categoryId),
        roles: ["member"],
      }),
    onSuccess: (data) => {
      setGenerated((cur) => [
        ...cur,
        { email: data.email, person_name: name, accept_url: data.accept_url },
      ]);
      setEmail("");
      setName("");
      setCategoryId("");
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
  });

  // Resend any pending invitation. Rotates the token in-place
  // so the row stays put, with the delivery pill updating after
  // the next list refresh.
  const resend = useMutation({
    mutationFn: (id: number) => api.resendInvitation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations"] }),
  });

  function copy(url: string) {
    navigator.clipboard.writeText(url).catch(() => undefined);
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-3">
        <StepHeader
          icon={Users}
          title="Paso 4 — Equipo"
          subtitle="Invita a tus compañeros. Recibirán un email con el enlace para crear su contraseña; si no llega, puedes reenviarlo o copiar el enlace desde la lista."
        />
        <Button variant="secondary" onClick={() => setBulkOpen(true)}>
          Importar Lista
        </Button>
      </div>
      <BulkInviteModal open={bulkOpen} onClose={() => setBulkOpen(false)} />

      <MyProfileCard />

      <form
        className="space-y-3 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (email && name) invite.mutate();
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
        <Button type="submit" disabled={!email || !name || invite.isPending}>
          {invite.isPending ? "Invitando…" : "Invitar"}
        </Button>
        {invite.isError && <ErrorText>{(invite.error as Error).message}</ErrorText>}
      </form>

      {generated.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-medium mb-1">
            Invitaciones enviadas en esta sesión
          </h3>
          <p className="text-xs text-gray-500 mb-2">
            Cada persona ha recibido un email con el enlace para crear su
            contraseña. Si no les llega (carpeta de spam, dirección errónea,
            etc.) puedes copiar su enlace de aquí y compartírselo a mano.
          </p>
          <ul className="rounded-md border bg-white divide-y text-sm">
            {generated.map((g, i) => (
              <li key={i} className="px-4 py-2">
                <div className="font-medium">
                  {g.person_name}{" "}
                  <span className="text-gray-500 font-normal">{g.email}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-gray-100 px-2 py-1 text-xs">
                    {g.accept_url}
                  </code>
                  <button
                    className="text-xs underline"
                    onClick={() => copy(g.accept_url)}
                  >
                    Copiar
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            Los enlaces caducan en 7 días.
          </p>
        </section>
      )}

      <section>
        <h3 className="text-sm font-medium mb-2">Pendientes de aceptar</h3>
        <ul className="rounded-md border bg-white divide-y text-sm">
          {(invs.data ?? []).map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
            >
              <span className="min-w-0">
                {inv.person_name}{" "}
                <span className="text-gray-500">{inv.email}</span>
              </span>
              <div className="flex items-center gap-3 ml-auto">
                <InviteDeliveryPill inv={inv} />
                <span className="text-xs text-gray-400">
                  caduca {new Date(inv.expires_at).toLocaleDateString()}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (
                      confirm(
                        `¿Reenviar la invitación a ${inv.email}? Se enviará un nuevo email y el enlace anterior dejará de funcionar.`,
                      )
                    ) {
                      resend.mutate(inv.id);
                    }
                  }}
                  disabled={resend.isPending}
                >
                  Reenviar
                </Button>
              </div>
            </li>
          ))}
          {(invs.data ?? []).length === 0 && (
            <li className="px-4 py-3 text-gray-500">Sin invitaciones pendientes.</li>
          )}
        </ul>
        {resend.isError && (
          <div className="mt-2">
            <ErrorText>{(resend.error as Error).message}</ErrorText>
          </div>
        )}
      </section>

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

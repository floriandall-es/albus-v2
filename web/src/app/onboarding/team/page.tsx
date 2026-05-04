"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, ErrorText, Select, TextField } from "@/components/admin/ui";
import { BulkInviteModal } from "@/components/admin/BulkInviteModal";
import { StepNav } from "../_nav";

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

  function copy(url: string) {
    navigator.clipboard.writeText(url).catch(() => undefined);
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-2">
        <h2 className="text-2xl font-semibold">Paso 5 — Equipo</h2>
        <Button variant="secondary" onClick={() => setBulkOpen(true)}>
          Importar CSV
        </Button>
      </div>
      <p className="text-sm text-gray-600 mb-6">
        Invita a tus compañeros. Recibirán un email con el enlace para crear su
        contraseña. Si no llega (revisa también la carpeta de spam), puedes
        copiar el enlace de abajo y compartirlo manualmente.
      </p>
      <BulkInviteModal open={bulkOpen} onClose={() => setBulkOpen(false)} />

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
          {invite.isPending ? "Generando…" : "Generar enlace de invitación"}
        </Button>
        {invite.isError && <ErrorText>{(invite.error as Error).message}</ErrorText>}
      </form>

      {generated.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-medium mb-2">
            Enlaces generados en esta sesión
          </h3>
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
            Copia y comparte cada enlace con la persona correspondiente. Caducan en 7
            días.
          </p>
        </section>
      )}

      <section>
        <h3 className="text-sm font-medium mb-2">Pendientes de aceptar</h3>
        <ul className="rounded-md border bg-white divide-y text-sm">
          {(invs.data ?? []).map((inv) => (
            <li key={inv.id} className="flex items-center justify-between px-4 py-2">
              <span>
                {inv.person_name}{" "}
                <span className="text-gray-500">{inv.email}</span>
              </span>
              <span className="text-xs text-gray-400">
                caduca {new Date(inv.expires_at).toLocaleDateString()}
              </span>
            </li>
          ))}
          {(invs.data ?? []).length === 0 && (
            <li className="px-4 py-3 text-gray-500">Sin invitaciones pendientes.</li>
          )}
        </ul>
      </section>

      <StepNav currentSlug="team" />
    </div>
  );
}

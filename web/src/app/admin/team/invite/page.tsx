"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Button,
  ErrorText,
  PageHeader,
  Select,
  TextField,
} from "@/components/admin/ui";

export default function InvitePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [ftePct, setFtePct] = useState("100");
  const [rolesText, setRolesText] = useState("");
  const [doesGuardias, setDoesGuardias] = useState(true);

  const invite = useMutation({
    mutationFn: () =>
      api.inviteTeamMember({
        email,
        person_name: name,
        category_id: categoryId === "" ? null : Number(categoryId),
        roles: rolesText
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
        fte_pct: Number(ftePct),
        does_guardias: doesGuardias,
        guardia_types: [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      router.push("/admin/team");
    },
  });

  return (
    <div className="max-w-md">
      <PageHeader title="Invitar miembro" />
      <p className="text-sm text-gray-600 mb-4">
        En este sprint no se envía email automáticamente. Se crea la persona y la
        membresía; comparte la contraseña inicial fuera de la plataforma o pídele que
        use el flujo de recuperación más adelante.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <TextField label="Nombre" value={name} onChange={setName} required />
        <TextField label="Email" type="email" value={email} onChange={setEmail} required />
        <Select
          label="Categoría"
          value={categoryId}
          onChange={(v) => setCategoryId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "— Sin categoría —" },
            ...(cats.data ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <TextField label="FTE %" type="number" value={ftePct} onChange={setFtePct} />
        <TextField
          label="Roles (separados por coma, ej: doctor, admin)"
          value={rolesText}
          onChange={setRolesText}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={doesGuardias}
            onChange={(e) => setDoesGuardias(e.target.checked)}
          />
          Hace guardias
        </label>
        {invite.isError && <ErrorText>{(invite.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => router.push("/admin/team")}>
            Cancelar
          </Button>
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? "Invitando…" : "Crear miembro"}
          </Button>
        </div>
      </form>
    </div>
  );
}

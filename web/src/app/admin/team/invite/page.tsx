"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type InviteCreateResponse } from "@/lib/api";
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
  const [rolesText, setRolesText] = useState("member");
  const [created, setCreated] = useState<InviteCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

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
      }),
    onSuccess: (data) => {
      setCreated(data);
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
  });

  function copyLink() {
    if (!created) return;
    navigator.clipboard.writeText(created.accept_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (created) {
    return (
      <div className="max-w-xl">
        <PageHeader title="Invitación creada" />
        <div className="rounded-md border bg-amber-50 p-4 text-sm text-amber-900 mb-4">
          El envío automático de correo aún no está habilitado. <strong>Comparte el
          siguiente enlace</strong> con la persona invitada para que establezca su
          contraseña y se una al equipo. El enlace caduca en 7 días.
        </div>
        <div className="rounded-md border bg-white p-4 mb-4">
          <div className="text-xs text-gray-500 mb-1">Email</div>
          <div className="text-sm mb-3">{created.email}</div>
          <div className="text-xs text-gray-500 mb-1">Enlace de aceptación</div>
          <div className="flex gap-2 items-center">
            <code className="flex-1 break-all rounded bg-gray-100 px-2 py-1 text-xs">
              {created.accept_url}
            </code>
            <Button onClick={copyLink}>{copied ? "Copiado" : "Copiar"}</Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setCreated(null);
              setEmail("");
              setName("");
              setCategoryId("");
              setRolesText("member");
            }}
          >
            Invitar a otro
          </Button>
          <Button onClick={() => router.push("/admin/team")}>Volver al equipo</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md">
      <PageHeader title="Invitar miembro" />
      <p className="text-sm text-gray-600 mb-4">
        Se generará un enlace de invitación que la persona usará para crear su contraseña.
        El envío automático por email se añadirá en una próxima versión.
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
        <TextField
          label="Roles (separados por coma, ej: member, doctor, admin)"
          value={rolesText}
          onChange={setRolesText}
        />
        {invite.isError && <ErrorText>{(invite.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => router.push("/admin/team")}>
            Cancelar
          </Button>
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? "Generando…" : "Generar enlace"}
          </Button>
        </div>
      </form>
    </div>
  );
}

"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  avatarSrc,
  type Category,
  type Invitation,
  type TeamMember,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  TextField,
} from "@/components/admin/ui";
import { BulkInviteModal } from "@/components/admin/BulkInviteModal";

const DEFAULT_GUARDIA_TYPES = [
  "presencial_24h",
  "localizada",
  "findes_festivos",
];

/**
 * 32×32 circle showing the member's photo, or two-letter initials
 * on a brand-tinted background when none is set. Lives here (not
 * in components/) because the only other Avatar in the app — the
 * 20px one in the planning grid — is intentionally tighter; this
 * one's sized for table rows.
 */
function TeamAvatar({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl: string | null;
}) {
  const src = avatarSrc(avatarUrl);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-gray-200"
      />
    );
  }
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-xs font-semibold ring-1 ring-gray-200"
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

export default function TeamPage() {
  const list = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Equipo"
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setBulkOpen(true)}>
              Importar Lista
            </Button>
            <Link href="/admin/team/invite">
              <Button>Invitar miembro</Button>
            </Link>
          </div>
        }
      />
      <BulkInviteModal open={bulkOpen} onClose={() => setBulkOpen(false)} />
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay miembros.</Empty>}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Categoría</th>
                <th className="px-4 py-2 font-medium">FTE</th>
                <th className="px-4 py-2 font-medium">Guardias</th>
                <th className="px-4 py-2 font-medium">Roles</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={m.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2.5">
                      <TeamAvatar
                        name={m.person_name}
                        avatarUrl={m.person_avatar_url}
                      />
                      <span>{m.person_name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-gray-600">{m.person_email}</td>
                  <td className="px-4 py-2">{m.category_name ?? "—"}</td>
                  <td className="px-4 py-2">{m.fte_pct}%</td>
                  <td className="px-4 py-2">{m.does_guardias ? "Sí" : "No"}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {m.roles.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="secondary" onClick={() => setEditing(m)}>
                      Editar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <PendingInvitations />

      {editing && (
        <TeamEditDialog
          member={editing}
          categories={cats.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function PendingInvitations() {
  const qc = useQueryClient();
  const invs = useQuery({ queryKey: ["invitations"], queryFn: api.listInvitations });
  const revoke = useMutation({
    mutationFn: (id: number) => api.revokeInvitation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invitations"] }),
  });
  const [lastReissue, setLastReissue] = useState<{
    email: string;
    accept_url: string;
  } | null>(null);
  const reissue = useMutation({
    mutationFn: (id: number) => api.reissueInvitation(id),
    onSuccess: (data) => {
      setLastReissue({ email: data.email, accept_url: data.accept_url });
      qc.invalidateQueries({ queryKey: ["invitations"] });
    },
  });

  if (!invs.data || invs.data.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold mb-3">Invitaciones pendientes</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Caduca</th>
              <th className="px-4 py-2 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {invs.data.map((inv: Invitation) => (
              <tr key={inv.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                <td className="px-4 py-2">{inv.email}</td>
                <td className="px-4 py-2">{inv.person_name}</td>
                <td className="px-4 py-2 text-gray-600">
                  {new Date(inv.expires_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-2 text-right space-x-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (
                        confirm(
                          `¿Re-enviar la invitación a ${inv.email}? Se enviará un nuevo email y el enlace anterior dejará de funcionar.`,
                        )
                      ) {
                        reissue.mutate(inv.id);
                      }
                    }}
                    disabled={reissue.isPending}
                  >
                    Re-enviar
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => revoke.mutate(inv.id)}
                    disabled={revoke.isPending}
                  >
                    Revocar
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {lastReissue && (
        <div className="mt-3 rounded-md border border-green-200 bg-green-50 p-3 text-sm">
          <p className="font-medium text-green-800">
            Nueva invitación enviada a {lastReissue.email}
          </p>
          <p className="mt-1 text-xs text-green-900">
            Enlace de respaldo (por si el email no llega):
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs">
              {lastReissue.accept_url}
            </code>
            <button
              className="text-xs underline"
              onClick={() => {
                navigator.clipboard.writeText(lastReissue.accept_url);
              }}
            >
              Copiar
            </button>
            <button
              className="text-xs text-gray-600"
              onClick={() => setLastReissue(null)}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
      {reissue.isError && (
        <ErrorText>{(reissue.error as Error).message}</ErrorText>
      )}
    </section>
  );
}

function TeamEditDialog({
  member,
  categories,
  onClose,
}: {
  member: TeamMember;
  categories: Category[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Collect guardia_type values currently used on slots so they show up
  // as suggested chips. Tenants can add anything else free-form.
  const slotsQ = useQuery({ queryKey: ["slots"], queryFn: api.listSlots });
  const slotTypes = (slotsQ.data ?? [])
    .map((s) => s.guardia_type)
    .filter((t): t is string => !!t);
  const baseTypes = Array.from(
    new Set([...DEFAULT_GUARDIA_TYPES, ...slotTypes, ...member.guardia_types]),
  );
  const [extraType, setExtraType] = useState("");
  const [knownTypes, setKnownTypes] = useState<string[]>(baseTypes);
  const [categoryId, setCategoryId] = useState<number | "">(member.category_id ?? "");
  const [ftePct, setFtePct] = useState<string>(member.fte_pct.toString());
  const [doesGuardias, setDoesGuardias] = useState<boolean>(member.does_guardias);
  const [guardiaTypes, setGuardiaTypes] = useState<string[]>(member.guardia_types);
  const [exemptionType, setExemptionType] = useState<string>(member.exemption_type ?? "");
  const [exemptionUntil, setExemptionUntil] = useState<string>(
    member.exemption_until ?? "",
  );

  const save = useMutation({
    mutationFn: () => {
      const clearExemption = exemptionType === "";
      return api.updateTeamMember(member.id, {
        category_id: categoryId === "" ? null : Number(categoryId),
        fte_pct: Number(ftePct),
        does_guardias: doesGuardias,
        guardia_types: guardiaTypes,
        exemption_type: clearExemption
          ? undefined
          : (exemptionType as "permanent" | "temporary"),
        exemption_until: clearExemption
          ? undefined
          : exemptionUntil === ""
          ? null
          : exemptionUntil,
        clear_exemption: clearExemption,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      onClose();
    },
  });

  function toggleGuardiaType(t: string) {
    setGuardiaTypes((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  }

  return (
    <Modal open={true} onClose={onClose} title={`Editar — ${member.person_name}`}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Select
          label="Categoría"
          value={categoryId}
          onChange={(v) => setCategoryId(v === "" ? "" : Number(v))}
          options={[
            { value: "", label: "— Sin categoría —" },
            ...categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <TextField label="FTE %" type="number" value={ftePct} onChange={setFtePct} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={doesGuardias}
            onChange={(e) => setDoesGuardias(e.target.checked)}
          />
          Hace guardias
        </label>
        {doesGuardias && (
          <div>
            <span className="text-sm font-medium">Tipos de guardia</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {knownTypes.map((t) => (
                <label key={t} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={guardiaTypes.includes(t)}
                    onChange={() => toggleGuardiaType(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                placeholder="Nuevo tipo (p. ej. 24h_traumatologia)"
                value={extraType}
                onChange={(e) => setExtraType(e.target.value)}
                className="flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              <button
                type="button"
                className="text-sm underline"
                onClick={() => {
                  const t = extraType.trim();
                  if (!t) return;
                  if (!knownTypes.includes(t)) {
                    setKnownTypes((cur) => [...cur, t]);
                  }
                  if (!guardiaTypes.includes(t)) {
                    setGuardiaTypes((cur) => [...cur, t]);
                  }
                  setExtraType("");
                }}
              >
                Añadir
              </button>
            </div>
          </div>
        )}
        <Select
          label="Exención"
          value={exemptionType}
          onChange={(v) => setExemptionType(v as string)}
          options={[
            { value: "", label: "— Sin exención —" },
            { value: "temporary", label: "Temporal" },
            { value: "permanent", label: "Permanente" },
          ]}
        />
        {exemptionType === "temporary" && (
          <TextField
            label="Exención hasta"
            type="date"
            value={exemptionUntil}
            onChange={setExemptionUntil}
          />
        )}
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

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
  muted = false,
}: {
  name: string;
  avatarUrl: string | null;
  /** Disabled-member styling: desaturated photo + neutral initials
   * background so the row reads as "paused" at a glance. */
  muted?: boolean;
}) {
  const src = avatarSrc(avatarUrl);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={
          "h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-gray-200 "
          + (muted ? "opacity-50 grayscale" : "")
        }
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
      className={
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-gray-200 "
        + (muted
          ? "bg-gray-200 text-gray-500"
          : "bg-brand-100 text-brand-700")
      }
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
                <th className="px-4 py-2 font-medium">Roles</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => {
                // Disabled members are still present in the list so an
                // admin can spot who's paused (maternity leave, sabbatical)
                // — they just render muted and tagged. Re-enabling lives
                // inside the edit modal.
                const isDisabled = m.disabled_at !== null;
                return (
                <tr
                  key={m.id}
                  className={
                    "border-b border-gray-100 last:border-b-0 transition-colors "
                    + (isDisabled
                      ? "bg-gray-50/40 text-gray-400"
                      : "hover:bg-gray-50/60")
                  }
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2.5">
                      <TeamAvatar
                        name={m.person_name}
                        avatarUrl={m.person_avatar_url}
                        muted={isDisabled}
                      />
                      <span className={isDisabled ? "" : "text-gray-900"}>
                        {m.person_name}
                      </span>
                      {isDisabled && (
                        <span className="inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-700">
                          Desactivado
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={"px-4 py-2 " + (isDisabled ? "" : "text-gray-600")}>
                    {m.person_email}
                  </td>
                  <td className="px-4 py-2">{m.category_name ?? "—"}</td>
                  <td className="px-4 py-2">{m.fte_pct}%</td>
                  <td className={"px-4 py-2 text-xs " + (isDisabled ? "" : "text-gray-600")}>
                    {m.roles.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="secondary" onClick={() => setEditing(m)}>
                      Editar
                    </Button>
                  </td>
                </tr>
                );
              })}
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
  const [categoryId, setCategoryId] = useState<number | "">(member.category_id ?? "");
  const [ftePct, setFtePct] = useState<string>(member.fte_pct.toString());
  const [active, setActive] = useState<boolean>(member.disabled_at === null);

  const save = useMutation({
    mutationFn: () => {
      // Only send `disabled` if its boolean state actually flipped —
      // saves the server a write and keeps disabled_at's timestamp
      // stable when the admin just re-saved Categoría/FTE.
      const wasActive = member.disabled_at === null;
      const flipped = active !== wasActive;
      return api.updateTeamMember(member.id, {
        category_id: categoryId === "" ? null : Number(categoryId),
        fte_pct: Number(ftePct),
        ...(flipped ? { disabled: !active } : {}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      onClose();
    },
  });

  // ES locale, short date — for the "Desactivado desde X" hint.
  const disabledSince = member.disabled_at
    ? new Date(member.disabled_at).toLocaleDateString("es", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

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
        <TextField
          label="FTE %"
          hint={
            <>
              Pondera el reparto de turnos en la planificación. Al 100%
              la persona recibe su parte completa; al 50%, la mitad.
              Útil para reducciones de jornada (vuelta de baja,
              cuidados). No es un tope máximo — el solver intenta
              acercarse a esa proporción, no impide superarla si hace
              falta.
            </>
          }
          type="number"
          value={ftePct}
          onChange={setFtePct}
        />

        <div className="rounded-md border border-gray-200 bg-gray-50/60 p-3">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Activo en el equipo</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Desactiva durante bajas largas (maternidad, sabático, etc.).
                La persona deja de aparecer en planificaciones nuevas, pero
                conserva su historial y puede seguir entrando a la app.
              </span>
              {!active && disabledSince && (
                <span className="block text-xs text-gray-600 mt-1">
                  Desactivado desde {disabledSince}.
                </span>
              )}
            </span>
          </label>
        </div>

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

"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Category, type TeamMember } from "@/lib/api";
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

const GUARDIA_TYPES = ["12h", "24h", "presencial", "localizada"];

export default function TeamPage() {
  const list = useQuery({ queryKey: ["team"], queryFn: api.listTeam });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const [editing, setEditing] = useState<TeamMember | null>(null);

  return (
    <>
      <PageHeader
        title="Equipo"
        action={
          <Link href="/admin/team/invite">
            <Button>Invitar miembro</Button>
          </Link>
        }
      />
      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && <Empty>Aún no hay miembros.</Empty>}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-gray-600">
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
                <tr key={m.id} className="border-b last:border-b-0">
                  <td className="px-4 py-2">{m.person_name}</td>
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
              {GUARDIA_TYPES.map((t) => (
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

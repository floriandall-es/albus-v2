"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Incident } from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  TextField,
} from "@/components/admin/ui";
import { formatLongDate, todayIso } from "@/lib/dates";

/**
 * Per-tenant freeform incident log. Admins document anything
 * out-of-the-ordinary (call-offs, swap conflicts, equipment
 * issues, complaints) — text only, no linkage to persons/slots
 * for v1. If structured links emerge as a real need we'll
 * promote them then.
 */
export default function IncidentsPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["incidents"],
    queryFn: api.listIncidents,
  });
  const [editing, setEditing] = useState<Incident | "new" | null>(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteIncident(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });

  return (
    <>
      <PageHeader
        title="Incidentes"
        action={<Button onClick={() => setEditing("new")}>Nuevo incidente</Button>}
      />
      <p className="-mt-4 mb-6 text-sm text-gray-600">
        Registro libre de eventos fuera de lo común: bajas
        inesperadas, conflictos en cambios de turno, incidencias de
        material, quejas… cualquier cosa que quieras dejar por
        escrito.
      </p>

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.isError && <ErrorText>{(list.error as Error).message}</ErrorText>}
      {list.data && list.data.length === 0 && (
        <Empty>Aún no hay incidentes anotados.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <ul className="divide-y divide-gray-100">
            {list.data.map((inc) => (
              <li
                key={inc.id}
                className="px-4 py-3 hover:bg-gray-50/60 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs uppercase tracking-wide text-gray-500">
                        {formatLongDate(inc.occurred_at)}
                      </span>
                      {inc.created_by_name && (
                        <span className="text-[11px] text-gray-400">
                          · anotado por {inc.created_by_name}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-sm font-semibold text-gray-900">
                      {inc.title}
                    </div>
                    {inc.body && (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
                        {inc.body}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="secondary" onClick={() => setEditing(inc)}>
                      Editar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (
                          confirm(
                            `¿Eliminar este incidente?\n\n"${inc.title}"`,
                          )
                        ) {
                          del.mutate(inc.id);
                        }
                      }}
                    >
                      Eliminar
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <IncidentDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function IncidentDialog({
  initial,
  onClose,
}: {
  initial: Incident | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [occurredAt, setOccurredAt] = useState<string>(
    initial?.occurred_at ?? todayIso(),
  );
  const [title, setTitle] = useState<string>(initial?.title ?? "");
  const [body, setBody] = useState<string>(initial?.body ?? "");

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        occurred_at: occurredAt,
        title: title.trim(),
        body: body.trim() ? body.trim() : null,
      };
      return initial
        ? api.updateIncident(initial.id, payload)
        : api.createIncident(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incidents"] });
      onClose();
    },
  });

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? "Editar incidente" : "Nuevo incidente"}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Fecha"
          type="date"
          value={occurredAt}
          onChange={setOccurredAt}
          required
        />
        <TextField
          label="Título"
          value={title}
          onChange={setTitle}
          placeholder="Ej. Llamada enferma — Marta no cubre guardia del martes"
          required
        />
        <div>
          <span className="text-sm font-medium text-gray-700">
            Detalles (opcional)
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            maxLength={10000}
            placeholder="Quién, cómo se resolvió, repercusiones…"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        {save.isError && <ErrorText>{(save.error as Error).message}</ErrorText>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending || !title.trim()}>
            {save.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { api, type Meeting } from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  PageHeader,
  StatusPill,
} from "@/components/admin/ui";
import {
  MeetingDialog,
  WEEKDAY_LABELS_ES,
} from "@/components/meetings/meeting-dialog";
import { formatLongDate } from "@/lib/dates";

/**
 * Tenant-admin reuniones page. Two sections:
 *
 *   1. Semanales (regulares) — recurring weekly templates. Admin-
 *      managed (create/edit/delete). Members never see them in
 *      this list, but the meetings show up in their planning grid
 *      / Reuniones row on the days they recur.
 *   2. Puntuales (ad-hoc) — one-off meetings. Admin sees ALL of
 *      them (including ones organised by other members), can edit
 *      or delete to keep the calendar tidy.
 */
export default function AdminMeetingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const list = useQuery({
    queryKey: ["meetings"],
    queryFn: api.listMeetings,
  });
  // "Abrir chat" → find-or-create the meeting's group chat and jump
  // to the messaging surface with it selected.
  const openChat = useMutation({
    mutationFn: (meetingId: number) => api.openMeetingChat(meetingId),
    onSuccess: ({ conversation_id }) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      router.push(`/me/mensajes?c=${conversation_id}`);
    },
  });
  const [editing, setEditing] = useState<
    { meeting: Meeting | null; defaultKind: "regular" | "ad_hoc" } | null
  >(null);

  const del = useMutation({
    mutationFn: (id: number) => api.deleteMeeting(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings"] });
      qc.invalidateQueries({ queryKey: ["meeting-instances"] });
    },
  });

  const { regulars, adHocs } = useMemo(() => {
    const all = list.data ?? [];
    return {
      regulars: all.filter((m) => m.kind === "regular"),
      adHocs: all.filter((m) => m.kind === "ad_hoc"),
    };
  }, [list.data]);

  return (
    <>
      <PageHeader
        title="Reuniones"
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                setEditing({ meeting: null, defaultKind: "ad_hoc" })
              }
            >
              Reunión puntual
            </Button>
            <Button
              onClick={() =>
                setEditing({ meeting: null, defaultKind: "regular" })
              }
            >
              Reunión semanal
            </Button>
          </div>
        }
      />
      <p className="-mt-4 mb-6 text-sm text-gray-600">
        Las reuniones semanales se repiten cada semana en el día que
        elijas; las puntuales son únicas. Aparecen en la planificación
        del equipo en una línea «Reuniones».
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Semanales
        </h2>
        {list.isLoading && (
          <p className="text-sm text-gray-500">Cargando…</p>
        )}
        {list.data && regulars.length === 0 && (
          <Empty>Aún no hay reuniones semanales.</Empty>
        )}
        {regulars.length > 0 && (
          <Card>
            <ul className="divide-y divide-gray-100">
              {regulars.map((m) => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  onChat={() => openChat.mutate(m.id)}
                  chatBusy={
                    openChat.isPending && openChat.variables === m.id
                  }
                  onEdit={() =>
                    setEditing({ meeting: m, defaultKind: "regular" })
                  }
                  onDelete={() => {
                    if (
                      confirm(
                        `¿Eliminar la reunión semanal "${m.title}"?`,
                      )
                    ) {
                      del.mutate(m.id);
                    }
                  }}
                />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Puntuales
        </h2>
        {list.data && adHocs.length === 0 && (
          <Empty>Aún no hay reuniones puntuales.</Empty>
        )}
        {adHocs.length > 0 && (
          <Card>
            <ul className="divide-y divide-gray-100">
              {adHocs.map((m) => (
                <MeetingRow
                  key={m.id}
                  meeting={m}
                  onChat={() => openChat.mutate(m.id)}
                  chatBusy={
                    openChat.isPending && openChat.variables === m.id
                  }
                  onEdit={() =>
                    setEditing({ meeting: m, defaultKind: "ad_hoc" })
                  }
                  onDelete={() => {
                    if (
                      confirm(`¿Eliminar la reunión "${m.title}"?`)
                    ) {
                      del.mutate(m.id);
                    }
                  }}
                />
              ))}
            </ul>
          </Card>
        )}
      </section>

      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <MeetingDialog
          initial={editing.meeting}
          defaultKind={editing.defaultKind}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function MeetingRow({
  meeting,
  onChat,
  chatBusy = false,
  onEdit,
  onDelete,
}: {
  meeting: Meeting;
  onChat: () => void;
  chatBusy?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const timeRange = `${meeting.start_time.slice(0, 5)}–${meeting.end_time.slice(0, 5)}`;
  const when =
    meeting.kind === "regular"
      ? `Cada ${WEEKDAY_LABELS_ES[meeting.weekday!].toLowerCase()} · ${timeRange}`
      : `${formatLongDate(meeting.date!)} · ${timeRange}`;

  return (
    <li className="px-4 py-3 hover:bg-gray-50/60 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900">
            {meeting.title}
          </div>
          <div className="mt-0.5 text-xs text-gray-600">{when}</div>
          {meeting.location && (
            <div className="text-xs text-gray-500">{meeting.location}</div>
          )}
          {meeting.description && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
              {meeting.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {meeting.audience.include_main_team && (
              <StatusPill tone="info">Equipo principal</StatusPill>
            )}
            {meeting.audience.person_names.map((name, i) => (
              <StatusPill key={i} tone="neutral">
                {name}
              </StatusPill>
            ))}
          </div>
          {meeting.organizer_name && (
            <div className="mt-1 text-[11px] text-gray-400">
              Organiza {meeting.organizer_name}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={onChat} disabled={chatBusy}>
            <MessageSquare className="h-4 w-4" />
            {chatBusy ? "Abriendo…" : "Chat"}
          </Button>
          <Button variant="secondary" onClick={onEdit}>
            Editar
          </Button>
          <Button variant="danger" onClick={onDelete}>
            Eliminar
          </Button>
        </div>
      </div>
    </li>
  );
}

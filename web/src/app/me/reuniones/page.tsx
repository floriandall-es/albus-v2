"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import {
  api,
  type Meeting,
  type MeetingInstance,
} from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  PageHeader,
} from "@/components/admin/ui";
import { MeetingDialog } from "@/components/meetings/meeting-dialog";
import { formatLongDate, todayIso } from "@/lib/dates";

/**
 * Member-facing reuniones page. Shows the meetings the user is
 * invited to as a flat chronological list, grouped into
 * "Próximas" (today + future) and "Pasadas" (last 30 days).
 *
 * "Nueva reunión" button opens the dialog with the Semanal /
 * Puntual toggle unlocked — any member (including sub-equipo
 * residentes) can create either flavour. Editing an existing
 * meeting locks the toggle to its current kind (no
 * weekly ↔ puntual morphing on the same row).
 */
export default function MyMeetingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  // "Abrir chat" → find-or-create the meeting's group chat and jump
  // to the messaging surface with it selected.
  const openChat = useMutation({
    mutationFn: (meetingId: number) => api.openMeetingChat(meetingId),
    onSuccess: ({ conversation_id }) => {
      router.push(`/me/mensajes?c=${conversation_id}`);
    },
  });
  // Window: previous 30 days through next 90. Roughly the
  // useful read window for a residente checking what's on the
  // calendar. We can widen it later if anyone asks.
  const { fromIso, toIso, today } = useMemo(() => {
    const t = todayIso();
    const past = new Date(t);
    past.setDate(past.getDate() - 30);
    const fut = new Date(t);
    fut.setDate(fut.getDate() + 90);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { fromIso: fmt(past), toIso: fmt(fut), today: t };
  }, []);

  const instances = useQuery({
    queryKey: ["meeting-instances", fromIso, toIso],
    queryFn: () => api.listMeetingInstances(fromIso, toIso),
  });

  // For edit, we need the parent Meeting row (not just the
  // instance). The list endpoint already returns it scoped by
  // visibility, so fetching both is cheap.
  const meetings = useQuery({
    queryKey: ["meetings"],
    queryFn: api.listMeetings,
  });
  const meetingById = useMemo(() => {
    const m = new Map<number, Meeting>();
    for (const x of meetings.data ?? []) m.set(x.id, x);
    return m;
  }, [meetings.data]);

  const [editing, setEditing] = useState<Meeting | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: number) => api.deleteMeeting(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["meetings"] });
      qc.invalidateQueries({ queryKey: ["meeting-instances"] });
    },
  });

  const { upcoming, past } = useMemo(() => {
    const all = instances.data ?? [];
    return {
      upcoming: all.filter((x) => x.date >= today),
      past: all.filter((x) => x.date < today).reverse(),
    };
  }, [instances.data, today]);

  return (
    <>
      <PageHeader
        title="Reuniones"
        action={
          <Button onClick={() => setEditing("new")}>Nueva reunión</Button>
        }
      />
      <p className="-mt-4 mb-6 text-sm text-gray-600">
        Reuniones a las que estás invitado. Puedes crear una
        reunión puntual o semanal definiendo el tema y la
        audiencia.
      </p>

      {instances.isLoading && (
        <p className="text-sm text-gray-500">Cargando…</p>
      )}

      {instances.data && upcoming.length === 0 && past.length === 0 && (
        <Empty>No tienes reuniones programadas.</Empty>
      )}

      {upcoming.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Próximas
          </h2>
          <Card>
            <ul className="divide-y divide-gray-100">
              {upcoming.map((inst) => (
                <InstanceRow
                  key={`${inst.meeting_id}_${inst.date}`}
                  inst={inst}
                  onChat={() => openChat.mutate(inst.meeting_id)}
                  chatBusy={
                    openChat.isPending
                    && openChat.variables === inst.meeting_id
                  }
                  onEdit={
                    inst.can_edit && meetingById.get(inst.meeting_id)
                      ? () => setEditing(meetingById.get(inst.meeting_id)!)
                      : undefined
                  }
                  onDelete={
                    inst.can_edit
                      ? () => {
                          if (confirm(`¿Eliminar "${inst.title}"?`)) {
                            del.mutate(inst.meeting_id);
                          }
                        }
                      : undefined
                  }
                />
              ))}
            </ul>
          </Card>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Pasadas
          </h2>
          <Card>
            <ul className="divide-y divide-gray-100">
              {past.map((inst) => (
                <InstanceRow
                  key={`${inst.meeting_id}_${inst.date}`}
                  inst={inst}
                  onChat={() => openChat.mutate(inst.meeting_id)}
                  chatBusy={
                    openChat.isPending
                    && openChat.variables === inst.meeting_id
                  }
                  dimmed
                />
              ))}
            </ul>
          </Card>
        </section>
      )}

      {del.isError && <ErrorText>{(del.error as Error).message}</ErrorText>}

      {editing && (
        <MeetingDialog
          initial={editing === "new" ? null : editing}
          defaultKind="ad_hoc"
          // When editing an existing meeting we lock the kind to
          // whatever it is (you can't morph weekly ↔ puntual on
          // the same row; that'd be a separate workflow). For a
          // new meeting we leave the toggle unlocked so any
          // member can pick semanal — the backend used to gate
          // that to admins, but doesn't anymore.
          lockedKind={editing === "new" ? undefined : editing.kind}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function InstanceRow({
  inst,
  onChat,
  chatBusy = false,
  onEdit,
  onDelete,
  dimmed = false,
}: {
  inst: MeetingInstance;
  onChat?: () => void;
  chatBusy?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  dimmed?: boolean;
}) {
  const timeRange = `${inst.start_time.slice(0, 5)}–${inst.end_time.slice(0, 5)}`;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={
              "text-sm font-semibold "
              + (dimmed ? "text-gray-500" : "text-gray-900")
            }
          >
            {inst.title}
          </div>
          <div className="mt-0.5 text-xs text-gray-600">
            {formatLongDate(inst.date)} · {timeRange}
            {inst.kind === "regular" && (
              <span className="ml-1.5 text-gray-400">(semanal)</span>
            )}
          </div>
          {inst.location && (
            <div className="text-xs text-gray-500">{inst.location}</div>
          )}
          {inst.description && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">
              {inst.description}
            </p>
          )}
          {inst.organizer_name && (
            <div className="mt-1 text-[11px] text-gray-400">
              Organiza {inst.organizer_name}
            </div>
          )}
        </div>
        {(onChat || onEdit || onDelete) && (
          <div className="flex shrink-0 items-center gap-2">
            {onChat && (
              <Button
                variant="secondary"
                onClick={onChat}
                disabled={chatBusy}
              >
                <MessageSquare className="h-4 w-4" />
                {chatBusy ? "Abriendo…" : "Chat"}
              </Button>
            )}
            {onEdit && (
              <Button variant="secondary" onClick={onEdit}>
                Editar
              </Button>
            )}
            {onDelete && (
              <Button variant="danger" onClick={onDelete}>
                Eliminar
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

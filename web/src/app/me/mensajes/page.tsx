"use client";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowLeftRight,
  CalendarDays,
  CalendarOff,
  Check,
  CheckCheck,
  LogOut,
  MessageCircle,
  MoreVertical,
  Pencil,
  Plus,
  Send,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  api,
  personFullName,
  type Conversation,
  type ConversationMemberPreview,
  type DMMessage,
  type HospitalDirectoryEntry,
  type ReadReceipt,
} from "@/lib/api";
import { Avatar } from "@/components/schedule/planning-grid";
import { useChatRealtime, type ChatEvent } from "@/lib/use-realtime";
import {
  MicButton,
  VoiceNoteBubble,
  VoiceRecorderBar,
} from "@/components/chat/voice-note";

/**
 * /me/mensajes — Phase 2A + 2B DM UI.
 *
 * Two-pane layout: conversation list on the left, active
 * conversation on the right. URL param `?c=<id>` makes the
 * active conversation linkable (the "Mensaje" buttons on the
 * directory deep-link here).
 *
 * Realtime: an SSE stream (useChatRealtime) pushes message / read /
 * message_deleted events while the page is open, so the room updates
 * the instant the server emits. The polls below are now only a
 * SAFETY NET for a dropped stream (offline, proxy hiccup, expired
 * session) — hence the relaxed intervals. Refresh-on-focus via
 * react-query defaults still catches the "I was in another tab" case.
 * Marking as read happens automatically the moment a conversation
 * becomes active and after a successful send.
 */
const ACTIVE_POLL_INTERVAL_MS = 20_000;
const LIST_POLL_INTERVAL_MS = 60_000;

export default function MensajesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  const activeIdParam = searchParams?.get("c");
  const activeId = activeIdParam ? Number(activeIdParam) : null;

  // We need our own person_id to identify "mine" message bubbles in
  // groups (where we can't infer it from a single peer like DMs do)
  // and to determine "am I the creator?" for the kick-someone-else
  // controls on the member panel.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const myPersonId = me.data?.person.id ?? null;

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: api.listMyConversations,
    // Poll the conversation list so unread counts + previews
    // refresh while the page is open. Focus-refetch also kicks
    // in via React Query's defaults.
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });

  // Realtime: push events while the page is open. Each event nudges
  // the relevant React Query cache so the UI updates instantly; the
  // slow polls above remain as a fallback if the stream drops.
  useChatRealtime((ev: ChatEvent) => {
    if (ev.type === "message") {
      // Append to the open conversation's message cache (dedupe by id
      // so the sender's own optimistic insert isn't duplicated).
      qc.setQueryData<DMMessage[]>(
        ["messages", ev.conversation_id],
        (prev) => {
          if (!prev) return prev; // not the open conversation — list refresh covers it
          if (prev.some((m) => m.id === ev.message.id)) return prev;
          return [...prev, ev.message];
        },
      );
      // List preview / ordering / unread badge.
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["my-unread-count"] });
    } else if (ev.type === "read") {
      // Someone read up to a point → their "Visto" can move.
      qc.invalidateQueries({
        queryKey: ["receipts", ev.conversation_id],
      });
    } else if (ev.type === "message_deleted") {
      qc.invalidateQueries({
        queryKey: ["messages", ev.conversation_id],
      });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  });

  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDmOpen, setComposeDmOpen] = useState(false);

  // Auto-select the first conversation on FIRST load only, so the
  // right pane doesn't start blank.
  //
  // The ref is critical: without it, this effect re-runs every
  // time activeId flips to null — which is exactly what the
  // mobile back arrow does — and immediately re-selects the same
  // first conversation. Visually the page doesn't change, so
  // users on phones report "the back button doesn't work".
  //
  // We mark "auto-select handled" once on the first render that
  // either has an activeId already (deep-link from the directory)
  // or successfully selects one. Subsequent renders are no-ops.
  const autoSelectHandledRef = useRef(false);
  useEffect(() => {
    if (autoSelectHandledRef.current) return;
    if (activeId !== null) {
      autoSelectHandledRef.current = true;
      return;
    }
    if (!conversations.data || conversations.data.length === 0) return;
    autoSelectHandledRef.current = true;
    const id = conversations.data[0].id;
    router.replace(`/me/mensajes?c=${id}`);
  }, [activeId, conversations.data, router]);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Mensajes</h1>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr] md:items-start">
        {/* Mobile flow: when a conversation is open, hide the
            list pane so the conversation fills the screen. The
            in-conversation header gets a back arrow that returns
            to the list (clears the ?c= query param). Desktop
            shows both panes side-by-side regardless. */}
        <div className={activeId !== null ? "hidden md:block" : ""}>
          <ConversationList
            conversations={conversations.data ?? []}
            loading={conversations.isLoading}
            activeId={activeId}
            onPick={(id) => router.replace(`/me/mensajes?c=${id}`)}
            onNewDM={() => setComposeDmOpen(true)}
            onNewGroup={() => setComposeOpen(true)}
          />
        </div>
        {/* Bound the chat pane to the dynamic viewport so the message
            list scrolls *internally* and the composer stays pinned to
            the bottom. `dvh` tracks the visual viewport, so when the
            mobile soft keyboard opens the pane shrinks with it instead
            of the whole page scrolling (which used to "descuadrar" the
            conversation). Floor with min-h only on desktop, where the
            keyboard never steals height. */}
        <div
          className={
            "h-[calc(100dvh-10rem)] md:h-[calc(100dvh-8rem)] md:min-h-[420px] "
            + (activeId === null ? "hidden md:block" : "")
          }
        >
          {activeId === null && (
            <EmptyPane>
              {conversations.isLoading
                ? "Cargando…"
                : "Abre una conversación desde la izquierda o busca a alguien en el directorio."}
            </EmptyPane>
          )}
          {activeId !== null && (
            <ConversationPane
              conversationId={activeId}
              conversation={conversations.data?.find(
                (c) => c.id === activeId,
              )}
              myPersonId={myPersonId}
              onBackToList={() => router.replace("/me/mensajes")}
              onMessageSent={() => {
                qc.invalidateQueries({ queryKey: ["conversations"] });
              }}
              onConversationDeleted={() => {
                // Drop the ?c=... so the right pane returns to the
                // empty state and the list re-fetches without the
                // hidden row. We refresh conversations + unread
                // count immediately so the deleted chat disappears
                // before the next poll tick.
                router.replace("/me/mensajes");
                qc.invalidateQueries({ queryKey: ["conversations"] });
                qc.invalidateQueries({ queryKey: ["my-unread-count"] });
              }}
            />
          )}
        </div>
      </div>
      {composeOpen && (
        <NewGroupModal
          onClose={() => setComposeOpen(false)}
          onCreated={(created) => {
            setComposeOpen(false);
            qc.invalidateQueries({ queryKey: ["conversations"] });
            router.replace(`/me/mensajes?c=${created.id}`);
          }}
        />
      )}
      {composeDmOpen && (
        <NewDMModal
          onClose={() => setComposeDmOpen(false)}
          onOpened={(conv) => {
            setComposeDmOpen(false);
            qc.invalidateQueries({ queryKey: ["conversations"] });
            router.replace(`/me/mensajes?c=${conv.id}`);
          }}
        />
      )}
    </div>
  );
}

function ConversationList({
  conversations,
  loading,
  activeId,
  onPick,
  onNewDM,
  onNewGroup,
}: {
  conversations: Conversation[];
  loading: boolean;
  activeId: number | null;
  onPick: (id: number) => void;
  /** Opens the "Nueva conversación" picker — single-select from
   * the hospital directory. Find-or-create semantics (if a DM
   * already exists we just reopen it). Mirrors the directory's
   * "Mensaje" button but lets users start a 1:1 without leaving
   * the chat surface. */
  onNewDM: () => void;
  /** Opens the "Nuevo grupo" composer — multi-select + title. */
  onNewGroup: () => void;
}) {
  return (
    <aside className="rounded-lg border border-gray-200 bg-white">
      {/* Two compose entry points, stacked. Side-by-side at this
          sidebar width (260px on desktop) cramps the labels and
          forces truncation; the extra vertical line is worth the
          legibility. Same dashed-border treatment so they read as
          a matched pair, not "primary + secondary". */}
      <div className="space-y-1.5 border-b border-gray-100 px-2 py-2">
        <button
          type="button"
          onClick={onNewDM}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Nueva conversación
        </button>
        <button
          type="button"
          onClick={onNewGroup}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Nuevo grupo
        </button>
      </div>
      {loading && (
        <p className="px-3 py-2 text-xs text-gray-500">Cargando…</p>
      )}
      {!loading && conversations.length === 0 && (
        <p className="px-3 py-2 text-xs text-gray-500">
          Aún no tienes conversaciones.
        </p>
      )}
      <ul className="max-h-[70vh] overflow-y-auto divide-y divide-gray-100">
        {conversations.map((c) => {
          const isActive = c.id === activeId;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className={
                  "block w-full text-left px-3 py-2 transition-colors "
                  + (isActive
                    ? "bg-brand-50"
                    : "hover:bg-gray-50")
                }
              >
                {c.kind === "group"
                  ? <GroupConversationRow conv={c} />
                  : <DMConversationRow conv={c} />}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function DMConversationRow({ conv }: { conv: Conversation }) {
  // `peer` is always populated on DMs (server contract / migration
  // 0088). The non-null assertion keeps the row code clean; if a
  // future bug sends back a kind="dm" without a peer, we'd rather
  // crash here loudly than render a half-empty row.
  const peer = conv.peer!;
  const peerLabel = personFullName({
    name: peer.name,
    first_name: peer.first_name,
    last_name: peer.last_name,
  });
  return (
    <div className="flex items-center gap-3">
      <Avatar
        name={peer.name}
        mine={false}
        imageUrl={peer.avatar_url}
        size="lg"
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-900">
            {peerLabel}
          </span>
          {conv.unread_count > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {conv.unread_count >= 99 ? "99+" : conv.unread_count}
            </span>
          )}
        </div>
        {peer.tenant_name && (
          <div className="truncate text-[11px] text-gray-500">
            {peer.tenant_name}
          </div>
        )}
        {conv.last_message_preview && (
          <div className="truncate text-xs text-gray-600 mt-0.5">
            {conv.last_message_preview}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupConversationRow({ conv }: { conv: Conversation }) {
  const title = conv.title ?? "Grupo sin nombre";
  return (
    <div className="flex items-center gap-3">
      <AvatarStack previews={conv.member_previews} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-gray-900">
            {title}
          </span>
          {conv.unread_count > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {conv.unread_count >= 99 ? "99+" : conv.unread_count}
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-gray-500">
          {conv.member_count} miembros
        </div>
        {conv.last_message_preview && (
          <div className="truncate text-xs text-gray-600 mt-0.5">
            {conv.last_message_preview}
          </div>
        )}
      </div>
    </div>
  );
}

/** Three overlapping avatars sized to match the lg avatar on a DM
 * row so groups and DMs line up visually in the list. White ring
 * on each so the stack reads as discrete circles, not a blob. */
function AvatarStack({
  previews,
}: {
  previews: ConversationMemberPreview[];
}) {
  // Three previews is the server contract — render them in reverse
  // so the leftmost ends up on top of the stack (natural reading
  // order). If the backend sends fewer (tiny group), the stack
  // collapses gracefully.
  const stack = previews.slice(0, 3);
  return (
    <div className="relative h-14 w-14 shrink-0">
      {stack.length === 0 && (
        // Fallback: empty group placeholder. Happens momentarily
        // right after creation if the previews haven't streamed
        // back yet.
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-500">
          <Users className="h-6 w-6" />
        </span>
      )}
      {stack.map((p, i) => (
        <span
          key={p.person_id}
          className="absolute rounded-full ring-2 ring-white"
          style={{
            top: i === 0 ? 0 : i === 1 ? 10 : 20,
            left: i === 0 ? 0 : i === 1 ? 14 : 28,
            zIndex: 3 - i,
          }}
        >
          <Avatar
            name={p.name}
            mine={false}
            imageUrl={p.avatar_url}
            size="md"
          />
        </span>
      ))}
    </div>
  );
}

function ConversationPane({
  conversationId,
  conversation,
  myPersonId,
  onBackToList,
  onMessageSent,
  onConversationDeleted,
}: {
  conversationId: number;
  conversation: Conversation | undefined;
  /** Caller's own person_id. Used to identify own messages in
   * group chats (DMs can infer this from the peer; groups can't)
   * and to gate creator-only "remove member" controls. Null
   * during the initial /api/me load — we treat that as "not me"
   * for safety. */
  myPersonId: number | null;
  /** Mobile-only "back to conversation list" callback. The
   * desktop layout shows both panes simultaneously and ignores
   * this. */
  onBackToList: () => void;
  onMessageSent: () => void;
  /** Caller hit "Borrar conversación" in the header menu and
   * the server confirmed (204). Parent should drop the active id
   * + invalidate the conversation list. */
  onConversationDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Group-only modals. Members panel doubles as the entry point
  // for "Añadir miembros" + "Salir del grupo" + creator-only
  // kicks; rename is a separate tiny modal because it's a single
  // text input.
  const [membersOpen, setMembersOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const isGroup = conversation?.kind === "group";
  const amCreator =
    isGroup
    && myPersonId !== null
    && conversation?.created_by_person_id === myPersonId;
  // Ref wrapping BOTH the kebab trigger and the popover panel so
  // the document-level click-outside check can ignore taps that
  // belong to either. Critical: React's onMouseDown stopPropagation
  // does NOT stop the *native* mousedown from bubbling to a
  // native document listener — that's the gotcha the previous
  // implementation tripped on. Without this ref check, clicking
  // "Borrar conversación" closed the menu before the button's
  // click handler could fire, so the confirm dialog never
  // appeared and the button looked dead.
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    function onDocPointer(e: MouseEvent | TouchEvent) {
      const root = menuRootRef.current;
      const target = e.target as Node | null;
      if (root && target && root.contains(target)) return;
      setMenuOpen(false);
    }
    // mousedown for desktop, touchstart for iPad / phone — without
    // touchstart, tapping outside the menu on iOS Safari doesn't
    // close it because mousedown fires synthetically and timing
    // is unreliable.
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
    };
  }, [menuOpen]);

  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.listMessages(conversationId),
    refetchInterval: ACTIVE_POLL_INTERVAL_MS,
  });

  // Read receipts for the open conversation ("Visto"). Polled on the
  // same cadence as the messages so the marker updates as the peer
  // catches up. Cheap query (one member scan); only runs while a
  // conversation is open.
  const receipts = useQuery({
    queryKey: ["receipts", conversationId],
    queryFn: () => api.getConversationReceipts(conversationId),
    refetchInterval: ACTIVE_POLL_INTERVAL_MS,
  });

  // WhatsApp-style "Visto" marker. We anchor it under the last
  // (highest-id) non-deleted message I authored, and label it from
  // how many of the OTHER members have read up to that id:
  //   DM    → "Visto" / "Enviado"
  //   group → "Visto por todos" / "Visto por N/M" / "Enviado"
  // The tooltip lists who saw it and when.
  const readMarker = useMemo(() => {
    const list = messages.data ?? [];
    const rcpts = receipts.data?.receipts ?? [];
    if (list.length === 0 || rcpts.length === 0) return null;
    const isGroupKind = conversation?.kind === "group";
    const isMineMsg = (m: DMMessage) =>
      m.author_person_id !== null
      && (isGroupKind
        ? myPersonId !== null && m.author_person_id === myPersonId
        : !!conversation
          && conversation.peer!.person_id !== m.author_person_id);
    let lastMineId: number | null = null;
    for (const m of list) {
      if (isMineMsg(m) && !m.deleted_at) lastMineId = m.id;
    }
    if (lastMineId === null) return null;
    const readers = rcpts.filter(
      (r) =>
        r.last_read_message_id !== null
        && r.last_read_message_id >= lastMineId!,
    );
    const total = rcpts.length;
    let label: string;
    if (readers.length === 0) label = "Enviado";
    else if (isGroupKind)
      label =
        readers.length === total
          ? "Visto por todos"
          : `Visto por ${readers.length}/${total}`;
    else label = "Visto";
    const title =
      readers
        .map((r) => {
          const when = r.last_read_at
            ? new Date(r.last_read_at).toLocaleString()
            : null;
          return r.name ? (when ? `${r.name} · ${when}` : r.name) : null;
        })
        .filter(Boolean)
        .join("\n") || undefined;
    return {
      messageId: lastMineId,
      label,
      read: readers.length > 0,
      title,
    };
  }, [messages.data, receipts.data, conversation, myPersonId]);

  // Auto-mark as read whenever we have the latest message id.
  // Server only moves the high-water mark forward; over-sending
  // is a no-op. Bumps both the conversation list (per-conv
  // unread → 0) and the sidebar badge (total unread count).
  useEffect(() => {
    const list = messages.data ?? [];
    if (list.length === 0) return;
    const lastId = list[list.length - 1].id;
    api
      .markConversationRead(conversationId, lastId)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["my-unread-count"] });
      })
      .catch(() => {
        // Swallow — read state is best-effort, not a hard fail.
      });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }, [messages.data, conversationId, qc]);

  // Auto-scroll to bottom whenever a new message arrives or we
  // switch conversations. useLayoutEffect to avoid a flash of
  // the wrong scroll position.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.data, conversationId]);

  const send = useMutation({
    mutationFn: (payload: { body?: string | null; voice_note_id?: number }) =>
      api.sendMessage(conversationId, payload),
    onSuccess: (msg) => {
      setDraft("");
      qc.setQueryData<DMMessage[]>(
        ["messages", conversationId],
        (prev) => (prev ? [...prev, msg] : [msg]),
      );
      onMessageSent();
    },
  });

  // Record → upload → send a voice note in one shot.
  const sendVoice = useMutation({
    mutationFn: async (rec: { blob: Blob; durationSeconds: number }) => {
      const vn = await api.uploadVoiceNote(rec.blob, rec.durationSeconds);
      return api.sendMessage(conversationId, { voice_note_id: vn.id });
    },
    onSuccess: (msg) => {
      setRecording(false);
      qc.setQueryData<DMMessage[]>(
        ["messages", conversationId],
        (prev) => (prev ? [...prev, msg] : [msg]),
      );
      onMessageSent();
    },
    onError: () => setRecording(false),
  });

  const deleteConv = useMutation({
    mutationFn: () => api.deleteConversation(conversationId),
    onSuccess: async () => {
      // Belt + suspenders: optimistically remove the conversation
      // from the cached list so the UI updates the instant the
      // 204 returns, even if the refetch is slow. Then force a
      // refetch (not just invalidate) so the server's filtered
      // list replaces our optimistic view.
      qc.setQueryData<Conversation[] | undefined>(
        ["conversations"],
        (prev) =>
          prev ? prev.filter((c) => c.id !== conversationId) : prev,
      );
      onConversationDeleted();
      await qc.refetchQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => {
      // Surface the failure so we don't silently swallow a 4xx/5xx.
      // Without this the conversation just stays put and the admin
      // thinks the button is broken (which is exactly what
      // "borrar conversation does not delete the conversation"
      // looked like). The native alert is intentionally annoying —
      // we'd rather the admin know.
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo borrar la conversación: ${msg}`);
    },
  });

  const deleteMsg = useMutation({
    mutationFn: (messageId: number) =>
      api.deleteMessage(conversationId, messageId),
    onSuccess: (_void, messageId) => {
      // Optimistic local update so the bubble flips to the
      // "(mensaje borrado)" rendering immediately, without
      // waiting for the next 5s poll. The next refetch will
      // confirm the server-side state.
      qc.setQueryData<DMMessage[]>(
        ["messages", conversationId],
        (prev) =>
          prev
            ? prev.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      body: null,
                      deleted_at: new Date().toISOString(),
                    }
                  : m,
              )
            : prev,
      );
      // The conversation list shows the latest preview — if we
      // just deleted the latest message that preview needs to
      // flip to "(mensaje borrado)" too.
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => {
      // Same reasoning as deleteConv: surface the failure rather
      // than silently leaving the message in place.
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo borrar el mensaje: ${msg}`);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate({ body });
  }

  function onDeleteConversation() {
    setMenuOpen(false);
    if (!conversation) return;
    // Confirm string varies per kind. DM = "with peer X"; group =
    // "this group". For groups it also reads less like "leave" so
    // we add a hint that the group keeps running for everyone else.
    const promptLine =
      conversation.kind === "group"
        ? `¿Borrar este grupo de tu lista?\n\n`
          + "Desaparecerá de tus mensajes pero el grupo sigue "
          + "activo para los demás. Si te escriben de nuevo, "
          + "volverá a aparecer. Si quieres salir del grupo "
          + "definitivamente, usa «Salir del grupo»."
        : (() => {
            const peerName = personFullName({
              name: conversation.peer!.name,
              first_name: conversation.peer!.first_name,
              last_name: conversation.peer!.last_name,
            });
            return (
              `¿Borrar esta conversación con ${peerName}?\n\n`
              + "Desaparecerá de tu lista. Si te escribe de nuevo, "
              + "volverá a aparecer. La otra persona conserva su "
              + "copia de los mensajes."
            );
          })();
    const ok = window.confirm(promptLine);
    if (!ok) return;
    deleteConv.mutate();
  }

  function onDeleteMessage(messageId: number) {
    const ok = window.confirm(
      "¿Borrar este mensaje?\n\n"
        + "La otra persona verá «(mensaje borrado)» en su lugar. "
        + "No se puede deshacer.",
    );
    if (!ok) return;
    deleteMsg.mutate(messageId);
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-lg border border-gray-200 bg-white">
      {conversation && (
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
          {/* Mobile back-to-list button. Hidden on md+ where both
              panes are side-by-side. Touch target sized to the
              44×44 iOS / WCAG minimum so it's reliably tappable
              even with a soft case or sweaty fingers. */}
          <button
            type="button"
            aria-label="Volver a la lista"
            onClick={onBackToList}
            className="flex h-11 w-11 -ml-2 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 active:bg-gray-200 md:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          {conversation.kind === "group"
            ? <GroupHeaderTitle
                conversation={conversation}
                onOpenMembers={() => setMembersOpen(true)}
              />
            : <DMHeaderTitle conversation={conversation} />}
          {/* Kebab menu. Items branch on kind: DMs get a single
              "Borrar conversación" entry; groups get rename / add
              members / leave + the same "Borrar conversación"
              (which only hides for the caller, see deleteConv).
              The wrapper div carries the ref the document-level
              click-outside check uses; any tap inside that subtree
              (kebab trigger OR popover items) is treated as
              "still inside the menu" so it doesn't auto-close. */}
          <div ref={menuRootRef} className="relative">
            <button
              type="button"
              aria-label="Más opciones"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex h-11 w-11 -mr-2 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 active:bg-gray-200"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-10 mt-1 w-60 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
              >
                {conversation.kind === "group" && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setRenameOpen(true);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Pencil className="h-4 w-4" />
                      Renombrar grupo
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setAddMembersOpen(true);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <UserPlus className="h-4 w-4" />
                      Añadir miembros
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        setMembersOpen(true);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Users className="h-4 w-4" />
                      Ver miembros
                    </button>
                    <div className="my-1 border-t border-gray-100" />
                  </>
                )}
                <button
                  type="button"
                  onClick={onDeleteConversation}
                  disabled={deleteConv.isPending}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  {deleteConv.isPending
                    ? "Borrando…"
                    : conversation.kind === "group"
                      ? "Borrar de mi lista"
                      : "Borrar conversación"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {conversation?.context_kind && (
        <ContextBanner kind={conversation.context_kind} />
      )}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
      >
        {messages.isLoading && (
          <p className="text-xs text-gray-500">Cargando mensajes…</p>
        )}
        {messages.data && messages.data.length === 0 && (
          <p className="text-xs text-gray-500">
            Aún no hay mensajes. Escribe el primero.
          </p>
        )}
        {messages.data?.map((m, idx) => {
          // "mine" identification:
          //  - DMs: anyone whose author_person_id != peer.person_id
          //    is me, even when myPersonId hasn't loaded yet.
          //    Keeping the legacy check avoids a flash of incorrect
          //    bubble alignment on first paint.
          //  - Groups: explicit myPersonId comparison. Falls back
          //    to "not mine" if /api/me hasn't resolved.
          const isMine =
            m.author_person_id !== null
            && (conversation?.kind === "group"
              ? myPersonId !== null && m.author_person_id === myPersonId
              : !!conversation
                && conversation.peer!.person_id !== m.author_person_id);
          // In a group chat, show the author's name above the
          // bubble — but only on the first bubble in a run by the
          // same author, and never on our own bubbles (you know
          // who you are). For DMs the peer name is already in the
          // header so we suppress it.
          const prev = idx > 0 ? messages.data![idx - 1] : null;
          const showAuthorLabel =
            conversation?.kind === "group"
            && !isMine
            && m.author_person_id !== null
            && m.author_person_id !== prev?.author_person_id;
          return (
            <MessageBubble
              key={m.id}
              message={m}
              mine={isMine}
              authorLabel={
                showAuthorLabel ? (m.author_name ?? "(eliminado)") : undefined
              }
              // Only the author can delete, and only while the
              // message hasn't already been soft-deleted. The
              // server enforces both — the UI guard is just to
              // avoid surfacing a button that would 404.
              onDelete={
                isMine && !m.deleted_at
                  ? () => onDeleteMessage(m.id)
                  : undefined
              }
              receipt={
                readMarker && m.id === readMarker.messageId
                  ? readMarker
                  : undefined
              }
            />
          );
        })}
      </div>
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-2 border-t border-gray-100 px-3 py-2"
      >
        {recording ? (
          // Recording UI replaces the text input + send for the
          // duration of the recording.
          <VoiceRecorderBar
            busy={sendVoice.isPending}
            onSend={(blob, durationSeconds) =>
              sendVoice.mutate({ blob, durationSeconds })
            }
            onCancel={() => setRecording(false)}
          />
        ) : (
          <>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e as unknown as FormEvent);
                }
              }}
              placeholder="Escribe un mensaje…"
              rows={1}
              maxLength={4000}
              className="flex-1 resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            {draft.trim() === "" ? (
              // Empty box → offer the mic (WhatsApp-style).
              <MicButton
                onClick={() => setRecording(true)}
                disabled={sendVoice.isPending}
              />
            ) : (
              <button
                type="submit"
                disabled={send.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {send.isPending ? "Enviando…" : "Enviar"}
              </button>
            )}
          </>
        )}
      </form>
      {isGroup && conversation && membersOpen && (
        <GroupMembersPanel
          conversation={conversation}
          myPersonId={myPersonId}
          amCreator={amCreator}
          onClose={() => setMembersOpen(false)}
          onAddMembers={() => {
            setMembersOpen(false);
            setAddMembersOpen(true);
          }}
          onLeft={() => {
            setMembersOpen(false);
            onConversationDeleted();
          }}
        />
      )}
      {isGroup && conversation && renameOpen && (
        <RenameGroupModal
          conversation={conversation}
          onClose={() => setRenameOpen(false)}
        />
      )}
      {isGroup && conversation && addMembersOpen && (
        <AddMembersModal
          conversation={conversation}
          onClose={() => setAddMembersOpen(false)}
        />
      )}
    </div>
  );
}

/** DM-flavoured chat header: peer avatar, full name, then a
 * subtitle that tries category · tenant. Identical to the legacy
 * single-kind header, factored out only so ConversationPane reads
 * cleanly when branching on kind. */
function DMHeaderTitle({
  conversation,
}: {
  conversation: Conversation;
}) {
  const peer = conversation.peer!;
  return (
    <>
      <Avatar
        name={peer.name}
        mine={false}
        imageUrl={peer.avatar_url}
        size="md"
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-semibold text-gray-900">
          {personFullName({
            name: peer.name,
            first_name: peer.first_name,
            last_name: peer.last_name,
          })}
        </div>
        <div className="truncate text-[11px] text-gray-500">
          {[peer.category_name, peer.tenant_name]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </>
  );
}

/** Group-flavoured chat header: avatar stack + title + member
 * count. The whole title block is clickable to pop the member
 * panel — Slack / WhatsApp pattern. */
function GroupHeaderTitle({
  conversation,
  onOpenMembers,
}: {
  conversation: Conversation;
  onOpenMembers: () => void;
}) {
  const title = conversation.title ?? "Grupo sin nombre";
  return (
    <button
      type="button"
      onClick={onOpenMembers}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-2 text-left hover:bg-gray-50"
    >
      {/* Stack uses md-size avatars to fit the header height. The
          relative box has w/h tuned to roughly match the lg-size
          single avatar used in DM headers so the row height
          stays consistent. */}
      <div className="relative h-9 w-12 shrink-0">
        {conversation.member_previews.slice(0, 3).map((p, i) => (
          <span
            key={p.person_id}
            className="absolute rounded-full ring-2 ring-white"
            style={{
              top: i === 0 ? 0 : i === 1 ? 4 : 8,
              left: i === 0 ? 0 : i === 1 ? 8 : 16,
              zIndex: 3 - i,
            }}
          >
            <Avatar
              name={p.name}
              mine={false}
              imageUrl={p.avatar_url}
              size="sm"
            />
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-semibold text-gray-900">
          {title}
        </div>
        <div className="truncate text-[11px] text-gray-500">
          {conversation.member_count} miembros · toca para ver
        </div>
      </div>
    </button>
  );
}

function MessageBubble({
  message,
  mine,
  authorLabel,
  onDelete,
  receipt,
}: {
  message: DMMessage;
  mine: boolean | undefined;
  /** Group chats only: name of the author rendered above the
   * bubble. Set on the first message of each run so consecutive
   * messages from the same person stay tight. Undefined elides
   * the line entirely. */
  authorLabel?: string;
  /** When set (own, non-deleted message) renders a small trash
   * icon that appears on hover (and is always visible on touch
   * devices that don't fire hover). Calling it triggers the
   * confirm dialog + DELETE request. */
  onDelete?: () => void;
  /** Read-receipt caption ("Visto" / "Enviado"). Set only on the
   * last message I authored; renders a small line under the bubble.
   * `read` flips the double-check icon on; `title` is the hover
   * tooltip (who/when). */
  receipt?: { label: string; read: boolean; title?: string };
}) {
  const isDeleted = !!message.deleted_at;
  // A live voice note renders the player; otherwise plain text (or
  // the "borrado" tombstone). Audio is purged on delete, so
  // message.voice_note is already null once deleted_at is set.
  const isVoice = !isDeleted && !!message.voice_note;
  const text = isDeleted
    ? "(mensaje borrado)"
    : (message.body ?? "");
  // A full-width column per message; the bubble ROW is what's capped
  // at 75% (so the cap resolves against the pane, not a shrunk
  // wrapper — the old bug that squeezed every incoming bubble to two
  // lines). items-end/start pushes the row to the correct side.
  return (
    <div
      className={
        "group flex flex-col gap-0.5 " + (mine ? "items-end" : "items-start")
      }
    >
      {authorLabel && (
        <span className="ml-1 text-[11px] font-medium text-gray-500">
          {authorLabel}
        </span>
      )}
      <div
        className={
          "flex max-w-[85%] items-center gap-1 sm:max-w-[75%] "
          // Own messages: trash on the inside (left) edge via reverse.
          + (mine ? "flex-row-reverse" : "")
        }
      >
        <div
          className={
            // min-w-0 + break-words lets the bubble shrink to content
            // and wrap long/unbroken strings instead of overflowing.
            "min-w-0 break-words rounded-2xl px-3 py-2 text-sm leading-snug "
            + (mine
              ? "bg-brand-600 text-white"
              : "bg-gray-100 text-gray-900")
            + (isDeleted ? " italic opacity-70" : "")
          }
        >
          {isVoice ? (
            <VoiceNoteBubble
              voiceNote={message.voice_note!}
              mine={!!mine}
            />
          ) : (
            text
          )}
        </div>
        {/* Trash: own, non-deleted messages only. Hover/touch reveal;
            always rendered for layout stability. */}
        {mine && onDelete && (
          <button
            type="button"
            aria-label="Borrar mensaje"
            onClick={onDelete}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {mine && receipt && (
        <span
          title={receipt.title}
          className={
            "mr-1 inline-flex items-center gap-1 text-[11px] "
            + (receipt.read ? "text-brand-600" : "text-gray-400")
          }
        >
          {receipt.read ? (
            <CheckCheck className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Check className="h-3.5 w-3.5 shrink-0" />
          )}
          {receipt.label}
        </span>
      )}
    </div>
  );
}

/** Banner shown atop a context-stamped conversation (migration
 * 0092), linking back to the reunión / bloqueo / cambio it's about.
 * The label is generic (we only carry kind + id, not a snapshot of
 * the entity) but the deep link lands the user on the right list. */
function ContextBanner({
  kind,
}: {
  kind: "meeting" | "bloqueo" | "swap";
}) {
  const meta = {
    meeting: {
      label: "Sobre una reunión",
      href: "/me/reuniones",
      icon: <CalendarDays className="h-3.5 w-3.5" />,
    },
    bloqueo: {
      label: "Sobre un bloqueo o ausencia",
      href: "/me/bloqueos",
      icon: <CalendarOff className="h-3.5 w-3.5" />,
    },
    swap: {
      label: "Sobre un cambio de turno",
      href: "/me/swaps",
      icon: <ArrowLeftRight className="h-3.5 w-3.5" />,
    },
  }[kind];
  return (
    <Link
      href={meta.href}
      className="flex items-center gap-2 border-b border-brand-100 bg-brand-50/60 px-4 py-2 text-xs text-brand-800 hover:bg-brand-50"
    >
      <span className="text-brand-600">{meta.icon}</span>
      <span className="font-medium">{meta.label}</span>
      <span className="ml-auto text-brand-600">Ver →</span>
    </Link>
  );
}

function EmptyPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-lg border border-dashed border-gray-200 bg-white p-6 text-center">
      <MessageCircle className="h-8 w-8 text-gray-400" />
      <p className="mt-2 max-w-xs text-sm text-gray-500">{children}</p>
    </div>
  );
}

/**
 * "Nueva conversación" — find-or-create a 1:1 DM. Tapping a row
 * fires `createOrGetDM` and navigates immediately; no confirm
 * step (DMs are idempotent on the sorted pair, so this is safe).
 * Mirrors the /me/directorio Mensaje button so users can start a
 * 1:1 without leaving the chat surface.
 */
function NewDMModal({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (conv: Conversation) => void;
}) {
  const [q, setQ] = useState("");
  // Track which row is "in flight" so we can grey it out and
  // prevent double-taps without disabling the whole list.
  const [pending, setPending] = useState<number | null>(null);
  const directory = useQuery({
    queryKey: ["hospital-directory", q],
    queryFn: () => api.listHospitalDirectory(q ? { q } : undefined),
  });
  const open = useMutation({
    mutationFn: (personId: number) => api.createOrGetDM(personId),
    onMutate: (personId) => setPending(personId),
    onSuccess: (conv) => onOpened(conv),
    onError: (err) => {
      setPending(null);
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo abrir la conversación: ${msg}`);
    },
  });
  const list = directory.data ?? [];
  return (
    <ModalShell title="Nueva conversación" onClose={onClose}>
      <div className="border-b border-gray-100 px-3 py-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nombre…"
          autoFocus
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
      </div>
      <ul className="flex-1 overflow-y-auto">
        {directory.isLoading && (
          <li className="px-3 py-2 text-xs text-gray-500">
            Cargando directorio…
          </li>
        )}
        {!directory.isLoading && list.length === 0 && (
          <li className="px-3 py-2 text-xs text-gray-500">
            Sin resultados.
          </li>
        )}
        {list.map((p) => {
          const isPending = pending === p.person_id;
          const isDisabled = open.isPending;
          const label = personFullName({
            name: p.person_name,
            first_name: p.person_first_name,
            last_name: p.person_last_name,
          });
          return (
            <li key={p.person_id}>
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => open.mutate(p.person_id)}
                className={
                  "flex w-full items-center gap-3 border-b border-gray-50 px-3 py-2 text-left transition-colors "
                  + (isPending
                    ? "bg-brand-50"
                    : "hover:bg-gray-50 disabled:opacity-50")
                }
              >
                <Avatar
                  name={p.person_name}
                  mine={false}
                  imageUrl={p.person_avatar_url}
                  size="md"
                />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-sm font-medium text-gray-900">
                    {label}
                  </div>
                  <div className="truncate text-[11px] text-gray-500">
                    {[p.category_name, p.tenant_name]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                {isPending && (
                  <span className="text-[11px] text-brand-700">
                    Abriendo…
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </ModalShell>
  );
}

/**
 * Shared shell for the three group-management modals + the new-group
 * composer. Centered card on desktop, full-screen sheet on mobile
 * so the directory picker has room to breathe. The X button is
 * always present; tapping the backdrop also dismisses.
 */
function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-0 sm:p-4">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-50 flex h-full w-full max-w-md flex-col rounded-none bg-white shadow-xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="-mr-2 flex h-10 w-10 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Search + multi-select directory picker. Used by NewGroupModal
 * (no exclusion set) and AddMembersModal (excludes existing
 * members so the picker can't double-add). The list is the same
 * /api/hospital/directory the directory page uses, filtered by a
 * substring `q`. Selection is a Set<person_id> — caller controls
 * the state so this is a controlled component.
 */
function DirectoryPicker({
  selected,
  onToggle,
  excludePersonIds,
}: {
  selected: Set<number>;
  onToggle: (e: HospitalDirectoryEntry) => void;
  /** Persons already in the group — hidden from the list rather
   * than greyed out, so the picker doesn't grow indefinitely as
   * members accumulate. Empty set for the new-group flow. */
  excludePersonIds: Set<number>;
}) {
  const [q, setQ] = useState("");
  // Debounce-free for now: the directory list is small (one
  // hospital) and the substring match is server-side. If the
  // hospital ever grows past a few hundred members we'll add a
  // 200ms debounce here.
  const directory = useQuery({
    queryKey: ["hospital-directory", q],
    queryFn: () => api.listHospitalDirectory(q ? { q } : undefined),
  });
  const list = useMemo(() => {
    const rows = directory.data ?? [];
    return rows.filter((r) => !excludePersonIds.has(r.person_id));
  }, [directory.data, excludePersonIds]);
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="border-b border-gray-100 px-3 py-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nombre…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
      </div>
      <ul className="flex-1 overflow-y-auto">
        {directory.isLoading && (
          <li className="px-3 py-2 text-xs text-gray-500">
            Cargando directorio…
          </li>
        )}
        {!directory.isLoading && list.length === 0 && (
          <li className="px-3 py-2 text-xs text-gray-500">
            Sin resultados.
          </li>
        )}
        {list.map((p) => {
          const isSelected = selected.has(p.person_id);
          const label = personFullName({
            name: p.person_name,
            first_name: p.person_first_name,
            last_name: p.person_last_name,
          });
          return (
            <li key={p.person_id}>
              <button
                type="button"
                onClick={() => onToggle(p)}
                className={
                  "flex w-full items-center gap-3 border-b border-gray-50 px-3 py-2 text-left "
                  + (isSelected
                    ? "bg-brand-50"
                    : "hover:bg-gray-50")
                }
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  readOnly
                  className="h-4 w-4 shrink-0 accent-brand-600"
                />
                <Avatar
                  name={p.person_name}
                  mine={false}
                  imageUrl={p.person_avatar_url}
                  size="md"
                />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-sm font-medium text-gray-900">
                    {label}
                  </div>
                  <div className="truncate text-[11px] text-gray-500">
                    {[p.category_name, p.tenant_name]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Two-pane modal for creating a group: title input + directory
 * picker. The "Crear" CTA is disabled until both a non-empty title
 * and at least one other person are chosen. On success the parent
 * navigates to the new conversation.
 */
function NewGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: Conversation) => void;
}) {
  const [title, setTitle] = useState("");
  // Persisting the full directory entry (not just person_id) so
  // the selection chips below the search can render the name +
  // avatar without re-querying the directory. Map keyed by id for
  // O(1) toggle.
  const [selected, setSelected] = useState<
    Map<number, HospitalDirectoryEntry>
  >(new Map());
  const selectedIds = useMemo(
    () => new Set(selected.keys()),
    [selected],
  );
  const create = useMutation({
    mutationFn: () =>
      api.createGroupChat({
        title: title.trim(),
        member_person_ids: Array.from(selected.keys()),
      }),
    onSuccess: (created) => onCreated(created),
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo crear el grupo: ${msg}`);
    },
  });
  const canCreate =
    title.trim().length > 0
    && selected.size >= 1
    && !create.isPending;
  return (
    <ModalShell title="Nuevo grupo" onClose={onClose}>
      <div className="border-b border-gray-100 px-3 py-3">
        <label className="block text-xs font-medium text-gray-700">
          Nombre del grupo
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="p. ej. Turno de noche"
          maxLength={120}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        {selected.size > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Array.from(selected.values()).map((p) => (
              <span
                key={p.person_id}
                className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700"
              >
                {personFullName({
                  name: p.person_name,
                  first_name: p.person_first_name,
                  last_name: p.person_last_name,
                })}
                <button
                  type="button"
                  aria-label="Quitar"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev);
                      next.delete(p.person_id);
                      return next;
                    })
                  }
                  className="rounded-full hover:bg-brand-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <DirectoryPicker
        selected={selectedIds}
        excludePersonIds={new Set()}
        onToggle={(p) =>
          setSelected((prev) => {
            const next = new Map(prev);
            if (next.has(p.person_id)) {
              next.delete(p.person_id);
            } else {
              next.set(p.person_id, p);
            }
            return next;
          })
        }
      />
      <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => create.mutate()}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
        >
          <Users className="h-4 w-4" />
          {create.isPending ? "Creando…" : "Crear grupo"}
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Member list for an open group. Always shows:
 *  - Every member as a row (we re-fetch on open so we don't
 *    need a separate "members" endpoint; the previews on the
 *    conversation are first three, full list comes via another
 *    serializer-derived field — see notes below)
 *  - "Añadir miembros" button at top
 *  - "Salir del grupo" button at bottom (red)
 *  - Creator-only kick button (UserMinus) next to non-creator
 *    rows
 *
 * Member list shape: we don't have a dedicated GET endpoint, so
 * the panel uses the `member_previews` from the conversation
 * itself — which is only the first three. For groups of ≤3 that's
 * already complete; for larger groups we show "+N más" and direct
 * the user to "Añadir miembros" / "Salir" without enumerating
 * every member. Building a full "list members" endpoint is on
 * the roadmap but not critical for v1.
 */
function GroupMembersPanel({
  conversation,
  myPersonId,
  amCreator,
  onClose,
  onAddMembers,
  onLeft,
}: {
  conversation: Conversation;
  myPersonId: number | null;
  amCreator: boolean;
  onClose: () => void;
  onAddMembers: () => void;
  /** Caller successfully left the group (or was the last member
   * and removed themselves). Parent treats this like a
   * "conversation deleted" and clears the active id. */
  onLeft: () => void;
}) {
  const qc = useQueryClient();
  const leave = useMutation({
    mutationFn: () => api.leaveGroupChat(conversation.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      onLeft();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo salir del grupo: ${msg}`);
    },
  });
  const kick = useMutation({
    mutationFn: (personId: number) =>
      api.removeGroupMember(conversation.id, personId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo quitar al miembro: ${msg}`);
    },
  });
  function onLeave() {
    const ok = window.confirm(
      "¿Salir del grupo?\n\n"
        + "No volverás a recibir mensajes. Otro miembro podrá "
        + "añadirte de nuevo si lo necesitas.",
    );
    if (!ok) return;
    leave.mutate();
  }
  function onKick(personId: number, name: string) {
    const ok = window.confirm(
      `¿Quitar a ${name} del grupo?\n\n`
        + "Dejará de recibir mensajes. Podrás volver a añadirle "
        + "más tarde si lo necesitas.",
    );
    if (!ok) return;
    kick.mutate(personId);
  }
  const previews = conversation.member_previews;
  const extra = conversation.member_count - previews.length;
  return (
    <ModalShell title="Miembros" onClose={onClose}>
      <div className="border-b border-gray-100 px-3 py-3">
        <button
          type="button"
          onClick={onAddMembers}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <UserPlus className="h-4 w-4" />
          Añadir miembros
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto divide-y divide-gray-100">
        {previews.map((p) => {
          const isMe = p.person_id === myPersonId;
          const label = personFullName({
            name: p.name,
            first_name: p.first_name,
            last_name: p.last_name,
          });
          const isCreatorRow =
            conversation.created_by_person_id === p.person_id;
          return (
            <li
              key={p.person_id}
              className="flex items-center gap-3 px-3 py-2"
            >
              <Avatar
                name={p.name}
                mine={isMe}
                imageUrl={p.avatar_url}
                size="md"
              />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm font-medium text-gray-900">
                  {label}
                  {isMe && (
                    <span className="ml-1 text-[11px] font-normal text-gray-500">
                      (tú)
                    </span>
                  )}
                </div>
                {isCreatorRow && (
                  <div className="truncate text-[11px] text-gray-500">
                    Creador
                  </div>
                )}
              </div>
              {amCreator && !isMe && (
                <button
                  type="button"
                  aria-label={`Quitar a ${label}`}
                  onClick={() => onKick(p.person_id, label)}
                  disabled={kick.isPending}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <UserMinus className="h-4 w-4" />
                </button>
              )}
            </li>
          );
        })}
        {extra > 0 && (
          <li className="px-3 py-2 text-xs text-gray-500">
            + {extra} miembro{extra === 1 ? "" : "s"} más
          </li>
        )}
      </ul>
      <div className="border-t border-gray-100 px-3 py-3">
        <button
          type="button"
          onClick={onLeave}
          disabled={leave.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          <LogOut className="h-4 w-4" />
          {leave.isPending ? "Saliendo…" : "Salir del grupo"}
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Single-input modal for renaming a group. Any member can do it —
 * matches the agreed permission model.
 */
function RenameGroupModal({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(conversation.title ?? "");
  const rename = useMutation({
    mutationFn: () =>
      api.renameGroupChat(conversation.id, title.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo renombrar: ${msg}`);
    },
  });
  const canSave =
    title.trim().length > 0
    && title.trim() !== conversation.title
    && !rename.isPending;
  return (
    <ModalShell title="Renombrar grupo" onClose={onClose}>
      <div className="px-3 py-3">
        <label className="block text-xs font-medium text-gray-700">
          Nombre del grupo
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          autoFocus
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
      </div>
      <div className="mt-auto flex items-center justify-end gap-2 border-t border-gray-100 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => rename.mutate()}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
        >
          {rename.isPending ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Directory picker scoped to the group: existing members are
 * excluded from the list so the same person can't be added twice.
 * New members see the full conversation history once added — we
 * lean on the in-modal hint to make that obvious.
 */
function AddMembersModal({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const existingIds = useMemo(
    () =>
      new Set(conversation.member_previews.map((p) => p.person_id)),
    [conversation.member_previews],
  );
  const [selected, setSelected] = useState<
    Map<number, HospitalDirectoryEntry>
  >(new Map());
  const selectedIds = useMemo(
    () => new Set(selected.keys()),
    [selected],
  );
  const add = useMutation({
    mutationFn: () =>
      api.addGroupMembers(
        conversation.id,
        Array.from(selected.keys()),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo añadir: ${msg}`);
    },
  });
  return (
    <ModalShell title="Añadir miembros" onClose={onClose}>
      <p className="border-b border-gray-100 px-3 py-2 text-xs text-gray-500">
        Verán todo el historial del grupo desde su entrada.
      </p>
      <DirectoryPicker
        selected={selectedIds}
        excludePersonIds={existingIds}
        onToggle={(p) =>
          setSelected((prev) => {
            const next = new Map(prev);
            if (next.has(p.person_id)) {
              next.delete(p.person_id);
            } else {
              next.set(p.person_id, p);
            }
            return next;
          })
        }
      />
      <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={selected.size === 0 || add.isPending}
          onClick={() => add.mutate()}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
        >
          <UserPlus className="h-4 w-4" />
          {add.isPending ? "Añadiendo…" : "Añadir"}
        </button>
      </div>
    </ModalShell>
  );
}

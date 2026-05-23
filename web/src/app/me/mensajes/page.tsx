"use client";
import {
  useEffect,
  useLayoutEffect,
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
import { ArrowLeft, MessageCircle, Send } from "lucide-react";
import {
  api,
  personLastName,
  type DMConversation,
  type DMMessage,
} from "@/lib/api";
import { Avatar } from "@/components/schedule/planning-grid";

/**
 * /me/mensajes — Phase 2A + 2B DM UI.
 *
 * Two-pane layout: conversation list on the left, active
 * conversation on the right. URL param `?c=<id>` makes the
 * active conversation linkable (the "Mensaje" buttons on the
 * directory deep-link here).
 *
 * No realtime (Phase 3 territory). Polling strategy:
 *   - Active conversation: 5s. Tight enough that the room
 *     feels responsive without committing to websockets.
 *   - Conversation list (background): 30s. Refresh-on-focus
 *     via react-query defaults catches the "I was in another
 *     tab" case.
 * Marking as read happens automatically the moment a
 * conversation becomes active and after a successful send.
 */
const ACTIVE_POLL_INTERVAL_MS = 5_000;
const LIST_POLL_INTERVAL_MS = 30_000;

export default function MensajesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();

  const activeIdParam = searchParams?.get("c");
  const activeId = activeIdParam ? Number(activeIdParam) : null;

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: api.listMyConversations,
    // Poll the conversation list so unread counts + previews
    // refresh while the page is open. Focus-refetch also kicks
    // in via React Query's defaults.
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });

  // Auto-select the first conversation on first load so the
  // right pane never starts blank when there are any.
  useEffect(() => {
    if (activeId !== null) return;
    if (!conversations.data || conversations.data.length === 0) return;
    const id = conversations.data[0].id;
    router.replace(`/me/mensajes?c=${id}`);
  }, [activeId, conversations.data, router]);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Mensajes</h1>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
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
          />
        </div>
        <div className={activeId === null ? "hidden md:block min-h-[420px]" : "min-h-[420px]"}>
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
              onBackToList={() => router.replace("/me/mensajes")}
              onMessageSent={() => {
                qc.invalidateQueries({ queryKey: ["conversations"] });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationList({
  conversations,
  loading,
  activeId,
  onPick,
}: {
  conversations: DMConversation[];
  loading: boolean;
  activeId: number | null;
  onPick: (id: number) => void;
}) {
  return (
    <aside className="rounded-lg border border-gray-200 bg-white">
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
          const peerLabel = personLastName({
            name: c.peer.name,
            last_name: c.peer.last_name,
          });
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
                <div className="flex items-center gap-2">
                  <Avatar
                    name={c.peer.name}
                    mine={false}
                    imageUrl={c.peer.avatar_url}
                  />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-gray-900">
                        {peerLabel}
                      </span>
                      {c.unread_count > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                          {c.unread_count >= 99 ? "99+" : c.unread_count}
                        </span>
                      )}
                    </div>
                    {c.peer.tenant_name && (
                      <div className="truncate text-[11px] text-gray-500">
                        {c.peer.tenant_name}
                      </div>
                    )}
                    {c.last_message_preview && (
                      <div className="truncate text-xs text-gray-600 mt-0.5">
                        {c.last_message_preview}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function ConversationPane({
  conversationId,
  conversation,
  onBackToList,
  onMessageSent,
}: {
  conversationId: number;
  conversation: DMConversation | undefined;
  /** Mobile-only "back to conversation list" callback. The
   * desktop layout shows both panes simultaneously and ignores
   * this. */
  onBackToList: () => void;
  onMessageSent: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.listMessages(conversationId),
    refetchInterval: ACTIVE_POLL_INTERVAL_MS,
  });

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
    mutationFn: (body: string) => api.sendMessage(conversationId, body),
    onSuccess: (msg) => {
      setDraft("");
      qc.setQueryData<DMMessage[]>(
        ["messages", conversationId],
        (prev) => (prev ? [...prev, msg] : [msg]),
      );
      onMessageSent();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate(body);
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-lg border border-gray-200 bg-white">
      {conversation && (
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
          {/* Mobile back-to-list button. Hidden on md+ where both
              panes are side-by-side. */}
          <button
            type="button"
            aria-label="Volver a la lista"
            onClick={onBackToList}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-100 md:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Avatar
            name={conversation.peer.name}
            mine={false}
            imageUrl={conversation.peer.avatar_url}
          />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold text-gray-900">
              {personLastName({
                name: conversation.peer.name,
                last_name: conversation.peer.last_name,
              })}
            </div>
            <div className="truncate text-[11px] text-gray-500">
              {[
                conversation.peer.category_name,
                conversation.peer.tenant_name,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
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
        {messages.data?.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mine={m.author_person_id !== null
              && conversation
              && conversation.peer.person_id !== m.author_person_id}
          />
        ))}
      </div>
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-2 border-t border-gray-100 px-3 py-2"
      >
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
        <button
          type="submit"
          disabled={draft.trim() === "" || send.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {send.isPending ? "Enviando…" : "Enviar"}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  mine,
}: {
  message: DMMessage;
  mine: boolean | undefined;
}) {
  const text = message.body ?? "(mensaje borrado)";
  return (
    <div
      className={
        "flex " + (mine ? "justify-end" : "justify-start")
      }
    >
      <div
        className={
          "max-w-[75%] rounded-2xl px-3 py-2 text-sm leading-snug "
          + (mine
            ? "bg-brand-600 text-white"
            : "bg-gray-100 text-gray-900")
          + (message.deleted_at ? " italic opacity-70" : "")
        }
      >
        {text}
      </div>
    </div>
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

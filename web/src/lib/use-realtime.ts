"use client";
import { useEffect, useRef } from "react";
import { api, API_BASE_URL, type DMMessage } from "@/lib/api";

/**
 * Realtime chat events pushed over SSE. Mirror of the backend payloads
 * in app/routes/dms.py (broker.publish calls).
 */
export type ChatEvent =
  | { type: "message"; conversation_id: number; message: DMMessage }
  | {
      type: "read";
      conversation_id: number;
      person_id: number;
      last_read_message_id: number;
    }
  | { type: "message_deleted"; conversation_id: number; message_id: number };

/**
 * Hold an SSE connection to /api/realtime/stream for as long as the
 * calling component is mounted, invoking `onEvent` for each pushed
 * event. Replaces aggressive polling — the message list / receipts /
 * unread badge update the instant the server emits, and the existing
 * slow polls stay only as a safety net if the stream drops.
 *
 * Auth: EventSource can't send our Bearer header, so we mint a
 * short-lived ticket (api.createRealtimeTicket) and pass it in the
 * URL. The ticket is single-purpose and expires in ~60s. Native
 * EventSource auto-reconnects to the *same* URL, but our ticket would
 * be stale by then — so we drive reconnection ourselves: on error we
 * close, mint a fresh ticket, and retry with capped exponential
 * backoff. A persistent failure (offline, expired session) just keeps
 * the page on its fallback polls.
 */
export function useChatRealtime(
  onEvent: (e: ChatEvent) => void,
  opts?: { enabled?: boolean },
): void {
  const enabled = opts?.enabled ?? true;
  // Latest handler in a ref so a new callback identity each render
  // doesn't tear down and rebuild the connection.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let es: EventSource | null = null;
    let cancelled = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (cancelled) return;
      retry += 1;
      // Exponential backoff capped at 30s, plus jitter so a server
      // blip doesn't make every client reconnect in lockstep.
      const base = Math.min(30_000, 1_000 * 2 ** Math.min(retry, 5));
      const delay = base + Math.floor(Math.random() * 500);
      timer = setTimeout(connect, delay);
    };

    const connect = async () => {
      if (cancelled) return;
      try {
        const { ticket } = await api.createRealtimeTicket();
        if (cancelled) return;
        const url =
          `${API_BASE_URL}/api/realtime/stream`
          + `?ticket=${encodeURIComponent(ticket)}`;
        es = new EventSource(url);
        es.onopen = () => {
          retry = 0; // healthy connection — reset backoff
        };
        es.onmessage = (ev) => {
          if (!ev.data) return; // heartbeat comments arrive without data
          try {
            handlerRef.current(JSON.parse(ev.data) as ChatEvent);
          } catch {
            // ignore a malformed frame
          }
        };
        es.onerror = () => {
          // Don't trust EventSource's built-in retry (stale ticket) —
          // close and reconnect with a fresh one under our backoff.
          es?.close();
          es = null;
          scheduleReconnect();
        };
      } catch {
        // Ticket mint failed (offline / expired session). Back off and
        // retry; fallback polls keep the UI current meanwhile.
        scheduleReconnect();
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [enabled]);
}

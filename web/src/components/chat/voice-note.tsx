"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Send, X } from "lucide-react";
import { api, type VoiceNote } from "@/lib/api";

/** mm:ss from a second count. */
function fmt(total: number): string {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Pick a mimeType the browser's MediaRecorder actually supports.
 * Chrome/Firefox → webm/opus; Safari → mp4. Empty string lets the
 * browser choose its default (still produces a playable blob). */
function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

/**
 * Inline recording bar. Mounts → asks for the mic and starts
 * recording immediately; shows a live timer. "Enviar" stops and hands
 * the blob up; the X (or unmount) discards. Caps at maxSeconds.
 */
export function VoiceRecorderBar({
  onSend,
  onCancel,
  busy = false,
  maxSeconds = 120,
}: {
  onSend: (blob: Blob, durationSeconds: number) => void;
  onCancel: () => void;
  busy?: boolean;
  maxSeconds?: number;
}) {
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  // "send" vs "cancel" is decided before we call stop(); onstop reads it.
  const intentRef = useRef<"send" | "cancel">("cancel");
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stopTracks = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (tickRef.current) clearInterval(tickRef.current);
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const mime = pickMime();
        const rec = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        recorderRef.current = rec;
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          stopTracks();
          if (intentRef.current === "send") {
            const blob = new Blob(chunksRef.current, {
              type: rec.mimeType || "audio/webm",
            });
            const dur = (performance.now() - startedAtRef.current) / 1000;
            if (blob.size > 0) onSend(blob, dur);
            else onCancel();
          }
        };
        startedAtRef.current = performance.now();
        rec.start();
        tickRef.current = setInterval(() => {
          setSeconds((s) => {
            const next = s + 1;
            if (next >= maxSeconds) {
              // Auto-stop at the cap.
              intentRef.current = "send";
              try {
                rec.state !== "inactive" && rec.stop();
              } catch {
                /* noop */
              }
            }
            return next;
          });
        }, 1000);
      } catch {
        if (!cancelled) {
          setError("No se pudo acceder al micrófono.");
        }
      }
    })();

    return () => {
      cancelled = true;
      // Unmount = discard. Don't fire onSend.
      intentRef.current = "cancel";
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* noop */
        }
      }
      stopTracks();
    };
    // Mount-once: handlers are stable via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopWith = (intent: "send" | "cancel") => {
    intentRef.current = intent;
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    if (intent === "cancel") onCancel();
  };

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
        <span>{error}</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 text-rose-700 hover:bg-rose-100"
        >
          Cerrar
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center gap-2 rounded-md bg-gray-50 px-3 py-2">
      <button
        type="button"
        aria-label="Cancelar grabación"
        onClick={() => stopWith("cancel")}
        disabled={busy}
        className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 hover:bg-gray-200 hover:text-rose-600 disabled:opacity-50"
      >
        <X className="h-4 w-4" />
      </button>
      <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
      <span className="flex-1 text-sm tabular-nums text-gray-700">
        Grabando… {fmt(seconds)}
      </span>
      <button
        type="button"
        aria-label="Enviar nota de voz"
        onClick={() => stopWith("send")}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        <Send className="h-4 w-4" />
        {busy ? "Enviando…" : "Enviar"}
      </button>
    </div>
  );
}

/** Mic button shown in the composer when the text box is empty. */
export function MicButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label="Grabar nota de voz"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-2 text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
    >
      <Mic className="h-4 w-4" />
    </button>
  );
}

/**
 * Playback bubble for a received/sent voice note. Lazily fetches the
 * audio (auth'd) on first play, then play/pauses a hidden <audio>.
 * Shows a progress bar + elapsed/total time.
 */
export function VoiceNoteBubble({
  voiceNote,
  mine,
}: {
  voiceNote: VoiceNote;
  mine: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const total = voiceNote.duration_seconds;

  useEffect(() => {
    return () => {
      // Revoke the blob URL + tear down audio on unmount.
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current;
    setLoading(true);
    try {
      const url = await api.fetchVoiceNoteAudio(voiceNote.url);
      urlRef.current = url;
      const a = new Audio(url);
      a.addEventListener("timeupdate", () =>
        setElapsed(a.currentTime),
      );
      a.addEventListener("ended", () => {
        setPlaying(false);
        setElapsed(0);
      });
      a.addEventListener("pause", () => setPlaying(false));
      a.addEventListener("play", () => setPlaying(true));
      audioRef.current = a;
      return a;
    } catch {
      setError(true);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    const a = await ensureAudio();
    if (!a) return;
    if (a.paused) {
      void a.play();
    } else {
      a.pause();
    }
  };

  const pct =
    total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 0;
  const accentTrack = mine ? "bg-white/30" : "bg-gray-300";
  const accentFill = mine ? "bg-white" : "bg-brand-600";
  const iconColor = mine ? "text-white" : "text-brand-700";

  return (
    <div className="flex min-w-[180px] items-center gap-2">
      <button
        type="button"
        aria-label={playing ? "Pausar" : "Reproducir"}
        onClick={toggle}
        disabled={loading || error}
        className={
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full "
          + (mine ? "bg-white/20 hover:bg-white/30" : "bg-white hover:bg-gray-50")
          + " disabled:opacity-50"
        }
      >
        {playing ? (
          <Pause className={"h-4 w-4 " + iconColor} />
        ) : (
          <Play className={"h-4 w-4 " + iconColor} />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className={"h-1.5 w-full overflow-hidden rounded-full " + accentTrack}>
          <div
            className={"h-full rounded-full " + accentFill}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div
          className={
            "mt-1 text-[10px] tabular-nums "
            + (mine ? "text-white/80" : "text-gray-500")
          }
        >
          {error
            ? "No se pudo cargar"
            : playing || elapsed > 0
              ? `${fmt(elapsed)} / ${fmt(total)}`
              : fmt(total)}
        </div>
      </div>
    </div>
  );
}

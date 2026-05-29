"use client";

/**
 * Notificaciones panel inside /me/settings (migration 0089).
 *
 * Three states the user might be in:
 *
 *  1. Push unsupported (old browser, SSR). Hide the panel — no
 *     point telling someone "your browser can't do this" when
 *     they probably can't switch.
 *
 *  2. Push supported but not installed PWA. Show a hint: "Para
 *     recibir notificaciones tienes que instalar la app primero".
 *     Subscribing in a tab on iOS would silently no-op anyway, so
 *     gate the Activar button.
 *
 *  3. Push supported + installed PWA. Show:
 *       - Activar / Desactivar button for THIS device's state
 *       - List of other devices already subscribed (revoke each)
 *
 * State source of truth: the backend's GET /api/push/subscriptions
 * (server-authoritative). The localStorage subscription-id is just
 * the matcher for "which row is this device?".
 */

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Bell, BellOff, Smartphone, X } from "lucide-react";

import { Card } from "@/components/admin/ui";
import { api } from "@/lib/api";
import {
  getCurrentSubscriptionId,
  getPermissionState,
  isInstalledPwa,
  isPushSupported,
  revokeSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push";

export function NotificationsPanel() {
  // Computed on mount so SSR doesn't crash on `Notification`.
  // We also re-compute on focus / permission-change events so the
  // panel reflects OS-level changes (user revoked permission in
  // system settings while the panel was open).
  const [supported, setSupported] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [permission, setPermission] =
    useState<NotificationPermission | "unsupported">("unsupported");
  const [currentId, setCurrentId] = useState<number | null>(null);

  useEffect(() => {
    function recompute() {
      setSupported(isPushSupported());
      setInstalled(isInstalledPwa());
      setPermission(getPermissionState());
      setCurrentId(getCurrentSubscriptionId());
    }
    recompute();
    // Re-check on tab focus — covers "user toggled permission
    // in system settings, then came back".
    window.addEventListener("focus", recompute);
    // matchMedia change covers "user installed the app while the
    // tab was open" — rare but cheap to handle.
    const mql = window.matchMedia?.("(display-mode: standalone)");
    const onMql = () => recompute();
    mql?.addEventListener("change", onMql);
    return () => {
      window.removeEventListener("focus", recompute);
      mql?.removeEventListener("change", onMql);
    };
  }, []);

  // Don't render anything in state 1 (unsupported / SSR).
  if (!supported) return null;

  return (
    <div className="mt-6 max-w-xl">
      <Card>
        <div className="p-4">
          <div className="flex items-start gap-3">
            <Bell className="mt-0.5 h-5 w-5 text-gray-500" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-gray-900">
                Notificaciones
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                Recibe avisos de mensajes nuevos directamente en el
                dispositivo, incluso cuando Trivu no está abierto.
              </p>
            </div>
          </div>
          <div className="mt-4">
            {!installed ? (
              <NotInstalledHint />
            ) : permission === "denied" ? (
              <PermissionDeniedHint />
            ) : (
              <DeviceControls
                currentId={currentId}
                onSubscribed={(id) => setCurrentId(id)}
                onUnsubscribed={() => setCurrentId(null)}
              />
            )}
          </div>
          <DeviceList currentId={currentId} />
        </div>
      </Card>
    </div>
  );
}

function NotInstalledHint() {
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      Para recibir notificaciones tienes que instalar Trivu como
      app primero (Compartir → Añadir a pantalla de inicio en iOS;
      botón «Instalar» en Chrome/Edge).
    </p>
  );
}

function PermissionDeniedHint() {
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      Has bloqueado las notificaciones para Trivu. Para
      reactivarlas tienes que abrir la configuración del sistema
      (iOS: Ajustes → Notificaciones → Trivu) o del navegador y
      permitir las notificaciones.
    </p>
  );
}

function DeviceControls({
  currentId,
  onSubscribed,
  onUnsubscribed,
}: {
  currentId: number | null;
  onSubscribed: (id: number) => void;
  onUnsubscribed: () => void;
}) {
  const qc = useQueryClient();
  const subscribe = useMutation({
    mutationFn: () => subscribeToPush(),
    onSuccess: (id) => {
      onSubscribed(id);
      qc.invalidateQueries({ queryKey: ["push-subscriptions"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(msg);
    },
  });
  const unsubscribe = useMutation({
    mutationFn: () => unsubscribeFromPush(),
    onSuccess: () => {
      onUnsubscribed();
      qc.invalidateQueries({ queryKey: ["push-subscriptions"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo desactivar: ${msg}`);
    },
  });
  // "This device active" is the union of (server-side row exists
  // for our localStorage id) AND (browser permission still
  // granted). If the user revoked permission via system settings
  // we should offer "Activar de nuevo" rather than "Desactivar".
  if (currentId !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
        <span className="text-sm text-gray-700">
          Notificaciones activas en este dispositivo.
        </span>
        <button
          type="button"
          onClick={() => unsubscribe.mutate()}
          disabled={unsubscribe.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-white disabled:opacity-50"
        >
          <BellOff className="h-3.5 w-3.5" />
          {unsubscribe.isPending ? "Desactivando…" : "Desactivar"}
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => subscribe.mutate()}
      disabled={subscribe.isPending}
      className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-brand-700 disabled:opacity-50"
    >
      <Bell className="h-4 w-4" />
      {subscribe.isPending
        ? "Activando…"
        : "Activar en este dispositivo"}
    </button>
  );
}

function DeviceList({ currentId }: { currentId: number | null }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["push-subscriptions"],
    queryFn: api.listMyPushSubscriptions,
  });
  const revoke = useMutation({
    mutationFn: (id: number) => revokeSubscription(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["push-subscriptions"] });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`No se pudo eliminar: ${msg}`);
    },
  });
  if (list.isLoading) {
    return (
      <p className="mt-4 text-xs text-gray-500">
        Cargando dispositivos…
      </p>
    );
  }
  const subs = list.data ?? [];
  if (subs.length === 0) {
    return null;
  }
  // The "other devices" header only makes sense when there's at
  // least one device that ISN'T this one. If the user has only
  // their current device subscribed, the device-controls section
  // already says everything.
  const otherCount = subs.filter((s) => s.id !== currentId).length;
  return (
    <div className="mt-4">
      <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {otherCount > 0
          ? "Dispositivos suscritos"
          : "Este dispositivo"}
      </h4>
      <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200">
        {subs.map((s) => {
          const isCurrent = s.id === currentId;
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <Smartphone className="h-4 w-4 shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm text-gray-900">
                  {prettyUserAgent(s.user_agent)}
                  {isCurrent && (
                    <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium text-brand-700">
                      Este dispositivo
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-gray-500">
                  {s.last_used_at
                    ? `Última actividad ${formatRelative(s.last_used_at)}`
                    : `Añadido ${formatRelative(s.created_at)}`}
                </div>
              </div>
              <button
                type="button"
                aria-label="Eliminar dispositivo"
                onClick={() => revoke.mutate(s.id)}
                disabled={revoke.isPending}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Crude UA → human label. We don't try to be exhaustive — just
 * enough that a list of three devices is distinguishable
 * ("iPhone Safari" vs "Mac Chrome"). */
function prettyUserAgent(ua: string | null): string {
  if (!ua) return "Dispositivo desconocido";
  const isIPhone = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = /Macintosh|Mac OS X/.test(ua) && !isIPhone;
  const isWindows = /Windows/.test(ua);
  const isLinux = /Linux/.test(ua) && !isAndroid;
  const isFirefox = /Firefox/.test(ua);
  const isEdge = /Edg\//.test(ua);
  const isChrome = /Chrome/.test(ua) && !isEdge;
  const isSafari = /Safari/.test(ua) && !isChrome && !isEdge;
  const platform = isIPhone
    ? "iPhone"
    : isAndroid
      ? "Android"
      : isMac
        ? "Mac"
        : isWindows
          ? "Windows"
          : isLinux
            ? "Linux"
            : "Dispositivo";
  const browser = isFirefox
    ? "Firefox"
    : isEdge
      ? "Edge"
      : isChrome
        ? "Chrome"
        : isSafari
          ? "Safari"
          : "navegador";
  return `${platform} · ${browser}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return "hace unos segundos";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `hace ${day} d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `hace ${mo} meses`;
  return new Date(iso).toLocaleDateString("es-ES");
}

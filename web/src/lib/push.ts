/**
 * Web Push helpers (migration 0089).
 *
 * Glue between the browser's PushManager API and our backend
 * /api/push/* endpoints. The Notificaciones panel in /me/settings
 * is the only caller today; we keep the surface small and pure-
 * function so it's easy to reason about.
 *
 * Storage:
 *  - localStorage key `trivu:push:subscription-id` holds the
 *    server-side id of the current device's subscription so the
 *    "this device" row in the manage-devices list can be matched
 *    and so unsubscribe knows what DELETE to fire. Stale ids
 *    (server deleted the row, browser still has the key) are
 *    handled by treating the DELETE as idempotent.
 *
 * iOS PWA gotcha: Notification.requestPermission() must be called
 * from a user gesture (click handler), and Push only works in the
 * installed PWA, not in a Safari tab. The panel UI gates the
 * "Activar" button on `isInstalledPwa()` so we never trigger a
 * useless permission prompt in a tab.
 */

import { api } from "@/lib/api";

const STORAGE_KEY = "trivu:push:subscription-id";

/** True when the runtime supports the full subscribe pipeline.
 * False in old browsers and in SSR. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && typeof Notification !== "undefined"
  );
}

/** True when we're running inside an installed PWA (home-screen
 * launch) rather than a browser tab. Required on iOS for push to
 * work at all; on desktop it's a useful UX cue ("you'll get
 * notifications even when the app is closed"). */
export function isInstalledPwa(): boolean {
  if (typeof window === "undefined") return false;
  // matchMedia is the modern check. iOS Safari also has the
  // legacy `navigator.standalone` boolean — we cover both for
  // older devices stuck on iOS 16.4–16.5 where matchMedia
  // sometimes returns the wrong value the first paint.
  if (window.matchMedia?.("(display-mode: standalone)").matches) {
    return true;
  }
  type IOSStandalone = { standalone?: boolean };
  return Boolean((navigator as unknown as IOSStandalone).standalone);
}

/** Current browser permission state. "default" = haven't asked
 * yet; "granted" = we can subscribe; "denied" = user said no, can
 * only re-enable via the OS / browser settings (we can't
 * re-prompt). */
export function getPermissionState(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

/** The id stored at subscribe time, if any. Used by the UI to
 * mark the "this device" row. */
export function getCurrentSubscriptionId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Convert the base64url VAPID public key to the Uint8Array
 * pushManager.subscribe() wants. The browser ships this
 * conversion nowhere — every web-push library re-implements it. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.ready;
  return reg;
}

/** Full subscribe pipeline: request permission, ask the browser
 * to subscribe, POST to backend. Returns the server-side id. */
export async function subscribeToPush(): Promise<number> {
  if (!isPushSupported()) {
    throw new Error("Este navegador no soporta notificaciones push.");
  }
  // Step 1: permission. Must come from a user gesture — the
  // caller component triggers this on a button click.
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(
      perm === "denied"
        ? "Has bloqueado las notificaciones. Actívalas en la configuración del navegador o del sistema y vuelve a intentarlo."
        : "No se concedió permiso para notificaciones.",
    );
  }
  // Step 2: VAPID public key. Backend may 503 if push isn't
  // configured — surface a clear message rather than a crash.
  const { public_key } = await api.getVapidPublicKey();
  if (!public_key) {
    throw new Error(
      "Las notificaciones aún no están configuradas en este entorno.",
    );
  }
  // Step 3: subscribe via the SW's PushManager. The
  // `userVisibleOnly: true` flag is required by Chrome and the
  // only mode iOS supports.
  const reg = await getRegistration();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(public_key),
  });
  // Extract the encryption keys + endpoint in the shape the
  // backend expects. `getKey` returns ArrayBuffer; convert to
  // base64url for transport.
  const endpoint = sub.endpoint;
  const p256dh = arrayBufferToBase64Url(sub.getKey("p256dh"));
  const auth = arrayBufferToBase64Url(sub.getKey("auth"));
  if (!p256dh || !auth) {
    throw new Error("La suscripción no devolvió las claves esperadas.");
  }
  // Step 4: post to backend. Server upserts on endpoint.
  const { id } = await api.createPushSubscription({
    endpoint,
    p256dh,
    auth,
    user_agent: navigator.userAgent || null,
  });
  window.localStorage.setItem(STORAGE_KEY, String(id));
  return id;
}

/**
 * Idempotent self-heal: make sure this device has a live, backend-
 * synced push subscription. Safe to call on every app load.
 *
 * Why this exists: iOS routinely invalidates PWA push subscriptions
 * (OS updates, storage eviction, long disuse). When that happens the
 * browser drops the PushSubscription, our backend row gets pruned on
 * the next 410 Gone, and — until now — nothing re-created either. The
 * user went silently dark and had to manually re-toggle in settings
 * (which most never discover). This closes that gap.
 *
 * It NEVER prompts. Re-subscribing only needs a user gesture when the
 * permission is still "default"; once it's "granted", the browser lets
 * us subscribe silently. So we bail unless permission is already
 * granted — making this a safe no-op in every other state.
 *
 * Two heal paths:
 *   1. Browser dropped the subscription (getSubscription() === null)
 *      but permission survived → re-subscribe from scratch.
 *   2. Browser still has a subscription but the backend row may have
 *      been pruned → re-POST it (the upsert is keyed on endpoint, so
 *      this is idempotent) and refresh the stored id.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!isPushSupported() || !isInstalledPwa()) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await getRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Path 1 — OS dropped it, permission survived. Recreate silently.
      const { public_key } = await api.getVapidPublicKey();
      if (!public_key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key),
      });
    }
    // Path 2 (and tail of path 1) — sync to backend. The upsert is on
    // endpoint, so re-POSTing a still-valid subscription just heals a
    // pruned row and refreshes last_used; it never duplicates.
    const p256dh = arrayBufferToBase64Url(sub.getKey("p256dh"));
    const auth = arrayBufferToBase64Url(sub.getKey("auth"));
    if (!p256dh || !auth) return;
    const { id } = await api.createPushSubscription({
      endpoint: sub.endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent || null,
    });
    window.localStorage.setItem(STORAGE_KEY, String(id));
  } catch (err) {
    // Best-effort — a push hiccup must never break app load.
    // eslint-disable-next-line no-console
    console.warn("[push] ensureSubscription failed", err);
  }
}

/** Tear down the current device's subscription: unsubscribe in
 * the browser AND delete on the backend. Caller usually invokes
 * this on the "Desactivar" button in the panel. */
export async function unsubscribeFromPush(): Promise<void> {
  const id = getCurrentSubscriptionId();
  // Always best-effort browser unsubscribe even if we lost the
  // id (stale localStorage) so dead state in the browser doesn't
  // linger.
  if (isPushSupported()) {
    try {
      const reg = await getRegistration();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }
    } catch (err) {
      // Browser-side cleanup isn't critical; the server-side row
      // gets pruned next time it 410s anyway.
      // eslint-disable-next-line no-console
      console.warn("[push] browser unsubscribe failed", err);
    }
  }
  if (id !== null) {
    try {
      await api.deletePushSubscription(id);
    } catch (err) {
      // 404/204 are both fine; only log unexpected failures.
      // eslint-disable-next-line no-console
      console.warn("[push] backend delete failed", err);
    }
  }
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

/** Delete an arbitrary subscription (e.g. the user revoking an
 * old device from the panel). Also clears the local
 * subscription id if it matched — that browser is now signed
 * out from push and should be invited to re-subscribe. */
export async function revokeSubscription(id: number): Promise<void> {
  await api.deletePushSubscription(id);
  const current = getCurrentSubscriptionId();
  if (current === id && typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
    // Also tear down the browser-side subscription so the SW
    // doesn't think it's still subscribed.
    if (isPushSupported()) {
      try {
        const reg = await getRegistration();
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch {
        /* noop */
      }
    }
  }
}

function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // base64 → base64url (URL-safe).
  return window
    .btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

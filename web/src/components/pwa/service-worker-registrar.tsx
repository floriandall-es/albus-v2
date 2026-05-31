"use client";
import { useEffect } from "react";

import { getToken } from "@/lib/api";
import { ensurePushSubscription } from "@/lib/push";

/**
 * Registers /sw.js on mount. Tiny client component mounted once
 * from the root layout. Kept separate so the layout itself can
 * stay a server component.
 *
 * The SW is the minimal passthrough one in /public/sw.js — its
 * only job is to satisfy browser PWA-install criteria. We don't
 * precache app shell or cache API responses yet; promote to
 * next-pwa or workbox when we have a real offline story.
 *
 * Second job: once the SW is ready, self-heal the push subscription
 * for logged-in users. iOS silently drops PWA push subscriptions
 * (OS updates, storage eviction); without a re-sync on load the user
 * goes permanently dark. `ensurePushSubscription` is a no-op unless
 * we're an installed PWA with permission already granted, so this is
 * safe to fire on every load.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Defer to load so we don't compete with critical rendering.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => {
          // Only attempt the backend re-sync for authenticated
          // sessions — the heal hits auth-gated /api/push endpoints.
          if (getToken()) {
            void ensurePushSubscription();
          }
        })
        .catch((err) => {
          // Best-effort: a failed registration shouldn't break
          // the app — it just means PWA install criteria aren't
          // satisfied this session.
          // eslint-disable-next-line no-console
          console.warn("SW registration failed", err);
        });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);
  return null;
}

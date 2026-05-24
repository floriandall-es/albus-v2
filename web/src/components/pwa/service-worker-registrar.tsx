"use client";
import { useEffect } from "react";

/**
 * Registers /sw.js on mount. Tiny client component mounted once
 * from the root layout. Kept separate so the layout itself can
 * stay a server component.
 *
 * The SW is the minimal passthrough one in /public/sw.js — its
 * only job is to satisfy browser PWA-install criteria. We don't
 * precache app shell or cache API responses yet; promote to
 * next-pwa or workbox when we have a real offline story.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Defer to load so we don't compete with critical rendering.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
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

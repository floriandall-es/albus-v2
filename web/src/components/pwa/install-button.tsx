"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

/**
 * "Instalar Trivu" install affordance for the sidebars.
 *
 * Three states depending on platform support:
 *
 *   1. Browser fired `beforeinstallprompt` (Chrome / Edge /
 *      Android Chrome) — show the green "Instalar Trivu"
 *      button. Tapping it calls prompt() so the user sees the
 *      native install sheet immediately.
 *
 *   2. iOS Safari, not standalone — show a small instructional
 *      banner. iOS has never supported the prompt API, so the
 *      best we can do is point at the Share menu.
 *
 *   3. Anything else (Firefox, already installed, prompt fired
 *      and was dismissed, etc.) — render nothing.
 *
 * Dismissal is sticky per-device via localStorage so we don't
 * pester users who have actively declined.
 */
const DISMISSED_KEY = "trivu.pwa.installDismissed";

// Minimal typing for the non-standard prompt event. TS/DOM lib
// doesn't include it yet.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [isIosSafari, setIsIosSafari] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Detect platform + standalone-ness + persisted dismissal on
  // mount. All client-side; no SSR concerns because the parent
  // component already runs client-side (it's mounted from the
  // /admin / /me layouts).
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(DISMISSED_KEY) === "1");
    // iOS Safari sniff. `MSStream` excludes old IE-on-Windows-
    // Phone that also matched the iPhone substring.
    const ua = window.navigator.userAgent;
    const iOS = /iPad|iPhone|iPod/.test(ua)
      && !(window as unknown as { MSStream?: unknown }).MSStream;
    // Safari (not Chrome / Edge / Firefox-on-iOS, which all use
    // WebKit but report different UAs).
    const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    setIsIosSafari(iOS && safari);
    // Standalone detection: iOS uses navigator.standalone (a
    // non-standard Safari property — TS doesn't know about it);
    // everyone else uses the display-mode media query.
    const standalone =
      (window.navigator as Navigator & { standalone?: boolean })
        .standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
    setIsStandalone(standalone);
  }, []);

  // Capture the install prompt for later. Browsers fire this
  // when criteria are met (manifest + SW + HTTPS + engagement).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      // Block the default mini-info-bar — we want to drive the
      // prompt from our own button.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    // Listen for the appinstalled event so we can hide the
    // button once the app is added.
    const onInstalled = () => {
      setDeferred(null);
      setIsStandalone(true);
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    }
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    // Either way the event becomes single-use after prompt(),
    // so clear it. If they accepted, appinstalled will fire too.
    setDeferred(null);
    if (choice.outcome === "dismissed") {
      // User actively said no — respect that for the rest of
      // this device session.
      dismiss();
    }
  }, [deferred, dismiss]);

  // Bail conditions.
  if (isStandalone) return null;
  if (dismissed) return null;

  // Path 1 — installable platform with native prompt.
  if (deferred) {
    return (
      <div className="px-3 pt-3">
        <div className="relative rounded-md border border-brand-200 bg-brand-50 p-2.5 pr-7 text-xs text-brand-900">
          <button
            type="button"
            aria-label="No mostrar más"
            onClick={dismiss}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-brand-700/60 hover:bg-brand-100 hover:text-brand-800"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="mb-2 leading-snug">
            Instala Trivu como app para abrirla con un toque desde
            tu pantalla de inicio.
          </p>
          <button
            type="button"
            onClick={install}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-brand-700"
          >
            <Download className="h-3.5 w-3.5" />
            Instalar Trivu
          </button>
        </div>
      </div>
    );
  }

  // Path 2 — iOS Safari, no native prompt API. Show the manual
  // Share→Add-to-home-screen instructions.
  if (isIosSafari) {
    return (
      <div className="px-3 pt-3">
        <div className="relative rounded-md border border-brand-200 bg-brand-50 p-2.5 pr-7 text-xs text-brand-900">
          <button
            type="button"
            aria-label="No mostrar más"
            onClick={dismiss}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-brand-700/60 hover:bg-brand-100 hover:text-brand-800"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-start gap-1.5 leading-snug">
            <Share className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-700" />
            <p>
              Para instalar Trivu: pulsa{" "}
              <strong>Compartir</strong> y luego{" "}
              <strong>Añadir a pantalla de inicio</strong>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Path 3 — unsupported / unknown — silent.
  return null;
}

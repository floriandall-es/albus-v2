import type { MetadataRoute } from "next";
import { cookies } from "next/headers";
import { ACCENT_COOKIE, accentHex, resolveAccent } from "@/lib/accent";

/**
 * PWA manifest. Next.js 14 App Router picks up `app/manifest.ts`
 * automatically and serves it at /manifest.webmanifest with the
 * right content type — no extra wiring needed.
 *
 * Migration 0065: the `theme_color` follows the user's accent
 * preference (read from the trivu_accent cookie). The browser
 * caches the manifest aggressively, so installed PWAs only pick
 * up a new colour when the user re-installs or the browser
 * invalidates its cache; that's fine — for normal browser tabs
 * the per-request <meta name="theme-color"> in layout.tsx
 * already covers the chrome tint.
 *
 * Notes:
 *
 *   - `start_url` is "/login" so the installed app skips the
 *     marketing landing page on launch. /login auto-routes
 *     already-logged-in users to their app home (admin / me /
 *     onboarding), so for an authenticated user the launch is
 *     a silent flash; for a logged-out user they see the form.
 *     Before we shipped the marketing page at "/" the start_url
 *     was "/" and that fed straight into login — now it would
 *     dump every PWA launch onto the landing page. The
 *     redirect inside app/page.tsx covers existing installs
 *     whose browser still has the old manifest cached.
 *
 *   - `scope` is "/" (not the default of start_url's parent)
 *     so navigation from /login into /me, /admin, etc. stays
 *     inside the PWA window. Without this, some user agents
 *     pop out to a regular browser tab on cross-scope nav.
 *
 *   - `display: "standalone"` opens in its own window without
 *     browser chrome on supported platforms. iOS respects this
 *     when launched from the home-screen icon; Chrome opens a
 *     "pseudo-app" window on desktop / Android.
 *
 *   - Icons: 192 + 512 px PNGs derived from the existing 1254px
 *     logo via sips. The 512 is also tagged as `maskable` — our
 *     logo already sits on a contained background so adaptive
 *     Android icons crop it reasonably. If Android renders it
 *     awkwardly later, generate a dedicated maskable with
 *     ~80% safe-zone content and add a third icon entry.
 */
export default function manifest(): MetadataRoute.Manifest {
  const cookieValue = cookies().get(ACCENT_COOKIE)?.value ?? null;
  const accent = resolveAccent(cookieValue);
  return {
    name: "Trivu",
    short_name: "Trivu",
    description:
      "Planificación de turnos y comunicación para servicios hospitalarios.",
    start_url: "/login",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: accentHex(accent, 700),
    lang: "es",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

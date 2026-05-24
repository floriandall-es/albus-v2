import type { MetadataRoute } from "next";

/**
 * PWA manifest. Next.js 14 App Router picks up `app/manifest.ts`
 * automatically and serves it at /manifest.webmanifest with the
 * right content type — no extra wiring needed.
 *
 * Notes:
 *
 *   - `start_url` is "/" so the installed app boots straight into
 *     login (or whatever the auth redirect resolves to). The
 *     home redirect inside the app handles routing once a token
 *     is present.
 *
 *   - `display: "standalone"` opens in its own window without
 *     browser chrome on supported platforms. iOS respects this
 *     when launched from the home-screen icon; Chrome opens a
 *     "pseudo-app" window on desktop / Android.
 *
 *   - `theme_color` is brand-600 (`#0d9488`) — matches the
 *     primary button background. Drives the OS-level status
 *     bar tint on installed apps and the browser chrome on
 *     desktop.
 *
 *   - Icons: 192 + 512 px PNGs derived from the existing 1254px
 *     logo via sips. The 512 is also tagged as `maskable` — our
 *     logo already sits on a contained background so adaptive
 *     Android icons crop it reasonably. If Android renders it
 *     awkwardly later, generate a dedicated maskable with
 *     ~80% safe-zone content and add a third icon entry.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Trivu",
    short_name: "Trivu",
    description:
      "Planificación de turnos y comunicación para servicios hospitalarios.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0d9488",
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

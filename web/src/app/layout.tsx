import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Inter } from "next/font/google";
import { AccentSync } from "@/components/accent-sync";
import { QueryProvider } from "@/components/QueryProvider";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar";
import {
  ACCENT_COOKIE,
  accentHex,
  accentInlineStyle,
  resolveAccent,
} from "@/lib/accent";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  // Absolute base for OG / canonical URLs. Without it the
  // auto-generated opengraph-image resolves to a relative path and
  // some scrapers (WhatsApp, Slack) drop it.
  metadataBase: new URL("https://trivu.net"),
  title: {
    default: "Trivu — turnos para servicios hospitalarios",
    template: "%s · Trivu",
  },
  description:
    "Trivu construye la planificación de tu servicio respetando guardias, rotaciones y vacaciones, y la reparte de forma justa. El jefe valida; el equipo lo ve en su móvil.",
  // The whole member→jefe growth loop is "send your boss this link",
  // so the unfurl card matters. opengraph-image.tsx supplies the
  // image automatically; here we set the title/description/locale.
  openGraph: {
    type: "website",
    siteName: "Trivu",
    url: "https://trivu.net",
    locale: "es_ES",
    title: "Trivu — la planificación del mes, hecha.",
    description:
      "Turnos, guardias, vacaciones y cambios para servicios hospitalarios. Quien planifica valida; el equipo lo ve en su móvil. 30 días gratis.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Trivu — la planificación del mes, hecha.",
    description:
      "Turnos, guardias, vacaciones y cambios para servicios hospitalarios. 30 días gratis.",
  },
  // App-router auto-discovers app/manifest.ts and serves it at
  // /manifest.webmanifest, but we still declare it here so the
  // <link rel="manifest"> tag lands in <head>.
  manifest: "/manifest.webmanifest",
  icons: {
    // The 192/512 PNGs in /public/icons/ are derived from
    // /public/icons/icon_trivu.png (the 585px master) via PIL.
    // apple-touch-icon is a 180×180 PNG — Safari's preferred
    // size for the home-screen icon.
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // iOS PWA flags. apple-mobile-web-app-capable means "launch
  // from home screen icon without Safari chrome". The status-
  // bar style "default" keeps the OS chrome black on white;
  // "black-translucent" is for full-bleed apps which we don't
  // need.
  appleWebApp: {
    capable: true,
    title: "Trivu",
    statusBarStyle: "default",
  },
};

/** Per-request browser-chrome tint. Reads the same cookie the
 * layout uses to set CSS vars; that way the iOS / Chrome top bar
 * matches the user's accent in normal browser sessions. The PWA
 * splash screen still uses the static manifest theme_color (the
 * OS reads the manifest at install time, so it can't follow a
 * cookie set later anyway). */
export function generateViewport(): Viewport {
  const cookieValue = cookies().get(ACCENT_COOKIE)?.value ?? null;
  const accent = resolveAccent(cookieValue);
  return { themeColor: accentHex(accent, 700) };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  // Per-user accent (migration 0065). Read the cookie set on
  // login + every settings save, resolve to a known preset
  // (fallback teal), and inject the CSS-variable triplets inline
  // on <html>. Doing this server-side means the right colours
  // are present on the very first paint — no flash even on a
  // hard refresh. The /me/settings picker also writes the
  // variables on `documentElement.style` immediately so the
  // change is visible without a navigation.
  const cookieValue = cookies().get(ACCENT_COOKIE)?.value ?? null;
  const accent = resolveAccent(cookieValue);

  return (
    <html
      lang="es"
      className={inter.variable}
      style={accentInlineStyle(accent) as React.CSSProperties}
    >
      <body className="font-sans antialiased text-gray-900">
        <QueryProvider>
          <ServiceWorkerRegistrar />
          <AccentSync />
          <div className="min-h-screen bg-gray-50">{children}</div>
        </QueryProvider>
      </body>
    </html>
  );
}

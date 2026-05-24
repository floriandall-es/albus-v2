import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { QueryProvider } from "@/components/QueryProvider";
import { ServiceWorkerRegistrar } from "@/components/pwa/service-worker-registrar";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: { default: "Trivu", template: "%s · Trivu" },
  description: "Planificación de turnos para servicios hospitalarios",
  // App-router auto-discovers app/manifest.ts and serves it at
  // /manifest.webmanifest, but we still declare it here so the
  // <link rel="manifest"> tag lands in <head>.
  manifest: "/manifest.webmanifest",
  icons: {
    // The 192/512 PNGs in /public/icons/ are derived from the
    // 1254px logo via sips. apple-touch-icon is a 180×180 PNG
    // — Safari's preferred size for the home-screen icon.
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

export const viewport: Viewport = {
  // Drives the browser chrome / iOS status-bar tint on installed
  // apps. Brand-600 (`#0d9488`) matches the manifest theme_color.
  themeColor: "#0d9488",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="font-sans antialiased text-gray-900">
        <QueryProvider>
          <ServiceWorkerRegistrar />
          <div className="min-h-screen bg-gray-50">{children}</div>
        </QueryProvider>
      </body>
    </html>
  );
}

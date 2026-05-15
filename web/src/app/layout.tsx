import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { QueryProvider } from "@/components/QueryProvider";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: { default: "Trivu", template: "%s · Trivu" },
  description: "Planificación de turnos para servicios hospitalarios",
  icons: {
    // The PNG is the same logo used on login/signup. Browsers downscale it
    // for the tab icon. We can swap this for a tighter icon-only crop later.
    icon: [{ url: "/logo.jpeg", type: "image/jpeg" }],
    apple: [{ url: "/logo.jpeg" }],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="font-sans antialiased text-gray-900">
        <QueryProvider>
          <div className="min-h-screen bg-gray-50">{children}</div>
        </QueryProvider>
      </body>
    </html>
  );
}

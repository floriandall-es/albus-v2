import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { QueryProvider } from "@/components/QueryProvider";

export const metadata: Metadata = {
  title: "albus",
  description: "Surgical scheduling for hospitals",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <div className="min-h-screen">{children}</div>
        </QueryProvider>
      </body>
    </html>
  );
}

import { ImageResponse } from "next/og";

/**
 * Auto-generated Open Graph / Twitter share card for trivu.net.
 *
 * Next.js picks this file up by convention and wires the og:image +
 * twitter:image tags for us. It's generated rather than a static PNG
 * so it stays on-brand without an asset pipeline and is trivial to
 * re-word. Node runtime (not edge) — the prod deploy is a self-hosted
 * Next standalone container where edge isn't available.
 *
 * The whole member→jefe flow is "paste this link to your chief", so
 * this card is the first impression most chiefs get of Trivu.
 */

export const alt =
  "Trivu — planificación de turnos para servicios hospitalarios";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "84px",
          // Brand teal gradient (brand-700 → brand-800).
          background: "linear-gradient(135deg, #0f766e 0%, #134e4a 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 132,
            fontWeight: 800,
            letterSpacing: "-0.05em",
            lineHeight: 1,
          }}
        >
          Trivu
        </div>
        <div
          style={{
            fontSize: 60,
            fontWeight: 600,
            marginTop: 28,
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
          }}
        >
          La planificación del mes, hecha.
        </div>
        <div
          style={{
            fontSize: 32,
            marginTop: 30,
            opacity: 0.85,
            maxWidth: 920,
            lineHeight: 1.3,
          }}
        >
          Turnos, guardias, vacaciones y cambios para servicios
          hospitalarios.
        </div>
      </div>
    ),
    { ...size },
  );
}

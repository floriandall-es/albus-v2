import { readFileSync } from "fs";
import { join } from "path";
import { ImageResponse } from "next/og";

/**
 * Open Graph / Twitter share card for trivu.net.
 *
 * Uses the real Trivu wordmark (public/logo.png, a transparent-bg
 * teal lockup) on a clean white card so the unfurl matches the
 * brand identity — not a generic coloured block. The tagline stays
 * because the whole member→jefe flow is "paste this link to your
 * chief", and that card is most chiefs' first impression of Trivu.
 *
 * Node runtime (default) — the prod deploy is a self-hosted Next
 * standalone container where edge isn't available. We read the logo
 * off disk and inline it as a data URL; if that ever fails we fall
 * back to a wordmark-as-text card so the route never 500s.
 */

export const alt =
  "Trivu — planificación de turnos para servicios hospitalarios";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BRAND = "#0f766e"; // brand-700 teal

function loadLogoDataUrl(): string | null {
  try {
    const bytes = readFileSync(join(process.cwd(), "public", "logo.png"));
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export default function OpengraphImage() {
  const logo = loadLogoDataUrl();
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#ffffff",
          fontFamily: "sans-serif",
          // Brand bar down the left edge for a touch of identity.
          borderLeft: `24px solid ${BRAND}`,
          padding: "84px 88px",
        }}
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="Trivu" height={132} width={329} />
        ) : (
          <div
            style={{
              fontSize: 120,
              fontWeight: 800,
              letterSpacing: "-0.05em",
              color: BRAND,
            }}
          >
            Trivu
          </div>
        )}
        <div
          style={{
            fontSize: 58,
            fontWeight: 600,
            marginTop: 44,
            lineHeight: 1.08,
            letterSpacing: "-0.02em",
            color: "#111827",
          }}
        >
          La planificación del mes, hecha.
        </div>
        <div
          style={{
            fontSize: 30,
            marginTop: 26,
            maxWidth: 880,
            lineHeight: 1.3,
            color: "#6b7280",
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

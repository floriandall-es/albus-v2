"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  ACCENT_PRESETS,
  type AccentName,
  type AccentScale,
  accentHex,
  resolveAccent,
} from "@/lib/accent";

/** The caller's current accent key, resolved from /me with a teal
 * fallback while the query is loading or on logged-out pages. */
export function useAccent(): AccentName {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  return resolveAccent(me.data?.person.preferred_accent);
}

/** Hex form of the current accent at the given Tailwind shade.
 * Used for chart libraries (Recharts) which take colour strings as
 * props and don't understand CSS variables — we have to resolve to
 * hex client-side. Stable across renders because the underlying
 * /me query is cached. */
export function useAccentHex(shade: keyof AccentScale): string {
  const accent = useAccent();
  return accentHex(accent, shade);
}

/** Replace any occurrence of the legacy default-brand hex in a
 * static palette with the user's current accent. Lets us keep the
 * existing multi-colour SURGEON_PALETTE arrays as-is and just swap
 * the brand slot at render time. */
export function useAccentPalette(palette: string[]): string[] {
  const accentTeal = ACCENT_PRESETS.teal.scale[600];
  const defaultHex = "#" + accentTeal
    .split(" ")
    .map((s) => Number(s).toString(16).padStart(2, "0"))
    .join("");
  const userHex = useAccentHex(600);
  if (userHex === defaultHex) return palette;
  return palette.map((c) =>
    c.toLowerCase() === defaultHex.toLowerCase() ? userHex : c,
  );
}

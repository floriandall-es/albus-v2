/**
 * Per-user accent colour presets (migration 0065).
 *
 * Every `bg-brand-*`, `text-brand-*`, `border-brand-*` etc. utility
 * in the codebase resolves against CSS variables on `<html>`:
 *
 *   --brand-50:  240 253 250;   (R G B triplet, no commas)
 *   --brand-100: 204 251 241;
 *   …
 *   --brand-700: 15 118 110;
 *
 * Tailwind's `<alpha-value>` syntax keeps `bg-brand-700/50` working
 * unchanged. To repaint the app for a different accent we just swap
 * the variable values — no per-component edits.
 *
 * Each preset ships an 11-shade scale (50…900) so existing utilities
 * like `text-brand-800` keep working if anyone ever uses them, but
 * the picker only validates 50/100/200/300/500/600/700 since those
 * are the shades the codebase actually uses today.
 *
 * Naming: Spanish display labels (the user is Spanish), English-ish
 * preset keys for stability across translations. The keys also live
 * in api/alembic/versions/0065_*.py and api/app/schemas/auth.py —
 * keep all three in lockstep.
 *
 * Palettes come from Tailwind's own colour scales (which are designed
 * to be readable on white). Hand-tuned a couple where Tailwind's
 * default brand mid-shade clashed (e.g. naranja: brand-700 = orange-700
 * is brown-ish on white; bumped to orange-600).
 */

export type AccentName =
  | "teal"
  | "azul"
  | "indigo"
  | "violeta"
  | "rosa"
  | "ambar"
  | "esmeralda"
  | "pizarra"
  | "cyan"
  | "naranja"
  | "lima"
  | "fucsia";

export const DEFAULT_ACCENT: AccentName = "teal";

export type AccentScale = {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
};

export type AccentPreset = {
  key: AccentName;
  /** Spanish label for the swatch + Mi cuenta picker. */
  label: string;
  /** RGB triplets (space-separated, no parens) at every Tailwind shade
   * the codebase consumes. Stored as strings so we can drop them
   * straight into a CSS variable: `--brand-700: ${scale[700]}`. */
  scale: AccentScale;
};

// Tailwind v3 palette values, sourced from
// https://tailwindcss.com/docs/customizing-colors.
// (Listed in R G B form to match the `rgb(var(--x))` syntax.)
export const ACCENT_PRESETS: Record<AccentName, AccentPreset> = {
  teal: {
    key: "teal",
    label: "Teal (Trivu)",
    scale: {
      50: "240 253 250",
      100: "204 251 241",
      200: "153 246 228",
      300: "94 234 212",
      400: "45 212 191",
      500: "20 184 166",
      600: "13 148 136",
      700: "15 118 110",
      800: "17 94 89",
      900: "19 78 74",
    },
  },
  azul: {
    key: "azul",
    label: "Azul",
    scale: {
      50: "239 246 255",
      100: "219 234 254",
      200: "191 219 254",
      300: "147 197 253",
      400: "96 165 250",
      500: "59 130 246",
      600: "37 99 235",
      700: "29 78 216",
      800: "30 64 175",
      900: "30 58 138",
    },
  },
  indigo: {
    key: "indigo",
    label: "Índigo",
    scale: {
      50: "238 242 255",
      100: "224 231 255",
      200: "199 210 254",
      300: "165 180 252",
      400: "129 140 248",
      500: "99 102 241",
      600: "79 70 229",
      700: "67 56 202",
      800: "55 48 163",
      900: "49 46 129",
    },
  },
  violeta: {
    key: "violeta",
    label: "Violeta",
    scale: {
      50: "245 243 255",
      100: "237 233 254",
      200: "221 214 254",
      300: "196 181 253",
      400: "167 139 250",
      500: "139 92 246",
      600: "124 58 237",
      700: "109 40 217",
      800: "91 33 182",
      900: "76 29 149",
    },
  },
  rosa: {
    key: "rosa",
    label: "Rosa",
    scale: {
      50: "253 242 248",
      100: "252 231 243",
      200: "251 207 232",
      300: "249 168 212",
      400: "244 114 182",
      500: "236 72 153",
      600: "219 39 119",
      700: "190 24 93",
      800: "157 23 77",
      900: "131 24 67",
    },
  },
  ambar: {
    key: "ambar",
    label: "Ámbar",
    scale: {
      50: "255 251 235",
      100: "254 243 199",
      200: "253 230 138",
      300: "252 211 77",
      400: "251 191 36",
      500: "245 158 11",
      600: "217 119 6",
      700: "180 83 9",
      800: "146 64 14",
      900: "120 53 15",
    },
  },
  esmeralda: {
    key: "esmeralda",
    label: "Esmeralda",
    scale: {
      50: "236 253 245",
      100: "209 250 229",
      200: "167 243 208",
      300: "110 231 183",
      400: "52 211 153",
      500: "16 185 129",
      600: "5 150 105",
      700: "4 120 87",
      800: "6 95 70",
      900: "6 78 59",
    },
  },
  pizarra: {
    key: "pizarra",
    label: "Pizarra",
    scale: {
      50: "248 250 252",
      100: "241 245 249",
      200: "226 232 240",
      300: "203 213 225",
      400: "148 163 184",
      500: "100 116 139",
      600: "71 85 105",
      700: "51 65 85",
      800: "30 41 59",
      900: "15 23 42",
    },
  },
  cyan: {
    key: "cyan",
    label: "Cian",
    scale: {
      50: "236 254 255",
      100: "207 250 254",
      200: "165 243 252",
      300: "103 232 249",
      400: "34 211 238",
      500: "6 182 212",
      600: "8 145 178",
      700: "14 116 144",
      800: "21 94 117",
      900: "22 78 99",
    },
  },
  naranja: {
    key: "naranja",
    label: "Naranja",
    scale: {
      50: "255 247 237",
      100: "255 237 213",
      200: "254 215 170",
      300: "253 186 116",
      400: "251 146 60",
      500: "249 115 22",
      600: "234 88 12",
      700: "194 65 12",
      800: "154 52 18",
      900: "124 45 18",
    },
  },
  lima: {
    key: "lima",
    label: "Lima",
    scale: {
      50: "247 254 231",
      100: "236 252 203",
      200: "217 249 157",
      300: "190 242 100",
      400: "163 230 53",
      500: "132 204 22",
      600: "101 163 13",
      700: "77 124 15",
      800: "63 98 18",
      900: "54 83 20",
    },
  },
  fucsia: {
    key: "fucsia",
    label: "Fucsia",
    scale: {
      50: "253 244 255",
      100: "250 232 255",
      200: "245 208 254",
      300: "240 171 252",
      400: "232 121 249",
      500: "217 70 239",
      600: "192 38 211",
      700: "162 28 175",
      800: "134 25 143",
      900: "112 26 117",
    },
  },
};

/** Resolve an unknown / NULL / typo'd value to a valid preset.
 * Used at every entry point (cookie read, /me deserialise, picker
 * selection) so we never propagate junk into the CSS-var injection. */
export function resolveAccent(value: string | null | undefined): AccentName {
  if (!value) return DEFAULT_ACCENT;
  return value in ACCENT_PRESETS ? (value as AccentName) : DEFAULT_ACCENT;
}

/** Build the inline-style object for `<html>`. React lets us pass
 * CSS custom-property names as object keys and renders them as
 * real inline styles, so setting them on the root element wins
 * over the `:root` defaults in globals.css. Server-rendering this
 * means the right colours land on first paint — no flash on a
 * hard refresh. */
export function accentInlineStyle(
  name: AccentName,
): Record<string, string> {
  const preset = ACCENT_PRESETS[name];
  return {
    "--brand-50": preset.scale[50],
    "--brand-100": preset.scale[100],
    "--brand-200": preset.scale[200],
    "--brand-300": preset.scale[300],
    "--brand-400": preset.scale[400],
    "--brand-500": preset.scale[500],
    "--brand-600": preset.scale[600],
    "--brand-700": preset.scale[700],
    "--brand-800": preset.scale[800],
    "--brand-900": preset.scale[900],
  };
}

/** Same shape but as a list of [prop, value] tuples — used by the
 * client-side picker to write directly onto `documentElement.style`
 * so the change is visible without waiting for the next navigation. */
export function accentCssEntries(name: AccentName): [string, string][] {
  return Object.entries(accentInlineStyle(name));
}

/** Hex form of a given shade. Used for the PWA `theme-color` meta
 * tag (which doesn't understand CSS variables) and for Recharts,
 * which takes string colours as props. */
export function accentHex(name: AccentName, shade: keyof AccentScale): string {
  const preset = ACCENT_PRESETS[name];
  const [r, g, b] = preset.scale[shade].split(" ").map((s) => Number(s));
  return (
    "#"
    + r.toString(16).padStart(2, "0")
    + g.toString(16).padStart(2, "0")
    + b.toString(16).padStart(2, "0")
  );
}

/** Cookie name carrying the accent for SSR. Mirrored from
 * `Person.preferred_accent` on every change so the next page load
 * paints correctly without an extra /me round-trip. */
export const ACCENT_COOKIE = "trivu_accent";

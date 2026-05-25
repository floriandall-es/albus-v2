"use client";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  ACCENT_COOKIE,
  accentCssEntries,
  resolveAccent,
} from "@/lib/accent";

/**
 * Keep the `trivu_accent` cookie + the live CSS variables in sync
 * with `Person.preferred_accent` from /me. Lives once in the root
 * layout, runs only on the client.
 *
 * Why this is needed: auth is Bearer-token based, so the SSR layout
 * can't read /me directly — it only knows the cookie. A user who
 * signs in on a new device, or whose accent was changed elsewhere,
 * has a stale cookie until something writes the canonical value.
 * This component does that write whenever /me's accent disagrees
 * with the cookie, then sets the CSS variables on documentElement
 * so the change applies without a navigation.
 *
 * If the /me query fails (e.g. logged-out pages like /login) we
 * silently no-op — those routes use the default teal anyway.
 */
export function AccentSync() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!me.data) return;
    const canonical = resolveAccent(me.data.person.preferred_accent);

    // Read the current cookie.
    const cookieMatch = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${ACCENT_COOKIE}=([^;]+)`),
    );
    const cookieValue = cookieMatch ? cookieMatch[1] : null;
    if (cookieValue === canonical) return;

    // Mirror canonical into cookie (1 year, lax) so the next SSR
    // render paints correctly without a /me round-trip.
    document.cookie =
      `${ACCENT_COOKIE}=${canonical}; Path=/; Max-Age=31536000; SameSite=Lax`;

    // Apply locally NOW so the user doesn't see a flash on next nav.
    for (const [prop, value] of accentCssEntries(canonical)) {
      document.documentElement.style.setProperty(prop, value);
    }
  }, [me.data]);

  return null;
}

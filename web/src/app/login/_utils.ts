// Shared utilities for the login flow. Lives outside the page files
// because Next.js page files in /app may only export the default page
// component (plus a small set of metadata-like names) — any other named
// export breaks the type-check at build time.

import type { QueryClient } from "@tanstack/react-query";
import { setToken, type AuthResponse } from "@/lib/api";

// Stash key for the in-flight tenant picker. Lives only between login →
// picker nav, so sessionStorage (cleared on tab close) is the right scope.
export const PRE_AUTH_KEY = "trivu.preAuth";

// Only honour a `?next=` that points back into our own app. Must be a
// root-relative path ("/...") and NOT protocol-relative ("//evil.com")
// — otherwise it's an open-redirect vector. Returns the path if safe,
// else null.
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  // Don't bounce back to an auth page — would loop or strand the user.
  if (next.startsWith("/login")) return null;
  return next;
}

// Shared post-login redirect. Used both on the single-membership path
// (login page) and after the tenant picker exchanges a pre_auth_token
// for an access token (select-tenant page).
//
// Pass the QueryClient so we can wipe any cached queries from a previous
// session before navigating. Without that, logging in as a different
// user on the same tab briefly renders the previous user's data.
//
// `next` (optional) is a `?next=` destination to land on after login —
// used so a tapped push / deep link that 401'd survives the re-login
// round-trip instead of dumping the user on home. Validated here.
export function finalizeLogin(
  res: AuthResponse,
  router: { push: (path: string) => void },
  qc?: QueryClient,
  next?: string | null,
) {
  setToken(res.access_token);
  qc?.clear();
  const isAdmin = res.memberships.some((m) => m.roles.includes("admin"));
  const onboarded = res.tenant.onboarding_completed_at != null;
  const dest = safeNext(next);
  // A deep-link destination wins over the role default — but never for
  // an admin who still has to finish onboarding (that flow must run
  // first).
  if (isAdmin && !onboarded) {
    router.push("/onboarding");
  } else if (dest) {
    router.push(dest);
  } else if (isAdmin) {
    router.push("/admin");
  } else {
    router.push("/me");
  }
}

// Shared utilities for the login flow. Lives outside the page files
// because Next.js page files in /app may only export the default page
// component (plus a small set of metadata-like names) — any other named
// export breaks the type-check at build time.

import { setToken, type AuthResponse } from "@/lib/api";

// Stash key for the in-flight tenant picker. Lives only between login →
// picker nav, so sessionStorage (cleared on tab close) is the right scope.
export const PRE_AUTH_KEY = "trivu.preAuth";

// Shared post-login redirect. Used both on the single-membership path
// (login page) and after the tenant picker exchanges a pre_auth_token
// for an access token (select-tenant page).
export function finalizeLogin(
  res: AuthResponse,
  router: { push: (path: string) => void },
) {
  setToken(res.access_token);
  const isAdmin = res.memberships.some((m) => m.roles.includes("admin"));
  const onboarded = res.tenant.onboarding_completed_at != null;
  if (isAdmin && !onboarded) {
    router.push("/onboarding");
  } else if (isAdmin) {
    router.push("/admin");
  } else {
    router.push("/me");
  }
}

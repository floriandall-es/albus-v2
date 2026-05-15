"use client";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { clearToken } from "@/lib/api";

/**
 * Single source of truth for "log out".
 *
 * Bug we hit before: clearToken() only nuked the JWT in localStorage,
 * but the React Query cache survived. Logging back in as a different
 * user briefly showed the previous user's data (the cached `me` /
 * `schedules` / etc. queries) until each one refetched. With many
 * routes reading from cache immediately on mount, this was visible
 * for long enough to be confusing.
 *
 * This hook nukes:
 * - localStorage JWT
 * - sessionStorage (pre-auth tokens, tenant picker stash)
 * - the entire React Query cache
 *
 * Then it sends the user to /login.
 */
export function useLogout(): () => void {
  const router = useRouter();
  const qc = useQueryClient();
  return () => {
    clearToken();
    qc.clear();
    router.replace("/login");
  };
}

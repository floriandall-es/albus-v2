/** Read tenant slug from the current subdomain, e.g. acme.example.com -> "acme".
 *  Falls back to null on localhost root or single-label hosts. */
export function readTenantSlugFromHost(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  const parts = host.split(".");
  if (parts.length < 2) return null;
  // Treat plain "localhost" with no sub as no slug.
  if (parts[parts.length - 1] === "localhost" && parts.length === 1) return null;
  // Skip common non-tenant prefixes.
  const candidate = parts[0];
  if (candidate === "www" || candidate === "app") return null;
  return candidate;
}

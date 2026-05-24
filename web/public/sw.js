/* Trivu PWA service worker — minimal.
 *
 * Purpose: satisfy browser "installable" criteria so Chrome /
 * Edge / Android show the install prompt and our InstallButton
 * can capture the `beforeinstallprompt` event.
 *
 * We deliberately do NOT precache assets here. Next.js ships
 * content-hashed bundles and our API responses are time-
 * sensitive (live schedules, DMs, directory). A stale-while-
 * revalidate cache here would create more bugs than it solves.
 * Promote to next-pwa or workbox when we have a clear offline
 * story to ship (e.g. "/me/turnos always works without network").
 *
 * skipWaiting + clients.claim so a freshly-deployed SW takes
 * effect on the very next page load instead of waiting until
 * every tab closes — important when we ship fixes.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. Just having a fetch listener (even
// one that does nothing) makes Chrome consider this a "valid" SW
// for PWA install criteria. Without it some browsers refuse the
// beforeinstallprompt event.
self.addEventListener("fetch", () => {
  // intentionally empty — let the browser handle it
});

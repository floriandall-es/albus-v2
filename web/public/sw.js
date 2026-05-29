/* Trivu PWA service worker.
 *
 * Two jobs:
 *
 * 1. Satisfy the browser "installable" criteria so Chrome / Edge /
 *    Android show the install prompt and our InstallButton can
 *    capture the `beforeinstallprompt` event. A minimal fetch
 *    listener is enough — the browser only checks that one exists,
 *    not that it does anything.
 *
 * 2. Handle Web Push (migration 0089). `push` paints the
 *    notification; `notificationclick` focuses an existing Trivu
 *    tab if one is open and routes it to the deep link, or opens
 *    a new one. The payload shape is the JSON our backend posts
 *    from app/services/push.py::send_push_to_person:
 *
 *        { title: string, body: string, url: string, tag?: string }
 *
 *    `tag` is the OS-level coalescing key — multiple pushes with
 *    the same tag collapse into one notification on the device, so
 *    a noisy DM doesn't stack five separate banners.
 *
 * We deliberately do NOT precache assets. Next.js ships content-
 * hashed bundles and our API responses are time-sensitive (live
 * schedules, DMs, directory). A stale-while-revalidate cache here
 * would create more bugs than it solves. Promote to next-pwa or
 * workbox when we have a clear offline story to ship.
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

self.addEventListener("push", (event) => {
  // Parse the payload. If anything goes wrong (no data, malformed
  // JSON) we still want to paint *something* so the user notices —
  // a silent push is a worse outcome than a fallback notification,
  // and silent pushes on iOS PWA can eventually de-register the
  // subscription as "not user-visible enough".
  let payload = {
    title: "Trivu",
    body: "Tienes mensajes nuevos",
    url: "/me/mensajes",
    tag: undefined,
  };
  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        title: parsed.title || payload.title,
        body: parsed.body || payload.body,
        url: parsed.url || payload.url,
        tag: parsed.tag || undefined,
      };
    } catch (err) {
      // Keep defaults; log for service-worker devtools.
      // eslint-disable-next-line no-console
      console.warn("[sw] push payload parse failed", err);
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // PWA icon — same one the manifest uses for the home-screen.
      // 192px is the spec'd "size that always works"; iOS picks
      // the closest available from the manifest if it wants more.
      icon: "/icons/icon-192.png",
      // Badge is the small monochrome icon shown in the status
      // bar on Android. Falls back to icon on platforms that don't
      // distinguish.
      badge: "/icons/icon-192.png",
      tag: payload.tag,
      // renotify=true with a tag means each new message in the
      // same conversation re-triggers the device's notification
      // sound/vibrate, even though the visible notification
      // collapses. Without this, only the FIRST push per tag
      // alerts the user and the rest land silently.
      renotify: Boolean(payload.tag),
      // Stash the URL on the notification itself so the click
      // handler can navigate without re-parsing the payload.
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  // Close the notification immediately so the user sees their
  // click "register". On iOS the notification otherwise lingers
  // for a beat after the app comes to the foreground, which
  // looks unresponsive.
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/me/mensajes";
  event.waitUntil(
    (async () => {
      // Find any existing Trivu window. If one's already open we
      // focus it and navigate (avoids piling up tabs); only open
      // a fresh one as a last resort. We accept any same-origin
      // client because the user may be on /admin or /me/turnos
      // when the push lands — focus that tab and shift it to the
      // deep link rather than spawning a duplicate.
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        try {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(targetUrl);
          }
          return;
        } catch (err) {
          // Some platforms throw on navigate() across origins or
          // for clients we don't control. Fall through to open a
          // new window.
          // eslint-disable-next-line no-console
          console.warn("[sw] focus/navigate failed", err);
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});

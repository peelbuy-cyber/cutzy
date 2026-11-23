/* Cutzy is a plain website, not an installable app.
   This file exists only to remove the service worker installed by earlier
   versions: it deletes every cache and unregisters itself. There is no
   fetch handler, so nothing is intercepted or cached — the site always
   loads fresh from the web. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => caches.delete(n)));
    await self.registration.unregister();
    await self.clients.claim();
  })());
});

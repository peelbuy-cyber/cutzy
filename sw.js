const CACHE = "cutzy-v6";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icons/icon.svg",
  "./demo/person-before.svg", "./demo/person-after.svg", "./demo/person-newbg.svg",
  "./demo/product-before.svg", "./demo/product-after.svg",
  "./demo/pet-before.svg", "./demo/pet-after.svg",
  "./demo/sneaker-before.svg", "./demo/sneaker-after.svg",
  "./demo/car-before.svg", "./demo/car-after.svg",
  "./demo/logo-before.svg", "./demo/logo-after.svg",
  "./demo/boost-grid.svg",
  "./gallery/product-newbg.svg", "./gallery/pet-newbg.svg", "./gallery/car-newbg.svg", "./gallery/logo-newbg.svg",
  "./gallery/person-collage.svg", "./gallery/product-collage.svg", "./gallery/pet-collage.svg", "./gallery/car-collage.svg", "./gallery/logo-collage.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  // Delete old caches (v3/v4) so returning visitors stop getting the stale
  // cached page and images after an update — without this, caches.match()
  // can keep serving the old version forever.
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* File handed in from Android's share sheet (Web Share Target POST) */
let pendingSharedFile = null;

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share")) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const media = fd.get("media");
        if (media && media.size > 0) pendingSharedFile = media;
      } catch { /* fall through */ }
      return Response.redirect(new URL("./?shared=1", e.request.url).href, 303);
    })());
    return;
  }
  // App shell: cache-first, then network; network responses refresh the cache.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "get-shared-file" && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ file: pendingSharedFile });
    pendingSharedFile = null;
  }
});

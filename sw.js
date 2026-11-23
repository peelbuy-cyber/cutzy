const CACHE = "cutzy-v3";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icons/icon.svg",
  "./demo/person-before.svg", "./demo/person-after.svg", "./demo/person-newbg.svg",
  "./demo/product-before.svg", "./demo/product-after.svg",
  "./demo/pet-before.svg", "./demo/pet-after.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

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

const CACHE_NAME = "operations-ledger-public-v2";
const PUBLIC_ASSETS = [
  "/manifest.webmanifest",
  "/assets/operations-ledger-32.png",
  "/assets/operations-ledger-192.png",
  "/assets/operations-ledger-512.png",
  "/assets/operations-ledger-maskable-512.png",
  "/assets/counter-gunsmith.jpg",
  "/assets/counter-tobacconist.jpg",
  "/assets/counter-saloon.jpg",
  "/assets/ledger-oxblood-leather.jpg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PUBLIC_ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )),
    self.clients.claim()
  ]));
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Private documents and data always use the network and never enter a cache.
  if (request.mode === "navigate"
    || url.pathname.endsWith(".html")
    || url.pathname.startsWith("/api/")
    || url.pathname.startsWith("/auth/")
    || url.pathname.startsWith("/health")) return;

  if (!PUBLIC_ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const cached = await cache.match(request);
    const refreshed = fetch(request).then(response => {
      if (response.ok && response.type === "basic") cache.put(request, response.clone());
      return response;
    });
    return cached || refreshed;
  }));
});

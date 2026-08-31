// Minimal service worker — exists to satisfy PWA installability (a fetch
// handler + a manifest), NOT to cache state data. This dashboard's whole
// point is never showing stale data silently (task brief, section 3's
// "cache-busted polling" requirement): caching state/*.json or the
// raw.githubusercontent.com/api.github.com calls here would work directly
// against that, so this SW only ever touches its own same-origin static
// shell (HTML/JS/CSS/icons) and always tries the network first.
const CACHE = "titan-runner-shell-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never touch a write
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never cache a cross-origin state/API call
  if (url.pathname.includes("/state/")) return; // never cache the same-origin build-time state snapshot either

  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request)),
  );
});

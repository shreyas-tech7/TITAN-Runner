// Minimal service worker. It makes the dashboard installable (a fetch handler and a manifest) and keeps the
// app shell, so a visit with no network still opens the page. It never caches state data. This dashboard's
// whole point is never showing stale data silently (task brief, section 3's "cache-busted polling"
// requirement), and caching state/*.json or the raw.githubusercontent.com and api.github.com calls would work
// against that. So it only touches its own same-origin static shell (HTML, JS, CSS, icons), keeps successful
// responses only, and always tries the network first.
const CACHE = "titan-runner-shell-v2";

self.addEventListener("install", (event) => {
  // Keep the app shell so a visit with no network still opens the dashboard. Its numbers come from
  // `state/*.json`, which is never cached here, so an offline visit shows the offline notice and not old data.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(self.registration.scope)).catch(() => {}));
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
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === "navigate" ? caches.match(self.registration.scope) : undefined)).then((hit) => hit || Response.error())),
  );
});

/**
 * knag service worker — caches the shell, and never the document.
 *
 * 🔴 The rule that matters (spec §9, §12): **no document response is ever cached.**
 * A stale body served from cache is worse than an offline error, because it looks
 * like the truth, and the next save would carry a `base_version` from a document
 * that has since moved on. Offline editing is explicitly out of scope.
 *
 * So `/api/*` and `/health` are not merely uncached — they are not intercepted at
 * all. `fetch` falls through to the network, and a failed request surfaces as a
 * failed request in the UI. That is the intended behaviour.
 *
 * Not bundled: this file is served verbatim from `public/`, so it is plain JS. It is
 * also not a module — `importScripts` semantics differ and there is nothing to share
 * with the app.
 */

// Bumping this evicts the old shell. It has to change whenever the shell changes,
// which is why it is a literal here rather than anything derived — a cache name
// computed at runtime cannot be a version.
const CACHE = "knag-shell-v1";

const SHELL = ["/", "/index.html", "/app.js", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  // Take over immediately rather than waiting for every tab to close. On a
  // single-user app the old worker has nothing to protect.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 🔴 Never touch the API or the health endpoint. Not cache-first, not
  // network-first, not stale-while-revalidate — untouched. See the header.
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;

  // Same-origin GETs only. A cross-origin request has nothing to do with the shell.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Cache-first for the shell, with the network as the fallback and a cache refresh
  // on the way past, so a deploy is picked up on the next load rather than never.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const live = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => hit);

      return hit ?? live;
    }),
  );
});

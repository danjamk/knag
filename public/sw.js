/**
 * knag service worker — network-first for the shell, and never the document.
 *
 * 🔴 Rule one (spec §9, §12): **no document response is ever cached.** A stale body
 * served from cache is worse than an offline error, because it looks like the truth,
 * and the next save would carry a `base_version` from a document that has since moved
 * on. So `/api/*` and `/health` are not merely uncached — they are not intercepted at
 * all. `fetch` falls through to the network and a failed request surfaces as a failed
 * request. Offline editing is explicitly out of scope.
 *
 * 🔴 Rule two, learned the hard way: **the shell is network-first, not cache-first.**
 * The first version of this file was cache-first with a hand-bumped `knag-shell-v1`
 * constant and a comment saying the constant "has to change whenever the shell
 * changes". It never changed, because nothing made it — so every deploy left the
 * browser running the *previous* `app.js` until a manual reload, and the polling
 * added in #6 appeared not to work at all.
 *
 * A design that depends on someone remembering to bump a literal is a design that
 * fails. Network-first removes the requirement instead of restating it: the cache
 * exists so the app opens when the network is gone, not so it can serve last week's
 * code. The shell is ~10kB and this product is online-first by definition.
 *
 * Not bundled: served verbatim from `public/`, so it is plain JS and not a module.
 */

// Only has to change if the *set* of cached paths changes. Correctness no longer
// depends on it, which is the point of the rewrite above.
const CACHE = "knag-shell-v2";

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

  // 🔴 Never touch the API or the health endpoint. Not cache-first, not network-first,
  // not stale-while-revalidate — untouched. See rule one.
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;

  // Same-origin GETs only. A cross-origin request has nothing to do with the shell.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      // Network unreachable. Now the cache earns its keep — this is the only path
      // that reads from it.
      .catch(async () => (await caches.match(event.request)) ?? Response.error()),
  );
});

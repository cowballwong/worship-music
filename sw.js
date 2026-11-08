// Service worker — keeps the app shell and libraries on the device so the site
// opens at church with weak or no signal. Song sheets are NOT handled here:
// app.js stores them itself (offline.js), because the Drive URLs differ between
// signed-in and signed-out downloads.
//
// Deploy rule: bump VERSION (and the ?v= in index.html) on every release.
// The new shell cache is filled completely in `install`; the old one is only
// deleted in `activate`, after the new one is ready.

const VERSION = "20261108a";
const SHELL = `wm-shell-${VERSION}`;
const RUNTIME = "wm-runtime-v1"; // fonts and other CDN files picked up while browsing

const SAME_ORIGIN = [
  "./",
  `./style.css?v=${VERSION}`,
  `./config.js?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./offline.js?v=${VERSION}`,
];
const CDN = [
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.worker.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
  "https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;700&family=Inter:wght@400;500;600;700&display=swap",
];
const CACHEABLE_HOSTS = new Set(["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SAME_ORIGIN);
    // CDN files: fetched in CORS mode so the stored copy is readable (not opaque).
    await Promise.all(CDN.map(async (url) => {
      const r = await fetch(new Request(url, { mode: "cors", credentials: "omit" }));
      if (!r.ok) throw new Error(`precache ${url}: ${r.status}`);
      await c.put(url, r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("wm-shell-") && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // The page itself: network-first so updates arrive, cached copy if the
  // network is down or too slow.
  if (req.mode === "navigate") {
    if (url.origin !== self.location.origin) return;
    event.respondWith((async () => {
      try {
        const r = await Promise.race([fetch(req), timeout(5000)]);
        if (r.ok) {
          const c = await caches.open(SHELL);
          c.put("./", r.clone());
        }
        return r;
      } catch {
        const c = await caches.open(SHELL);
        return (await c.match("./")) || Response.error();
      }
    })());
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  // Drive API, Google sign-in and everything else: always live, never cached here.
  if (!sameOrigin && !CACHEABLE_HOSTS.has(url.hostname)) return;
  // Offline sheet store keys are only read through Cache Storage, never fetched.
  if (sameOrigin && url.pathname.includes("/__offline/")) return;

  // Versioned shell files and pinned CDN versions: cache-first.
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok || r.type === "opaque") {
      const c = await caches.open(sameOrigin ? SHELL : RUNTIME);
      c.put(req, r.clone());
    }
    return r;
  })());
});

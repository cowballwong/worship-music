// Offline store — semi-offline support for church, where the signal is weak.
//
// Sheets (PDF bytes) live in Cache Storage under a synthetic same-origin key
// per Drive file id, NOT under the Drive URL. The Drive URL differs between a
// signed-in download (Bearer header) and a signed-out one (?key=), and the
// bytes are the same, so the page owns this cache rather than the service
// worker. Each entry remembers the Drive modifiedTime it was downloaded at, so
// an edited song is re-downloaded when online and the old copy still works
// when offline.
//
// Drive listings (folder ids, library file list, playlist file list) are
// network-first with a timeout, falling back to the last good copy.

const SHEETS = "wm-sheets-v1";
const DATA = "wm-data-v1";
const BASE = new URL("./", document.baseURI);
const sheetKey = (fileId) => new URL(`__offline/sheet/${encodeURIComponent(fileId)}`, BASE).href;
const dataKey = (key) => new URL(`__offline/data/${encodeURIComponent(key)}`, BASE).href;

export const hasCacheApi = () => typeof caches !== "undefined";
export const isOffline = () => navigator.onLine === false;

/** Network-first JSON GET with a timeout; falls back to the last good copy. */
export async function netFirstJson(url, key, timeoutMs = 8000) {
  let netErr = null;
  if (!isOffline()) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (hasCacheApi()) {
        try {
          const c = await caches.open(DATA);
          await c.put(dataKey(key), new Response(JSON.stringify(j), {
            headers: { "Content-Type": "application/json", "x-wm-saved": String(Date.now()) },
          }));
        } catch {}
      }
      return { json: j, fromCache: false };
    } catch (e) {
      netErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  if (hasCacheApi()) {
    try {
      const c = await caches.open(DATA);
      const hit = await c.match(dataKey(key));
      if (hit) return { json: await hit.json(), fromCache: true };
    } catch {}
  }
  throw netErr || new Error("offline, no saved copy");
}

/** Cached sheet bytes for a Drive file id, or null. */
export async function getSheet(fileId) {
  if (!hasCacheApi()) return null;
  try {
    const c = await caches.open(SHEETS);
    const hit = await c.match(sheetKey(fileId));
    if (!hit) return null;
    return { buf: await hit.arrayBuffer(), mtime: hit.headers.get("x-wm-mtime") || "" };
  } catch {
    return null;
  }
}

export async function putSheet(fileId, mtime, buf) {
  if (!hasCacheApi()) return;
  try {
    const c = await caches.open(SHEETS);
    await c.put(sheetKey(fileId), new Response(buf, {
      headers: { "Content-Type": "application/pdf", "x-wm-mtime": mtime || "" },
    }));
  } catch (e) {
    console.warn("offline: could not store sheet", fileId, e);
  }
}

/** Is this sheet stored? With mtime given, only an up-to-date copy counts. */
export async function hasSheet(fileId, mtime) {
  if (!hasCacheApi()) return false;
  try {
    const c = await caches.open(SHEETS);
    const hit = await c.match(sheetKey(fileId));
    if (!hit) return false;
    return mtime == null || (hit.headers.get("x-wm-mtime") || "") === (mtime || "");
  } catch {
    return false;
  }
}

/** Ask the browser not to evict our storage (honoured by Chrome; Safari may ignore). */
let persistAsked = false;
export async function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
}

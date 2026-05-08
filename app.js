// Worship Music app — Phase 2 (read + OAuth + save back to Drive)
// Editor UI (annotation tools) lands in Phase 2.1 — for now Save uploads
// the (unmodified) PDF back to verify the round-trip works.

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const cfg = window.WORSHIP_CONFIG;
const $ = (id) => document.getElementById(id);

// ────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────
let libFiles = [];
let playlists = [];
let libBySongTitle = {};
let libSubfolderId = null;
let plSubfolderId = null;

let viewerQueue = [];
let viewerIndex = 0;
let currentPdfBytes = null;   // bytes of currently-open PDF (for re-save)
let currentPdfDoc = null;     // pdfjs document instance

// OAuth state
let oauthToken = null;        // {access_token, expires_at_ms}
let tokenClient = null;       // GIS TokenClient instance

// ────────────────────────────────────────────────
// Drive helpers
// ────────────────────────────────────────────────
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

function authedHeaders() {
  if (oauthToken && oauthToken.access_token)
    return { Authorization: `Bearer ${oauthToken.access_token}` };
  return {};
}

async function driveListFolder(folderId) {
  const url =
    `${API}/files` +
    `?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}` +
    `&fields=files(id,name,mimeType,size,modifiedTime)` +
    `&pageSize=1000` +
    `&key=${cfg.API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Drive list failed: ${r.status}`);
  return (await r.json()).files || [];
}

async function findSubfolderId(parentId, name) {
  const url =
    `${API}/files` +
    `?q=${encodeURIComponent(
      `'${parentId}' in parents and name='${name}' and ` +
      `mimeType='application/vnd.google-apps.folder' and trashed=false`
    )}` +
    `&fields=files(id,name)` +
    `&key=${cfg.API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Drive subfolder lookup failed: ${r.status}`);
  const f = (await r.json()).files || [];
  return f[0]?.id || null;
}

function pdfDownloadUrl(fileId) {
  return `${API}/files/${fileId}?alt=media&key=${cfg.API_KEY}`;
}

async function uploadPdfBytes(fileId, bytes) {
  if (!oauthToken?.access_token) throw new Error("Not signed in");
  const r = await fetch(
    `${UPLOAD}/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        ...authedHeaders(),
        "Content-Type": "application/pdf",
      },
      body: bytes,
    }
  );
  if (!r.ok) throw new Error(`Upload failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

// ────────────────────────────────────────────────
// OAuth (Google Identity Services — token model)
// ────────────────────────────────────────────────
const SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_KEY = "wm-oauth-token-v1";

function loadStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t.access_token || !t.expires_at_ms) return null;
    if (Date.now() > t.expires_at_ms - 60000) return null; // expires in <1 min
    return t;
  } catch {
    return null;
  }
}
function storeToken(t) {
  oauthToken = t;
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  reflectAuthState();
}
function clearToken() {
  oauthToken = null;
  localStorage.removeItem(TOKEN_KEY);
  reflectAuthState();
}

function initGis() {
  if (
    !cfg.OAUTH_CLIENT_ID ||
    cfg.OAUTH_CLIENT_ID === "REPLACE_ME_CLIENT_ID.apps.googleusercontent.com"
  ) {
    console.warn("OAUTH_CLIENT_ID not set — sign-in disabled");
    return;
  }
  if (!window.google || !window.google.accounts) {
    // GIS script not yet ready — retry shortly
    setTimeout(initGis, 250);
    return;
  }
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: cfg.OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        toast(`Sign-in failed: ${resp.error}`);
        return;
      }
      const expiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
      storeToken({
        access_token: resp.access_token,
        expires_at_ms: expiresAt,
      });
      toast("Signed in ✓");
    },
  });
}

function signIn() {
  if (!tokenClient) {
    toast("Sign-in not configured (check OAUTH_CLIENT_ID).");
    return;
  }
  tokenClient.requestAccessToken({ prompt: oauthToken ? "" : "consent" });
}

function signOut() {
  const t = oauthToken?.access_token;
  if (t && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(t, () => {});
  }
  clearToken();
  toast("Signed out");
}

function reflectAuthState() {
  const signedIn = !!oauthToken?.access_token;
  $("signin-btn").textContent = signedIn ? "Sign out" : "Sign in";
  $("viewer-edit").disabled = !signedIn;
  $("viewer-edit").title = signedIn
    ? "Edit annotations"
    : "Sign in to edit";
  $("new-playlist-btn").disabled = !signedIn;
}

// ────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────
async function init() {
  oauthToken = loadStoredToken();
  reflectAuthState();
  initGis();

  if (
    !cfg.DRIVE_FOLDER_ID ||
    cfg.DRIVE_FOLDER_ID === "REPLACE_ME_FOLDER_ID" ||
    !cfg.API_KEY ||
    cfg.API_KEY === "REPLACE_ME_API_KEY"
  ) {
    showSetupHint();
    return;
  }

  try {
    [libSubfolderId, plSubfolderId] = await Promise.all([
      findSubfolderId(cfg.DRIVE_FOLDER_ID, cfg.LIB_FOLDER_NAME),
      findSubfolderId(cfg.DRIVE_FOLDER_ID, cfg.PLAYLISTS_FOLDER_NAME),
    ]);

    if (!libSubfolderId) {
      $("lib-grid").innerHTML = emptyHtml(
        "❌",
        `Subfolder "${cfg.LIB_FOLDER_NAME}" not found inside Drive folder.`
      );
      return;
    }
    await Promise.all([loadLibrary(), loadPlaylists()]);
  } catch (e) {
    console.error(e);
    $("lib-grid").innerHTML = emptyHtml("⚠️", `Drive error: ${e.message}`);
  }
}

async function loadLibrary() {
  const files = (await driveListFolder(libSubfolderId)).filter((f) =>
    /\.pdf$/i.test(f.name)
  );
  libFiles = files.sort((a, b) => a.name.localeCompare(b.name));
  libBySongTitle = {};
  libFiles.forEach((f) => (libBySongTitle[stem(f.name)] = f));
  renderLibrary();
}

async function loadPlaylists() {
  if (!plSubfolderId) {
    $("playlist-list").innerHTML = emptyHtml(
      "📅",
      `No "${cfg.PLAYLISTS_FOLDER_NAME}" subfolder yet — create one in Drive when you're ready.`
    );
    return;
  }
  const files = (await driveListFolder(plSubfolderId)).filter((f) =>
    /\.json$/i.test(f.name)
  );
  playlists = await Promise.all(
    files.map(async (f) => {
      try {
        const r = await fetch(pdfDownloadUrl(f.id));
        const j = await r.json();
        return { id: f.id, name: f.name, ...j };
      } catch {
        return { id: f.id, name: f.name, songs: [], error: true };
      }
    })
  );
  playlists.sort((a, b) =>
    (b.date || b.name).localeCompare(a.date || a.name)
  );
  renderPlaylists();
}

// ────────────────────────────────────────────────
// Render
// ────────────────────────────────────────────────
function renderLibrary(filter = "") {
  const grid = $("lib-grid");
  const count = $("lib-count");
  const q = filter.toLowerCase().trim();
  const matches = libFiles.filter(
    (f) => !q || f.name.toLowerCase().includes(q)
  );
  count.textContent = `${matches.length} / ${libFiles.length} song${libFiles.length === 1 ? "" : "s"}`;
  if (matches.length === 0) {
    grid.innerHTML = emptyHtml("🔍", "No matches — try a different keyword.");
    return;
  }
  grid.innerHTML = "";
  for (const f of matches) {
    const card = document.createElement("div");
    card.className = "song-card";
    card.innerHTML = `
      <div class="title">${escape(stem(f.name))}</div>
      <div class="meta">${kb(f.size)} · ${shortDate(f.modifiedTime)}</div>
    `;
    card.addEventListener("click", () => openSong(f));
    grid.appendChild(card);
  }
}

function renderPlaylists() {
  const list = $("playlist-list");
  if (playlists.length === 0) {
    list.innerHTML = emptyHtml("📅", `No playlists yet — create one in Drive's "${cfg.PLAYLISTS_FOLDER_NAME}" folder.`);
    return;
  }
  list.innerHTML = "";
  for (const p of playlists) {
    const card = document.createElement("div");
    card.className = "playlist-card";
    card.innerHTML = `
      <div class="date">${escape(p.date || stem(p.name))}</div>
      <div class="title">${escape(p.title || "Sunday Set")}</div>
      <div class="songs">${escape((p.songs || []).join(" · "))}</div>
    `;
    card.addEventListener("click", () => openPlaylist(p));
    list.appendChild(card);
  }
}

// ────────────────────────────────────────────────
// PDF viewer
// ────────────────────────────────────────────────
async function openSong(file) {
  viewerQueue = [{ file, name: stem(file.name) }];
  viewerIndex = 0;
  await showCurrent();
  $("viewer").classList.remove("hidden");
}

async function openPlaylist(p) {
  const songs = (p.songs || [])
    .map((title) => libBySongTitle[title])
    .filter(Boolean)
    .map((file) => ({ file, name: stem(file.name) }));
  if (songs.length === 0) {
    toast(`Playlist has no matching songs in library.`);
    return;
  }
  viewerQueue = songs;
  viewerIndex = 0;
  await showCurrent();
  $("viewer").classList.remove("hidden");
}

async function showCurrent() {
  if (viewerQueue.length === 0) return;
  const cur = viewerQueue[viewerIndex];
  $("viewer-name").textContent = cur.name;
  $("viewer-progress").textContent =
    viewerQueue.length > 1
      ? `${viewerIndex + 1} / ${viewerQueue.length}`
      : "";
  await renderPdf(cur.file);
}

async function renderPdf(file) {
  const wrap = $("viewer-canvas-wrap");
  wrap.innerHTML = '<div class="muted small" style="color:#bbb;padding:30px;">Loading…</div>';
  try {
    const buf = await (await fetch(pdfDownloadUrl(file.id))).arrayBuffer();
    currentPdfBytes = new Uint8Array(buf);
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    currentPdfDoc = pdf;
    wrap.innerHTML = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const baseVp = page.getViewport({ scale: 1 });
      const targetWidth = Math.min(wrap.clientWidth - 20, 1400);
      const scale = targetWidth / baseVp.width;
      const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.width = vp.width / (window.devicePixelRatio || 1) + "px";
      canvas.style.height = vp.height / (window.devicePixelRatio || 1) + "px";
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      wrap.appendChild(canvas);
    }
  } catch (e) {
    console.error(e);
    wrap.innerHTML = `<div class="empty"><div class="icon">⚠️</div>PDF load failed: ${e.message}</div>`;
  }
}

// ────────────────────────────────────────────────
// Edit + Save (Phase 2 — round-trip plumbing)
// Editor UI tools (text / ink / highlight) come in Phase 2.1.
// ────────────────────────────────────────────────
function enterEditMode() {
  if (!oauthToken?.access_token) {
    toast("Sign in first.");
    return;
  }
  $("viewer-edit").classList.add("hidden");
  $("viewer-save").classList.remove("hidden");
  toast("Edit UI lands in Phase 2.1 — pipeline ready, save will round-trip");
}

async function saveAndUpload() {
  if (!oauthToken?.access_token) return toast("Not signed in.");
  const cur = viewerQueue[viewerIndex];
  if (!cur || !currentPdfDoc) return;
  toast("Saving…", 6000);
  try {
    // Phase 2.0: pdf.js v4 saveDocument() returns the (possibly modified) PDF.
    // Without editor UI it returns equivalent bytes — round-trip still works.
    const bytes = await currentPdfDoc.saveDocument();
    await uploadPdfBytes(cur.file.id, bytes);
    toast(`Saved ✓ ${cur.name}`);
    $("viewer-save").classList.add("hidden");
    $("viewer-edit").classList.remove("hidden");
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${e.message}`);
  }
}

// ────────────────────────────────────────────────
// UI bindings
// ────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $("view-" + tab.dataset.view).classList.add("active");
  });
});

$("lib-search").addEventListener("input", (e) => renderLibrary(e.target.value));
$("viewer-close").addEventListener("click", () => $("viewer").classList.add("hidden"));
$("viewer-prev").addEventListener("click", async () => {
  if (viewerIndex > 0) { viewerIndex--; await showCurrent(); }
});
$("viewer-next").addEventListener("click", async () => {
  if (viewerIndex < viewerQueue.length - 1) { viewerIndex++; await showCurrent(); }
});
$("viewer-edit").addEventListener("click", enterEditMode);
$("viewer-save").addEventListener("click", saveAndUpload);

$("theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "night" ? "day" : "night";
  document.documentElement.setAttribute("data-theme", next);
  $("theme-btn").textContent = next === "night" ? "☀️" : "🌙";
  localStorage.setItem("wm-theme", next);
});
const savedTheme = localStorage.getItem("wm-theme");
if (savedTheme) {
  document.documentElement.setAttribute("data-theme", savedTheme);
  $("theme-btn").textContent = savedTheme === "night" ? "☀️" : "🌙";
}

$("signin-btn").addEventListener("click", () => {
  if (oauthToken?.access_token) signOut();
  else signIn();
});

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────
function stem(name) { return name.replace(/\.[^.]+$/, ""); }
function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function kb(bytes) {
  if (!bytes) return "—";
  const n = Number(bytes);
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function shortDate(iso) {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}
function emptyHtml(icon, msg, hint = "") {
  return `<div class="empty"><div class="icon">${icon}</div>${escape(msg)}${hint ? `<div class="hint">${escape(hint)}</div>` : ""}</div>`;
}
function toast(msg, ms = 2400) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function showSetupHint() {
  const helpHtml = `
    <div class="empty">
      <div class="icon">⚙️</div>
      <strong>One-time setup needed.</strong>
      <div class="hint">Open <code>config.js</code> and set:</div>
      <pre>DRIVE_FOLDER_ID — Sunday guitar folder ID
API_KEY         — Google Cloud API key (Drive API enabled)
OAUTH_CLIENT_ID — for Phase 2 (edit/save)</pre>
      <div class="hint">See README for the 5-min Cloud Console walk-through.</div>
    </div>`;
  $("lib-grid").innerHTML = helpHtml;
  $("playlist-list").innerHTML = "";
}

init();

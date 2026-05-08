// Worship Music app — Phase 1 + 2 + 3 combined
//   Phase 1 — read-only library + playlists (Drive iframe view)
//   Phase 2 — Sign-in + Edit + Save (custom canvas + pdf-lib FreeText annotations)
//   Phase 3 — Playlist editor (CRUD JSON in playlists/ Drive folder)

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.worker.min.mjs";

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

// Edit mode state
let editMode = false;
let editPdfBytes = null;        // current PDF bytes (Uint8Array) for editing
let editPdfDoc = null;          // pdfjs doc
let editPageDims = [];          // [{ w, h }] in PDF points (page native)
let pendingAnnotations = [];    // various types — see types below
let activeTool = "text";
let currentDrag = null;         // active drag-tool stroke being drawn

const DRAG_TOOLS = new Set(["pen", "line", "box", "circle", "arrow"]);

// OAuth state
let oauthToken = null;
let tokenClient = null;

// Playlist editor state
let plEditorOpen = false;
let plEditing = null;           // {id?, name, date, title, notes, songs[]}

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

async function createSubfolder(parentId, name) {
  const r = await fetch(`${API}/files`, {
    method: "POST",
    headers: { ...authedHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!r.ok) throw new Error(`Create folder failed: ${r.status}`);
  return await r.json();
}

function pdfDownloadUrl(fileId) {
  return `${API}/files/${fileId}?alt=media&key=${cfg.API_KEY}`;
}

async function uploadPdfBytes(fileId, bytes) {
  if (!oauthToken?.access_token) throw new Error("Not signed in");
  const r = await fetch(`${UPLOAD}/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { ...authedHeaders(), "Content-Type": "application/pdf" },
    body: bytes,
  });
  if (!r.ok) throw new Error(`Upload failed: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function uploadJson(parentId, filename, jsonObj, existingFileId = null) {
  if (!oauthToken?.access_token) throw new Error("Not signed in");
  const body = JSON.stringify(jsonObj, null, 2);
  if (existingFileId) {
    const r = await fetch(
      `${UPLOAD}/files/${existingFileId}?uploadType=media`,
      {
        method: "PATCH",
        headers: { ...authedHeaders(), "Content-Type": "application/json" },
        body,
      }
    );
    if (!r.ok) throw new Error(`JSON update failed: ${r.status}`);
    return await r.json();
  } else {
    // Multipart: metadata + content
    const boundary = "----wm" + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: filename, parents: [parentId] });
    const multi =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
      `--${boundary}--`;
    const r = await fetch(
      `${UPLOAD}/files?uploadType=multipart&fields=id,name`,
      {
        method: "POST",
        headers: {
          ...authedHeaders(),
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multi,
      }
    );
    if (!r.ok) throw new Error(`JSON create failed: ${r.status} ${await r.text()}`);
    return await r.json();
  }
}

async function deleteDriveFile(fileId) {
  if (!oauthToken?.access_token) throw new Error("Not signed in");
  const r = await fetch(`${API}/files/${fileId}`, {
    method: "DELETE",
    headers: authedHeaders(),
  });
  if (!r.ok && r.status !== 204) throw new Error(`Delete failed: ${r.status}`);
}

// ────────────────────────────────────────────────
// OAuth
// ────────────────────────────────────────────────
const SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_KEY = "wm-oauth-token-v1";

function loadStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t.access_token || !t.expires_at_ms) return null;
    if (Date.now() > t.expires_at_ms - 60000) return null;
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
    return;
  }
  if (!window.google || !window.google.accounts) {
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
  $("viewer-edit").title = signedIn ? "Edit annotations" : "Sign in to edit";
  $("new-playlist-btn").disabled = !signedIn;
  $("new-playlist-btn").title = signedIn ? "Create playlist" : "Sign in to create";
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
      `No "${cfg.PLAYLISTS_FOLDER_NAME}" subfolder yet — sign in & tap ＋ New to create the first playlist.`
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
  const matches = libFiles.filter((f) => !q || f.name.toLowerCase().includes(q));
  count.textContent = `${matches.length} / ${libFiles.length} song${libFiles.length === 1 ? "" : "s"}`;
  if (matches.length === 0) {
    grid.innerHTML = emptyHtml("🔍", "No matches.");
    return;
  }
  grid.innerHTML = "";
  for (const f of matches) {
    const card = document.createElement("div");
    card.className = "song-card";
    card.innerHTML = `
      <div class="title">${escape(stem(f.name))}</div>
      <div class="meta">${kb(f.size)} · ${shortDate(f.modifiedTime)}</div>`;
    card.addEventListener("click", () => openSong(f));
    grid.appendChild(card);
  }
}

function renderPlaylists() {
  const list = $("playlist-list");
  if (playlists.length === 0) {
    list.innerHTML = emptyHtml("📅", `No playlists yet.`);
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
      ${oauthToken ? `<div class="pl-edit-pill" data-edit="1">✏️ Edit</div>` : ""}
    `;
    card.addEventListener("click", (e) => {
      if (e.target.dataset.edit) {
        openPlaylistEditor(p);
      } else {
        playPlaylist(p);
      }
    });
    list.appendChild(card);
  }
}

// ────────────────────────────────────────────────
// View mode (Drive iframe)
// ────────────────────────────────────────────────
async function openSong(file) {
  viewerQueue = [{ file, name: stem(file.name) }];
  viewerIndex = 0;
  $("viewer").classList.remove("hidden");
  exitEditUi();
  await new Promise((r) => requestAnimationFrame(r));
  await showCurrent();
}

async function playPlaylist(p) {
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
  $("viewer").classList.remove("hidden");
  exitEditUi();
  await new Promise((r) => requestAnimationFrame(r));
  await showCurrent();
}

async function showCurrent() {
  if (viewerQueue.length === 0) return;
  const cur = viewerQueue[viewerIndex];
  $("viewer-name").textContent = cur.name;
  $("viewer-progress").textContent =
    viewerQueue.length > 1 ? `${viewerIndex + 1} / ${viewerQueue.length}` : "";
  await showInIframe(cur.file);
}

async function showInIframe(file) {
  const wrap = $("viewer-canvas-wrap");
  wrap.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = `https://drive.google.com/file/d/${file.id}/preview`;
  iframe.title = stem(file.name);
  iframe.style.cssText = "width:100%;height:100%;border:0;background:#fff;";
  iframe.allow = "autoplay";
  wrap.appendChild(iframe);
}

// ────────────────────────────────────────────────
// EDIT MODE — render PDF.js canvas + tap-to-add text annotations
// ────────────────────────────────────────────────
async function enterEditMode() {
  if (!oauthToken?.access_token) return toast("Sign in first.");
  if (viewerQueue.length === 0) return;
  const cur = viewerQueue[viewerIndex];

  editMode = true;
  pendingAnnotations = [];
  activeTool = "text";
  document.querySelectorAll(".edit-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === activeTool));

  $("viewer-edit").classList.add("hidden");
  $("viewer-cancel").classList.remove("hidden");
  $("viewer-save").classList.remove("hidden");
  $("edit-toolbar").classList.remove("hidden");
  $("viewer-prev").disabled = true;
  $("viewer-next").disabled = true;

  toast("Edit mode — tap on the score to add chord/note");

  const wrap = $("viewer-canvas-wrap");
  wrap.innerHTML = '<div class="muted small" style="color:#bbb;padding:30px;">Loading for edit…</div>';

  try {
    const buf = await (await fetch(pdfDownloadUrl(cur.file.id))).arrayBuffer();
    editPdfBytes = new Uint8Array(buf);
    const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    editPdfDoc = pdf;
    editPageDims = [];

    wrap.innerHTML = "";
    await new Promise((r) => requestAnimationFrame(r));
    const wrapW = wrap.clientWidth > 100 ? wrap.clientWidth : window.innerWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetWidth = Math.max(320, Math.min(wrapW - 16, 1600));

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const baseVp = page.getViewport({ scale: 1 });
      editPageDims.push({ w: baseVp.width, h: baseVp.height });
      const scale = targetWidth / baseVp.width;
      const vp = page.getViewport({ scale: scale * dpr });

      const container = document.createElement("div");
      container.className = "edit-page-container";
      container.dataset.page = i;
      container.style.width = (vp.width / dpr) + "px";
      container.style.height = (vp.height / dpr) + "px";

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      container.appendChild(canvas);

      const overlay = document.createElement("div");
      overlay.className = "edit-overlay";
      overlay.dataset.page = i;
      overlay.addEventListener("click", (e) => {
        if (currentDrag) return;
        onOverlayTap(e, i);
      });
      attachDrawHandlers(overlay, i);
      container.appendChild(overlay);

      wrap.appendChild(container);

      // Render onto the canvas
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }
    updateEditCount();
  } catch (e) {
    console.error(e);
    wrap.innerHTML = `<div class="empty"><div class="icon">⚠️</div>Edit prep failed: ${escape(e.message)}</div>`;
    exitEditMode();
  }
}

function exitEditMode() {
  editMode = false;
  exitEditUi();
  // re-show iframe view
  const cur = viewerQueue[viewerIndex];
  if (cur) showInIframe(cur.file);
}

function exitEditUi() {
  editMode = false;
  pendingAnnotations = [];
  $("viewer-edit").classList.remove("hidden");
  $("viewer-cancel").classList.add("hidden");
  $("viewer-save").classList.add("hidden");
  $("edit-toolbar").classList.add("hidden");
  $("viewer-prev").disabled = false;
  $("viewer-next").disabled = false;
  updateEditCount();
}

async function onOverlayTap(e, pageNum) {
  if (!editMode) return;
  if (activeTool === "eraser") return; // eraser uses pointerdown drag
  if (DRAG_TOOLS.has(activeTool)) return; // drag tools use pointerdown
  const overlay = e.currentTarget;
  const rect = overlay.getBoundingClientRect();
  const tapX = e.clientX - rect.left;
  const tapY = e.clientY - rect.top;
  const dim = editPageDims[pageNum - 1];
  const pdfX = (tapX / rect.width) * dim.w;
  const pdfYTop = (tapY / rect.height) * dim.h;
  const pdfY = dim.h - pdfYTop;

  if (activeTool === "text") {
    const text = prompt("Annotation text 文字 (e.g. Capo 4)", "");
    if (!text || !text.trim()) return;
    const color = $("edit-color").value;
    const size = parseInt($("edit-fontsize").value, 10) || 14;
    const idx = pendingAnnotations.length;
    pendingAnnotations.push({
      type: "text", page: pageNum, x: pdfX, y: pdfY,
      text: text.trim(), color, size, idx,
    });
    addPinDom(overlay, tapX, tapY, text.trim(), color, size, idx);
  } else if (activeTool === "highlight") {
    const w_pdf = 80, h_pdf = 16;
    const idx = pendingAnnotations.length;
    pendingAnnotations.push({
      type: "highlight", page: pageNum,
      x: pdfX, y: pdfY - h_pdf, w: w_pdf, h: h_pdf,
      color: $("edit-color").value, idx,
    });
    addHighlightDom(overlay, tapX, tapY, $("edit-color").value, idx);
  }
  updateEditCount();
}

function addPinDom(overlay, cssX, cssY, text, color, size, idx) {
  const pin = document.createElement("div");
  pin.className = "annotation-pin";
  pin.style.left = cssX + "px";
  pin.style.top = cssY + "px";
  pin.style.color = color;
  pin.style.fontSize = size + "px";
  pin.dataset.idx = idx;
  pin.innerHTML = `<span>${escape(text)}</span><span class="pin-x">✕</span>`;
  pin.querySelector(".pin-x").addEventListener("click", (e) => {
    e.stopPropagation();
    const i = parseInt(pin.dataset.idx, 10);
    pendingAnnotations[i] = null; // mark removed
    pin.remove();
    updateEditCount();
  });
  overlay.appendChild(pin);
}

function addHighlightDom(overlay, cssX, cssY, color, idx) {
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;left:${cssX}px;top:${cssY - 12}px;width:80px;height:18px;background:${color}66;border:1px solid ${color};pointer-events:auto;`;
  div.dataset.idx = idx;
  div.title = "Tap to remove";
  div.addEventListener("click", (e) => {
    e.stopPropagation();
    const i = parseInt(div.dataset.idx, 10);
    pendingAnnotations[i] = null;
    div.remove();
    updateEditCount();
  });
  overlay.appendChild(div);
}

function updateEditCount() {
  const n = pendingAnnotations.filter(Boolean).length;
  $("edit-count").textContent = n ? `${n} pending change${n === 1 ? "" : "s"}` : "";
}

// ────────── ERASER (pixel-style) ───────────────────────────────
// Drag the eraser; ink strokes get partially-erased point-by-point and
// split into surviving fragments. Other shapes are removed if the eraser
// passes over their bounding box.
function eraserRadiusPx() {
  const sz = parseInt($("edit-fontsize").value, 10) || 14;
  // map font/size to a usable eraser radius (px)
  return Math.max(8, sz * 1.4);
}

function eraseSwipe(overlay, pageNum, cssX, cssY) {
  const rect = overlay.getBoundingClientRect();
  const dim = editPageDims[pageNum - 1];
  const radius = eraserRadiusPx();
  const r2 = radius * radius;

  // For each ink annotation: convert its PDF points to CSS, find points
  // inside the eraser radius, drop them, and split the stroke into surviving
  // contiguous runs.
  for (let i = 0; i < pendingAnnotations.length; i++) {
    const a = pendingAnnotations[i];
    if (!a || a.page !== pageNum) continue;

    if (a.type === "ink") {
      const cssPts = a.points.map((p) => ({
        x: (p.x / dim.w) * rect.width,
        y: ((dim.h - p.y) / dim.h) * rect.height,
      }));
      const erased = cssPts.map((p) => {
        const dx = p.x - cssX, dy = p.y - cssY;
        return dx * dx + dy * dy <= r2;
      });
      if (!erased.some(Boolean)) continue;

      // Build surviving runs
      const runs = [];
      let cur = [];
      for (let j = 0; j < cssPts.length; j++) {
        if (erased[j]) {
          if (cur.length > 1) runs.push(cur);
          cur = [];
        } else {
          cur.push(j);
        }
      }
      if (cur.length > 1) runs.push(cur);

      // Remove old annotation and its DOM
      pendingAnnotations[i] = null;
      overlay.querySelectorAll(`[data-idx="${i}"]`).forEach((el) => el.remove());

      // Add new sub-annotations for surviving runs
      for (const run of runs) {
        const newIdx = pendingAnnotations.length;
        const newPts = run.map((j) => a.points[j]);
        pendingAnnotations.push({ ...a, points: newPts, idx: newIdx });
        // Render
        const NS = "http://www.w3.org/2000/svg";
        const svg = ensureSvg(overlay);
        const path = document.createElementNS(NS, "path");
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("stroke", a.color);
        path.setAttribute("stroke-width", String(a.width * (rect.width / dim.w)));
        const cssAgain = newPts.map((p) => ({
          x: (p.x / dim.w) * rect.width,
          y: ((dim.h - p.y) / dim.h) * rect.height,
        }));
        path.setAttribute("d", pointsToSvgD(cssAgain));
        path.dataset.idx = newIdx;
        path.classList.add("erasable");
        svg.appendChild(path);
      }
    } else {
      // Object-erase for non-ink shapes
      const els = overlay.querySelectorAll(`[data-idx="${i}"]`);
      let hit = false;
      els.forEach((el) => {
        const er = el.getBoundingClientRect();
        const left = er.left - rect.left, top = er.top - rect.top;
        const right = er.right - rect.left, bot = er.bottom - rect.top;
        if (cssX + radius >= left && cssX - radius <= right &&
            cssY + radius >= top && cssY - radius <= bot) {
          hit = true;
        }
      });
      if (hit) {
        pendingAnnotations[i] = null;
        els.forEach((el) => el.remove());
      }
    }
  }
  updateEditCount();
}

function ensureEraserCursor(overlay) {
  let c = overlay.querySelector(".eraser-cursor");
  if (!c) {
    c = document.createElement("div");
    c.className = "eraser-cursor";
    overlay.appendChild(c);
  }
  return c;
}
function moveEraserCursor(c, cssX, cssY, radius) {
  c.style.cssText = `
    position:absolute;left:${cssX - radius}px;top:${cssY - radius}px;
    width:${radius * 2}px;height:${radius * 2}px;
    border:2px dashed rgba(120,120,120,.85);background:rgba(255,255,255,.18);
    border-radius:50%;pointer-events:none;`;
}

// ────────── DRAG TOOLS (pen / line / box / circle / arrow / eraser) ─────────
function attachDrawHandlers(overlay, pageNum) {
  overlay.addEventListener("pointerdown", (e) => {
    if (!editMode) return;
    const isEraser = activeTool === "eraser";
    if (!DRAG_TOOLS.has(activeTool) && !isEraser) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    const rect = overlay.getBoundingClientRect();
    const start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (isEraser) {
      currentDrag = { tool: "eraser", pageNum, overlay, rect };
      const c = ensureEraserCursor(overlay);
      moveEraserCursor(c, start.x, start.y, eraserRadiusPx());
      eraseSwipe(overlay, pageNum, start.x, start.y);
      return;
    }
    const svgEls = createSvgForTool(overlay, activeTool);
    currentDrag = {
      tool: activeTool, pageNum, overlay, rect,
      points: [start], svgEls,
      color: $("edit-color").value,
      width: getPenWidth(),
    };
    updateDragVisual(currentDrag);
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!currentDrag || currentDrag.overlay !== overlay) return;
    const rect = currentDrag.rect;
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (currentDrag.tool === "eraser") {
      const c = overlay.querySelector(".eraser-cursor");
      if (c) moveEraserCursor(c, p.x, p.y, eraserRadiusPx());
      eraseSwipe(overlay, pageNum, p.x, p.y);
      return;
    }
    if (currentDrag.tool === "pen") {
      currentDrag.points.push(p);
    } else {
      currentDrag.points = [currentDrag.points[0], p];
    }
    updateDragVisual(currentDrag);
  });
  const finalize = (e) => {
    if (!currentDrag || currentDrag.overlay !== overlay) return;
    try { overlay.releasePointerCapture(e.pointerId); } catch {}
    const d = currentDrag;
    currentDrag = null;
    if (d.tool === "eraser") {
      const c = overlay.querySelector(".eraser-cursor");
      if (c) c.remove();
      return;
    }
    if (d.points.length < 2 || sameSpot(d.points[0], d.points[d.points.length - 1])) {
      d.svgEls.forEach((el) => el.remove());
      return;
    }
    finalizeDrag(d);
    setTimeout(() => {}, 50);
  };
  overlay.addEventListener("pointerup", finalize);
  overlay.addEventListener("pointercancel", finalize);
}

function sameSpot(a, b) {
  return Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3;
}

function getPenWidth() {
  return Math.max(1, parseInt($("edit-fontsize").value, 10) / 4);
}

function ensureSvg(overlay) {
  let svg = overlay.querySelector("svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.appendChild(svg);
  }
  return svg;
}

function createSvgForTool(overlay, tool) {
  const svg = ensureSvg(overlay);
  const NS = "http://www.w3.org/2000/svg";
  const els = [];
  switch (tool) {
    case "pen": {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
      els.push(p);
      break;
    }
    case "line":
    case "arrow": {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke-linecap", "round");
      svg.appendChild(p);
      els.push(p);
      break;
    }
    case "box": {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("fill", "none");
      svg.appendChild(r);
      els.push(r);
      break;
    }
    case "circle": {
      const e = document.createElementNS(NS, "ellipse");
      e.setAttribute("fill", "none");
      svg.appendChild(e);
      els.push(e);
      break;
    }
  }
  return els;
}

function updateDragVisual(d) {
  const [el] = d.svgEls;
  el.setAttribute("stroke", d.color);
  el.setAttribute("stroke-width", d.width);
  if (d.tool === "pen") {
    el.setAttribute("d", pointsToSvgD(d.points));
  } else if (d.tool === "line") {
    const p1 = d.points[0], p2 = d.points[d.points.length - 1];
    el.setAttribute("d", `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`);
  } else if (d.tool === "arrow") {
    const p1 = d.points[0], p2 = d.points[d.points.length - 1];
    el.setAttribute("d", arrowPath(p1, p2));
  } else if (d.tool === "box") {
    const p1 = d.points[0], p2 = d.points[d.points.length - 1];
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
    el.setAttribute("x", x); el.setAttribute("y", y);
    el.setAttribute("width", Math.abs(p2.x - p1.x));
    el.setAttribute("height", Math.abs(p2.y - p1.y));
  } else if (d.tool === "circle") {
    const p1 = d.points[0], p2 = d.points[d.points.length - 1];
    el.setAttribute("cx", (p1.x + p2.x) / 2);
    el.setAttribute("cy", (p1.y + p2.y) / 2);
    el.setAttribute("rx", Math.abs(p2.x - p1.x) / 2);
    el.setAttribute("ry", Math.abs(p2.y - p1.y) / 2);
  }
}

function arrowPath(p1, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const head = Math.min(16, len * 0.25);
  const a1x = p2.x - head * Math.cos(ang - Math.PI / 6);
  const a1y = p2.y - head * Math.sin(ang - Math.PI / 6);
  const a2x = p2.x - head * Math.cos(ang + Math.PI / 6);
  const a2y = p2.y - head * Math.sin(ang + Math.PI / 6);
  return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} M ${a1x} ${a1y} L ${p2.x} ${p2.y} L ${a2x} ${a2y}`;
}

function pointsToSvgD(pts) {
  if (!pts.length) return "";
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`;
  }
  return d;
}

function finalizeDrag(d) {
  const overlay = d.overlay, rect = d.rect;
  const dim = editPageDims[d.pageNum - 1];
  const cssW = rect.width, cssH = rect.height;
  const sx = dim.w / cssW, sy = dim.h / cssH;
  const flip = (p) => ({ x: p.x * sx, y: dim.h - p.y * sy });
  const pdfWidth = d.width * sx;

  const idx = pendingAnnotations.length;
  let ann;
  if (d.tool === "pen") {
    ann = { type: "ink", page: d.pageNum, points: d.points.map(flip), color: d.color, width: pdfWidth, idx };
  } else if (d.tool === "line") {
    const [p1, p2] = [d.points[0], d.points.at(-1)];
    ann = { type: "line", page: d.pageNum, p1: flip(p1), p2: flip(p2), color: d.color, width: pdfWidth, idx };
  } else if (d.tool === "arrow") {
    const [p1, p2] = [d.points[0], d.points.at(-1)];
    ann = { type: "arrow", page: d.pageNum, p1: flip(p1), p2: flip(p2), color: d.color, width: pdfWidth, idx };
  } else if (d.tool === "box") {
    const [p1, p2] = [d.points[0], d.points.at(-1)];
    const xCss = Math.min(p1.x, p2.x), yCssTop = Math.min(p1.y, p2.y);
    const wCss = Math.abs(p2.x - p1.x), hCss = Math.abs(p2.y - p1.y);
    const xPdf = xCss * sx;
    const yPdf = dim.h - (yCssTop + hCss) * sy; // bottom-left
    ann = {
      type: "box", page: d.pageNum,
      x: xPdf, y: yPdf, w: wCss * sx, h: hCss * sy,
      color: d.color, width: pdfWidth, idx,
    };
  } else if (d.tool === "circle") {
    const [p1, p2] = [d.points[0], d.points.at(-1)];
    const cxCss = (p1.x + p2.x) / 2, cyCss = (p1.y + p2.y) / 2;
    const rx = Math.abs(p2.x - p1.x) / 2, ry = Math.abs(p2.y - p1.y) / 2;
    ann = {
      type: "circle", page: d.pageNum,
      cx: cxCss * sx, cy: dim.h - cyCss * sy,
      rx: rx * sx, ry: ry * sy,
      color: d.color, width: pdfWidth, idx,
    };
  }
  pendingAnnotations.push(ann);

  const el = d.svgEls[0];
  el.dataset.idx = idx;
  el.classList.add(d.tool === "box" || d.tool === "circle" ? "erasable-fill" : "erasable");
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const i = parseInt(el.dataset.idx, 10);
    if (Number.isNaN(i)) return;
    pendingAnnotations[i] = null;
    d.svgEls.forEach((x) => x.remove());
    updateEditCount();
  });
  updateEditCount();
}

async function saveAndUpload() {
  if (!editMode) return;
  if (!oauthToken?.access_token) return toast("Not signed in.");
  const cur = viewerQueue[viewerIndex];
  if (!cur || !editPdfBytes) return;

  const live = pendingAnnotations.filter(Boolean);
  if (live.length === 0) {
    toast("No changes to save.");
    return;
  }

  toast(`Saving ${live.length} annotation${live.length === 1 ? "" : "s"}…`, 8000);

  try {
    const { PDFDocument, rgb, StandardFonts, PDFName, PDFString, PDFArray, PDFNumber, PDFHexString } = window.PDFLib;
    const pdf = await PDFDocument.load(editPdfBytes);
    const helv = await pdf.embedFont(StandardFonts.Helvetica);

    for (const a of live) {
      const page = pdf.getPage(a.page - 1);
      const { width: pw, height: ph } = page.getSize();
      const c = hexToRgbObj(a.color);
      if (a.type === "text") {
        // Draw the text directly so annotation shows in any viewer (Drive,
        // mobile, print). Re-edit later by adding new pins on top.
        page.drawText(a.text, {
          x: a.x,
          y: a.y - a.size * 0.85, // baseline adjustment
          size: a.size,
          font: helv,
          color: rgb(c.r, c.g, c.b),
        });
      } else if (a.type === "highlight") {
        page.drawRectangle({
          x: a.x,
          y: a.y,
          width: a.w,
          height: a.h,
          color: rgb(c.r, c.g, c.b),
          opacity: 0.35,
        });
      } else if (a.type === "ink") {
        for (let i = 1; i < a.points.length; i++) {
          page.drawLine({
            start: { x: a.points[i - 1].x, y: a.points[i - 1].y },
            end:   { x: a.points[i].x,     y: a.points[i].y     },
            thickness: Math.max(0.8, a.width),
            color: rgb(c.r, c.g, c.b),
            lineCap: window.PDFLib.LineCapStyle.Round,
          });
        }
      } else if (a.type === "line") {
        page.drawLine({
          start: a.p1, end: a.p2,
          thickness: Math.max(0.8, a.width),
          color: rgb(c.r, c.g, c.b),
          lineCap: window.PDFLib.LineCapStyle.Round,
        });
      } else if (a.type === "arrow") {
        page.drawLine({
          start: a.p1, end: a.p2,
          thickness: Math.max(0.8, a.width),
          color: rgb(c.r, c.g, c.b),
          lineCap: window.PDFLib.LineCapStyle.Round,
        });
        const dx = a.p2.x - a.p1.x, dy = a.p2.y - a.p1.y;
        const len = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const head = Math.min(18, len * 0.25);
        const t = Math.max(0.8, a.width);
        const cosA = Math.cos, sinA = Math.sin;
        const a1 = { x: a.p2.x - head * cosA(ang - Math.PI / 6), y: a.p2.y - head * sinA(ang - Math.PI / 6) };
        const a2 = { x: a.p2.x - head * cosA(ang + Math.PI / 6), y: a.p2.y - head * sinA(ang + Math.PI / 6) };
        page.drawLine({ start: a1, end: a.p2, thickness: t, color: rgb(c.r, c.g, c.b), lineCap: window.PDFLib.LineCapStyle.Round });
        page.drawLine({ start: a2, end: a.p2, thickness: t, color: rgb(c.r, c.g, c.b), lineCap: window.PDFLib.LineCapStyle.Round });
      } else if (a.type === "box") {
        page.drawRectangle({
          x: a.x, y: a.y, width: a.w, height: a.h,
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: Math.max(0.8, a.width),
          color: undefined, opacity: 0,
        });
      } else if (a.type === "circle") {
        page.drawEllipse({
          x: a.cx, y: a.cy,
          xScale: Math.max(1, a.rx), yScale: Math.max(1, a.ry),
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: Math.max(0.8, a.width),
          color: undefined, opacity: 0,
        });
      }
    }

    const out = await pdf.save();
    await uploadPdfBytes(cur.file.id, out);
    toast(`Saved ✓ ${cur.name}`);

    // Switch back to view mode (Drive iframe will fetch the updated file)
    pendingAnnotations = [];
    exitEditUi();
    await new Promise((r) => setTimeout(r, 600)); // give Drive a moment
    await showInIframe(cur.file);
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${e.message}`);
  }
}

function hexToRgbObj(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ────────────────────────────────────────────────
// PLAYLIST editor
// ────────────────────────────────────────────────
async function ensurePlaylistsFolder() {
  if (plSubfolderId) return plSubfolderId;
  if (!oauthToken?.access_token) {
    toast("Sign in to create the playlists folder.");
    return null;
  }
  toast("Creating playlists folder…");
  const f = await createSubfolder(cfg.DRIVE_FOLDER_ID, cfg.PLAYLISTS_FOLDER_NAME);
  plSubfolderId = f.id;
  return plSubfolderId;
}

async function openNewPlaylist() {
  if (!oauthToken?.access_token) return toast("Sign in first.");
  const id = await ensurePlaylistsFolder();
  if (!id) return;
  const today = new Date().toISOString().slice(0, 10);
  openPlaylistEditor({
    date: today,
    title: "Sunday Service",
    notes: "",
    songs: [],
  });
}

function openPlaylistEditor(p) {
  plEditing = JSON.parse(JSON.stringify(p));
  $("pl-date").value = plEditing.date || "";
  $("pl-title").value = plEditing.title || "";
  $("pl-notes").value = plEditing.notes || "";
  $("pl-delete").classList.toggle("hidden", !plEditing.id);
  renderPlSongs();
  $("pl-editor").classList.remove("hidden");
}

function renderPlSongs() {
  const ul = $("pl-songs-list");
  ul.innerHTML = "";
  (plEditing.songs || []).forEach((title, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="num">${idx + 1}.</span>
      <span class="title">${escape(title)}</span>
      <span class="move" data-up="${idx}" title="Up">↑</span>
      <span class="move" data-down="${idx}" title="Down">↓</span>
      <span class="x" data-rm="${idx}" title="Remove">✕</span>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll("[data-up]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = +b.dataset.up;
      if (i > 0) {
        [plEditing.songs[i - 1], plEditing.songs[i]] = [plEditing.songs[i], plEditing.songs[i - 1]];
        renderPlSongs();
      }
    })
  );
  ul.querySelectorAll("[data-down]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = +b.dataset.down;
      if (i < plEditing.songs.length - 1) {
        [plEditing.songs[i + 1], plEditing.songs[i]] = [plEditing.songs[i], plEditing.songs[i + 1]];
        renderPlSongs();
      }
    })
  );
  ul.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = +b.dataset.rm;
      plEditing.songs.splice(i, 1);
      renderPlSongs();
    })
  );
}

function renderPlSuggest(query) {
  const wrap = $("pl-song-suggest");
  const q = query.toLowerCase().trim();
  if (!q) {
    wrap.classList.remove("open");
    wrap.innerHTML = "";
    return;
  }
  const matches = libFiles
    .filter((f) => f.name.toLowerCase().includes(q))
    .slice(0, 12);
  if (matches.length === 0) {
    wrap.classList.remove("open");
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = matches
    .map((f) => `<div class="item" data-title="${escape(stem(f.name))}">${escape(stem(f.name))}</div>`)
    .join("");
  wrap.classList.add("open");
  wrap.querySelectorAll(".item").forEach((it) =>
    it.addEventListener("click", () => {
      plEditing.songs = plEditing.songs || [];
      plEditing.songs.push(it.dataset.title);
      $("pl-song-search").value = "";
      wrap.classList.remove("open");
      renderPlSongs();
    })
  );
}

async function savePlaylist() {
  if (!oauthToken?.access_token) return toast("Sign in first.");
  const id = await ensurePlaylistsFolder();
  if (!id) return;
  plEditing.date = $("pl-date").value;
  plEditing.title = $("pl-title").value || "Sunday Service";
  plEditing.notes = $("pl-notes").value || "";

  if (!plEditing.date) return toast("Pick a date.");
  const filename = `${plEditing.date}.json`;
  const payload = {
    date: plEditing.date,
    title: plEditing.title,
    notes: plEditing.notes,
    songs: plEditing.songs || [],
  };

  toast("Saving playlist…");
  try {
    const res = await uploadJson(id, filename, payload, plEditing.id || null);
    toast(`Playlist saved ✓ ${plEditing.date}`);
    $("pl-editor").classList.add("hidden");
    plEditing = null;
    await loadPlaylists();
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${e.message}`);
  }
}

async function deletePlaylist() {
  if (!plEditing?.id) return;
  if (!confirm("Delete this playlist?")) return;
  try {
    await deleteDriveFile(plEditing.id);
    toast("Playlist deleted");
    $("pl-editor").classList.add("hidden");
    plEditing = null;
    await loadPlaylists();
  } catch (e) {
    toast(`Delete failed: ${e.message}`);
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
$("viewer-close").addEventListener("click", () => {
  $("viewer").classList.add("hidden");
  exitEditUi();
});
$("viewer-prev").addEventListener("click", async () => {
  if (viewerIndex > 0) { viewerIndex--; await showCurrent(); }
});
$("viewer-next").addEventListener("click", async () => {
  if (viewerIndex < viewerQueue.length - 1) { viewerIndex++; await showCurrent(); }
});
$("viewer-edit").addEventListener("click", enterEditMode);
$("viewer-cancel").addEventListener("click", () => exitEditMode());
$("viewer-save").addEventListener("click", saveAndUpload);

document.querySelectorAll(".edit-tool").forEach((b) =>
  b.addEventListener("click", () => {
    activeTool = b.dataset.tool;
    document.querySelectorAll(".edit-tool").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".edit-overlay").forEach((o) => {
      o.classList.toggle("drag-mode", DRAG_TOOLS.has(activeTool) || activeTool === "eraser");
      o.classList.toggle("eraser-mode", activeTool === "eraser");
    });
  })
);

document.querySelectorAll(".color-chip").forEach((c) => {
  c.addEventListener("click", () => {
    const v = c.dataset.color;
    $("edit-color").value = v;
    document.querySelectorAll(".color-chip").forEach((x) => x.classList.toggle("active", x === c));
  });
});
$("edit-color").addEventListener("input", () => {
  document.querySelectorAll(".color-chip").forEach((x) => x.classList.remove("active"));
});

document.querySelectorAll(".size-chip").forEach((c) => {
  c.addEventListener("click", () => {
    $("edit-fontsize").value = c.dataset.size;
    document.querySelectorAll(".size-chip").forEach((x) => x.classList.toggle("active", x === c));
  });
});
$("edit-fontsize").addEventListener("input", () => {
  document.querySelectorAll(".size-chip").forEach((x) => x.classList.remove("active"));
});
$("edit-undo").addEventListener("click", () => {
  for (let i = pendingAnnotations.length - 1; i >= 0; i--) {
    if (pendingAnnotations[i]) {
      pendingAnnotations[i] = null;
      document.querySelectorAll(
        ".annotation-pin, .edit-overlay > div, .edit-overlay svg path, .edit-overlay svg rect, .edit-overlay svg ellipse"
      ).forEach((el) => {
        if (parseInt(el.dataset.idx, 10) === i) el.remove();
      });
      updateEditCount();
      return;
    }
  }
});

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

$("new-playlist-btn").addEventListener("click", openNewPlaylist);
$("pl-close").addEventListener("click", () => {
  $("pl-editor").classList.add("hidden");
  plEditing = null;
});
$("pl-save").addEventListener("click", savePlaylist);
$("pl-delete").addEventListener("click", deletePlaylist);
$("pl-song-search").addEventListener("input", (e) => renderPlSuggest(e.target.value));

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────
function stem(name) { return name.replace(/\.[^.]+$/, ""); }
function escape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  $("lib-grid").innerHTML = `
    <div class="empty">
      <div class="icon">⚙️</div>
      <strong>One-time setup needed.</strong>
      <pre>DRIVE_FOLDER_ID, API_KEY, OAUTH_CLIENT_ID</pre>
    </div>`;
  $("playlist-list").innerHTML = "";
}

init();

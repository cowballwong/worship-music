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
let pendingAnnotations = [];    // {page, x, y, text, color, size, type:'text'|'highlight'}
let activeTool = "text";

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
      overlay.addEventListener("click", (e) => onOverlayTap(e, i));
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
  const overlay = e.currentTarget;
  const rect = overlay.getBoundingClientRect();
  const tapX = e.clientX - rect.left;
  const tapY = e.clientY - rect.top;

  const dim = editPageDims[pageNum - 1];
  // Convert from displayed (CSS) coords to PDF points
  const cssW = rect.width;
  const cssH = rect.height;
  const pdfX = (tapX / cssW) * dim.w;
  const pdfYTop = (tapY / cssH) * dim.h;
  const pdfY = dim.h - pdfYTop; // PDF origin is bottom-left

  if (activeTool === "text") {
    const text = prompt("Annotation text 文字 (e.g. Capo 4)", "");
    if (!text || !text.trim()) return;
    const color = $("edit-color").value;
    const size = parseInt($("edit-fontsize").value, 10) || 14;
    pendingAnnotations.push({
      type: "text",
      page: pageNum,
      x: pdfX,
      y: pdfY,
      text: text.trim(),
      color,
      size,
    });
    addPinDom(overlay, tapX, tapY, text.trim(), color, size, pendingAnnotations.length - 1);
  } else if (activeTool === "highlight") {
    const w_pdf = 80, h_pdf = 16; // small default rect
    pendingAnnotations.push({
      type: "highlight",
      page: pageNum,
      x: pdfX,
      y: pdfY - h_pdf, // y is bottom edge for highlight
      w: w_pdf,
      h: h_pdf,
      color: $("edit-color").value,
    });
    addHighlightDom(overlay, tapX, tapY, $("edit-color").value, pendingAnnotations.length - 1);
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
  })
);
$("edit-undo").addEventListener("click", () => {
  // remove last live annotation
  for (let i = pendingAnnotations.length - 1; i >= 0; i--) {
    if (pendingAnnotations[i]) {
      pendingAnnotations[i] = null;
      // remove the corresponding pin DOM
      document.querySelectorAll(".annotation-pin, .edit-overlay > div").forEach((el) => {
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

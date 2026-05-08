# Worship Music

Personal worship music sheet library — Drive-backed, mobile-first, with edit + save annotations.

**Live**: https://cowballwong.github.io/worship-music/

## How it works

- **Library** (`📚`) — every song PDF in your Drive `01_Lib/` folder, searchable.
- **Playlists** (`📅`) — Sunday set lists stored as JSON in a `playlists/` folder. Tapping a playlist plays its songs in sequence (no real combined PDF — single source of truth lives in `01_Lib/`).
- **Edit + Save** (Phase 2) — sign in with Google to add chord notes, capo markings, highlights. Annotations save back into the PDF as standard PDF annotation objects, so you can re-edit them next time.

## One-time setup

You need to fill in `config.js` with three things from your Google Cloud account.

### 1. Drive folder ID

1. Open your `Sunday guitar` folder in Google Drive.
2. Make sure sharing is "Anyone with the link can view".
3. Copy the folder ID from the URL: `https://drive.google.com/drive/folders/<THIS_PART>`
4. Paste into `DRIVE_FOLDER_ID` in `config.js`.

### 2. API key (read-only, Phase 1)

1. Go to https://console.cloud.google.com/
2. Create a project (or reuse an existing one).
3. Enable the **Google Drive API**: APIs & Services → Library → "Google Drive API" → Enable.
4. Credentials → Create credentials → API key. Copy it.
5. (Recommended) Restrict the key: Application restrictions → HTTP referrers → add `https://cowballwong.github.io/*`. API restrictions → Google Drive API only.
6. Paste into `API_KEY` in `config.js`.

### 3. OAuth Client ID (write, Phase 2 — needed for edit/save)

1. Same Cloud project → Credentials → Create credentials → OAuth client ID.
2. Application type: Web application.
3. Authorised JavaScript origins: `https://cowballwong.github.io`
4. Copy the client ID (`...apps.googleusercontent.com`).
5. Paste into `OAUTH_CLIENT_ID` in `config.js`.

## Playlist JSON format

A `playlists/2026-05-10.json` file in Drive looks like:

```json
{
  "date": "2026-05-10",
  "title": "Sunday Service — Pharisee + Tax Collector",
  "songs": [
    "Come, People of the Risen King (Easy Piano)",
    "Come, People of the Risen King",
    "All Through History",
    "426 How Deep the Father's Love For Us",
    "There Is One Gospel"
  ],
  "notes": "Amanda's set list"
}
```

`songs` are matched against PDF filenames in `01_Lib/` (without `.pdf` extension).

## Development

It's a static site — open `index.html` directly, or:

```
python -m http.server 8000
# then visit http://localhost:8000
```

No build step. PDF.js loaded from CDN.

## Roadmap

- Phase 1: read-only viewer ✅
- Phase 2: Google OAuth + PDF.js annotation editor + save back to Drive
- Phase 3: Playlist editor (drag-drop, song-history search)
- Phase 4: Dashboard integration

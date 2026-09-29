# AniNeko TV — watch-only Android-TV-friendly replica

Netflix-style TV interface **with its own built-in player** (no more site iframes
unless you want them), synced **live** to https://aniwaves.ru. No downloads.

## The player (new in 2.0)
- **Own video engine**: embeds are resolved to direct HLS on the fly
  (HD-1/StreamHG/Earnvids unpackers + hotlink verification — dead/ad-poisoned
  servers are auto-skipped), with the old site player kept as a fallback button
- **Browser (PC)**: custom Netflix-style HTML5 player — play/pause, ±10s seek bar,
  SUB/DUB/HARDSUB audio, subtitle track picker (real VTT), 0.5–2x speed,
  Auto/720p/1080p quality, server menu, prev/next episode, auto-next countdown,
  resume-everything, fullscreen — all D-pad driven
- **Android TV APK**: native ExoPlayer screen — same direct streams (no CORS
  limits), video starts instantly with Arabic joining in the background,
  styled VTT subtitles with CC toggle, speed/audio/server/quality pick-lists,
  ±10s, episode nav, first-press pause, screen lock, buffering + error cards,
  position reported back to Continue Watching
- Every option opens a **pick-list** (servers, audio, subtitles, speed,
  quality) — no tap-to-cycle; remote arrows + OK all the way
- **Arabic subtitles**: English tracks are auto-translated to العربية on the
  fly (cached on disk/server, works on DUB too by borrowing SUB timings)
- Crunchyroll-style series pages, cinematic home hero, **My List** menu,
  "Moemen TV" branding, Top-10 rank rows
- **Display size setting** (⚙ in the top bar): 80–125% UI zoom, remembered
- Dead **HD-1 servers are hidden** everywhere — the player skips straight to
  working ones

## Mobile downloads (phone shell only)
- Every episode row has a ⤓ button (hidden on TV): tap → chooser window with
  **audio (SUB/DUB/HSUB)** + **quality** (with size estimates, Best = highest)
- Download runs natively in the background with notification progress into
  `Downloads/MoemenTV/` as a playable `.ts` + `.srt` subtitles (EN + AR source
  included where available); tap the finished notification to play
- In a plain mobile browser the same button downloads via the proxy instead

## How live sync works
- `server.js` scrapes aniwaves.ru server-side (home / filter / anime / episode / schedule) with cheerio and exposes JSON:
  - `GET /api/home` — spotlight, featured, trending, latest
  - `GET /api/browse?genre[]=&sort=&page=` — library (via `/filter`)
  - `GET /api/search?q=` — search (via `/filter`)
  - `GET /api/anime/:slug` — details + episodes (via `ajax/episode/list`)
  - `GET /api/watch/:slug/:ep` — SUB/DUB/S-SUB servers (via `ajax/server/list`)
  - `GET /api/schedule` — recent releases (via `/updated`)
- 5-minute polite cache + `?refresh=1` bypass. Frontend auto-refreshes every 10 min + manual ⟳ / F5.
- Video resolves via echovideo embeds (`Vidplay`, `DatSaV`, `MyCloud`, …):
  `ajax/sources` → embed page → `getSources` → direct MP4 qualities or full-HD
  HLS — always current, no stored links. No subtitle tracks are published.

## Run (PC test)
```bat
npm install
npm start
```
Open http://localhost:3000 — use arrow keys + Enter like a TV remote. Esc = back.

## Use on Android TV
Option A (fastest, no build): on the TV browser open `http://YOUR-PC-IP:3000`, or install "TV Bro" browser.
Option B (APK wrapper): wrap this web app with Capacitor / Trusted Web Activity:
1. `npm i -g @capacitor/cli`, `npx cap init`, add `@capacitor/android`
2. Point `webDir` to `public`, `server.url` to your deployed proxy URL
3. `npx cap add android`, open in Android Studio, build Leanback APK

Deploy the proxy (Render/Fly/VPS) so the TV always hits fresh aniwaves.ru data.

## Install builds (two separate APKs)
- **`anineko-tv.apk`** (`com.moemen.tv`) — Android TV only: landscape remote UI,
  watch-only, no download buttons
- **`anineko-mobile.apk`** (`com.moemen.tv.mobile`) — phones only: portrait
  touch UI + **episode downloads**

Install (pick one per device):
- USB stick: copy the APK, open with a file manager
- Send Files to TV / phone file app, then open the APK
- PC + ADB: `adb connect DEVICE_IP` then `adb install anineko-tv.apk`

Notes: the APK is fully standalone (no PC needed) — its native bridge scrapes
aniwaves.ru live on-device. Rebuild after web changes with:
```bat
cd android
xcopy /E /Y ..\public app\src\main\assets\www\
C:\gradle-8.9\bin\gradle.bat assembleDebug
copy app\build\outputs\apk\debug\app-debug.apk ..\anineko-tv.apk
```

## TV remote map
- Arrows = move focus (orange outline + zoom)
- OK/Enter = select, Esc/Backspace = back, F5/⟳ = live refresh
- Player: SUB/DUB/HARD SUB tabs + numbered server buttons (1: HD-1, 2: StreamHG…)
  — video can never trap focus, so arrows always work; **S** = next server,
  **L** = switch language, with a "Server X/Y" indicator + toast on every switch
- Continue Watching + My List stored on-device (localStorage)

## Legal note
Streams belong to aniwaves.ru / third-party hosts. This is a personal-use front-end. Respect the site's ToS and local law.

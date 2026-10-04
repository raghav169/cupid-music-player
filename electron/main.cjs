require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen, shell, net, Tray, Menu, nativeImage } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const http = require('node:http');
const os = require('node:os');

const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const execFileAsync = promisify(execFile);

// CORS for loopback media responses — the renderer origin (vite dev server or
// file://) is cross-origin from http://127.0.0.1:<port>, and Web Audio's
// MediaElementSource requires CORS-clean media.
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

// Insertion-ordered eviction so stream/video caches can't grow unbounded.
function cacheSetBounded(map, key, value, max = 500) {
  if (!map.has(key) && map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
}

// ── Loopback media server ───────────────────────────────
// Chromium refuses CORS-enabled requests to custom schemes, and the Web
// Audio graph (EQ/visualizer) requires CORS-clean media — <audio> uses
// crossOrigin='anonymous'. Serving audio over http://127.0.0.1 is CORS-legal,
// so local files and proxied YouTube streams go through this server.
const mediaServer = http.createServer();
let mediaServerPort = null;

function mediaBase() {
  if (!mediaServerPort) throw new Error('media server not ready');
  return `http://127.0.0.1:${mediaServerPort}`;
}

const MEDIA_MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// /local/<file> — files under userAudioDir() only, with Range support.
async function serveLocalMedia(u, req, res, cors) {
  const filename = decodeURIComponent(u.pathname.slice('/local/'.length));
  const root = userAudioDir();
  const filePath = path.resolve(root, filename);
  const inside = filePath === root || filePath.startsWith(root + path.sep);
  if (!filename || !inside || filename.includes('..') || filename.includes('\\')) {
    res.writeHead(403, cors);
    res.end('forbidden');
    return;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    const total = stat.size;
    const range = req.headers.range;
    const contentType = MEDIA_MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';

    const pipeFile = (opts) => {
      const s = fs.createReadStream(filePath, opts);
      s.on('error', () => res.destroy());
      s.pipe(res);
    };

    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const suffix = /^bytes=-(\d+)$/.exec(range);
      if (!match && !suffix) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, ...cors });
        res.end();
        return;
      }
      const start = match ? parseInt(match[1], 10) : Math.max(0, total - parseInt(suffix[1], 10));
      const end = match && match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, ...cors });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
        ...cors,
      });
      pipeFile({ start, end });
      return;
    }

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total),
      'Content-Type': contentType,
      ...cors,
    });
    pipeFile();
  } catch (err) {
    console.error('[media local]', err.message);
    res.writeHead(404, cors);
    res.end('not found');
  }
}

// /stream?id=<videoId> — resolve via yt-dlp cache, then proxy the YouTube
// URL with the headers it requires (Origin/Referer/UA), forwarding Range.
async function serveStreamMedia(u, req, res, cors) {
  const id = u.searchParams.get('id');
  if (!id || !YT_ID_RE.test(id)) {
    res.writeHead(400, cors);
    res.end('missing id');
    return;
  }
  try {
    const streamUrl = await resolveStreamUrl(id);
    const headers = {
      Origin: 'https://www.youtube.com',
      Referer: 'https://www.youtube.com/',
      'User-Agent': 'Mozilla/5.0',
    };
    if (req.headers.range) headers.Range = req.headers.range;
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort()); // client left — stop upstream download
    const upstream = await net.fetch(streamUrl, { headers, signal: ctrl.signal });
    const pass = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) pass[h] = v;
    }
    // bestaudio isn't always m4a (e.g. webm/opus) — pass the real type through
    if (!pass['content-type']) pass['content-type'] = 'audio/mp4';
    res.writeHead(upstream.status, { ...pass, ...cors });
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    console.error('[media stream]', err.message);
    res.writeHead(502, cors);
    res.end('failed');
  }
}

mediaServer.on('request', async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      });
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, cors);
      res.end();
      return;
    }
    if (u.pathname === '/stream') {
      await serveStreamMedia(u, req, res, cors);
      return;
    }
    if (u.pathname.startsWith('/local/')) {
      await serveLocalMedia(u, req, res, cors);
      return;
    }
    res.writeHead(404, cors);
    res.end('not found');
  } catch (err) {
    console.error('[media]', err.message);
    if (!res.headersSent) res.writeHead(500, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  }
});

function startMediaServer() {
  return new Promise((resolve, reject) => {
    mediaServer.once('error', reject);
    // Port 0 → OS picks a free one; loopback only.
    mediaServer.listen(0, '127.0.0.1', () => {
      mediaServerPort = mediaServer.address().port;
      mediaServer.removeListener('error', reject);
      resolve();
    });
  });
}

// ── Apple Music developer token ──────────────────────────
let appleMusicToken = null;
let appleMusicTokenExpiry = 0;

// Packaged builds have no project .env — fall back to one in userData so
// users can drop APPLE_TEAM_ID/APPLE_KEY_ID next to their .p8 key.
let userDataEnvLoaded = false;
function loadUserDataEnv() {
  if (userDataEnvLoaded) return;
  userDataEnvLoaded = true;
  try {
    const envPath = path.join(app.getPath('userData'), '.env');
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath, override: false });
    }
  } catch {
    // no userData env — fine
  }
}

// .p8 lives in the project root in dev; in packaged builds users drop it
// into userData (e.g. %APPDATA%\Cupid Player\).
function findAppleP8Key() {
  const dirs = [path.join(__dirname, '..'), app.getPath('userData')];
  for (const dir of dirs) {
    try {
      const keyFile = fs.readdirSync(dir).find((f) => f.endsWith('.p8'));
      if (keyFile) return fs.readFileSync(path.join(dir, keyFile), 'utf8');
    } catch {
      // dir unreadable — try next
    }
  }
  return null;
}

function generateAppleMusicToken() {
  if (appleMusicToken && Date.now() < appleMusicTokenExpiry) {
    return appleMusicToken;
  }

  loadUserDataEnv();

  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;

  if (!teamId || !keyId) return null;

  const privateKey = findAppleP8Key();
  if (!privateKey) return null;

  appleMusicToken = jwt.sign({}, privateKey, {
    algorithm: 'ES256',
    expiresIn: '180d',
    issuer: teamId,
    header: {
      alg: 'ES256',
      kid: keyId,
    },
  });

  // Cache for 179 days
  appleMusicTokenExpiry = Date.now() + 179 * 24 * 60 * 60 * 1000;
  return appleMusicToken;
}

// ── yt-dlp stream URL fetcher ────────────────────────────
// streamCache: stream URLs (expire after ~30min on YT's side)
// videoIdCache: title → video ID, persisted so repeat lookups skip search
const streamCache = new Map();
const pendingRequests = new Map();
const videoIdCache = new Map();
const CACHE_TTL = 25 * 60 * 1000;

let videoIdCacheLoaded = false;
let videoIdCacheFile = null;
let videoIdSaveTimer = null;

function loadVideoIdCache() {
  if (videoIdCacheLoaded) return;
  videoIdCacheLoaded = true;
  try {
    videoIdCacheFile = path.join(app.getPath('userData'), 'video-id-cache.json');
    const raw = fs.readFileSync(videoIdCacheFile, 'utf8');
    for (const [k, v] of Object.entries(JSON.parse(raw))) videoIdCache.set(k, v);
  } catch {
    // no cache file yet
  }
}

function persistVideoIdCache() {
  if (!videoIdCacheFile) return;
  clearTimeout(videoIdSaveTimer);
  videoIdSaveTimer = setTimeout(() => {
    const obj = Object.fromEntries(videoIdCache);
    fs.promises.writeFile(videoIdCacheFile, JSON.stringify(obj)).catch(() => {});
  }, 500);
}

// yt-dlp resolution order:
//   1. Standalone binary downloaded by scripts/install-yt-dlp.cjs into ./bin —
//      single-file native binary, no Python dependency.
//   2. In packaged builds, the same binary shipped via extraResources.
//   3. Last resort: `yt-dlp` on $PATH (lets advanced users override).
//
// We intentionally don't fall back to yt-dlp-exec's bundled Python zipapp:
// it breaks on systems whose default python3 is < 3.10 (e.g. macOS w/ Xcode's
// Python 3.9), and the standalone binary is the supported path.
let cachedYtDlpPath = null;
function getYtDlpPath() {
  if (cachedYtDlpPath) return cachedYtDlpPath;

  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

  const candidates = [
    // Dev / cloned-from-source: scripts/install-yt-dlp.cjs drops it here
    path.join(__dirname, '..', 'bin', binName),
    // Packaged app: extraResources places it under resourcesPath/bin/
    path.join(process.resourcesPath || '', 'bin', binName),
  ];

  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) {
        cachedYtDlpPath = p;
        return p;
      }
    } catch {}
  }

  // Fall back to whatever `yt-dlp` (or `yt-dlp.exe`) resolves to on $PATH —
  // execFile on Windows needs the explicit extension.
  cachedYtDlpPath = binName;
  return cachedYtDlpPath;
}

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// youtubei.js handles YT Music search (audio uploads, not music videos).
// URL extraction stays on yt-dlp — YT now withholds stream URLs from WEB
// client responses without a PoToken, which youtubei.js can't generate.
let innertubePromise = null;
function getInnertube() {
  if (innertubePromise) return innertubePromise;
  innertubePromise = (async () => {
    const { Innertube, UniversalCache } = await import('youtubei.js');
    return Innertube.create({
      cache: new UniversalCache(true, path.join(app.getPath('userData'), 'innertube-cache')),
      generate_session_locally: true,
    });
  })().catch((err) => {
    innertubePromise = null;
    throw err;
  });
  return innertubePromise;
}

async function searchYouTubeMusic(title, artist) {
  const yt = await getInnertube();
  const search = await yt.music.search(`${title} ${artist}`, { type: 'song' });

  let top = search.songs?.contents?.find((c) => c?.id);
  if (!top) {
    for (const shelf of search.contents || []) {
      const item = shelf?.contents?.find?.((c) => c?.id);
      if (item) { top = item; break; }
    }
  }
  if (!top?.id) throw new Error('No song result');
  return top.id;
}

async function ytDlpExtract(target) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    target,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '-g',
  ], { timeout: 15000 });
  return stdout.trim();
}

async function ytDlpSearch(title, artist) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    `ytsearch1:"${title}" ${artist}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--print', '%(id)s',
    '-g',
  ], { timeout: 15000 });
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const id = lines.find((l) => YT_ID_RE.test(l));
  const url = lines.find((l) => l.startsWith('http'));
  if (!id || !url) throw new Error('yt-dlp search returned no usable result');
  return { id, url };
}

// videoId → { url, time }. yt-dlp URLs last ~30min — same TTL as streamCache
const decipheredCache = new Map();
const pendingDecipher = new Map();

async function resolveStreamUrl(videoId) {
  const cached = decipheredCache.get(videoId);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingDecipher.get(videoId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const url = await ytDlpExtract(`https://www.youtube.com/watch?v=${videoId}`);
      cacheSetBounded(decipheredCache, videoId, { url, time: Date.now() });
      return url;
    } finally {
      pendingDecipher.delete(videoId);
    }
  })();

  pendingDecipher.set(videoId, promise);
  return promise;
}

async function getStreamUrl(title, artist) {
  const cacheKey = `${title}::${artist}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.url;

  const inflight = pendingRequests.get(cacheKey);
  if (inflight) return inflight;

  loadVideoIdCache();
  let videoId = videoIdCache.get(cacheKey);

  const promise = (async () => {
    try {
      if (!videoId) {
        try {
          videoId = await searchYouTubeMusic(title, artist);
        } catch (err) {
          console.warn('[youtubei search] fallback to yt-dlp:', err.message);
          const result = await ytDlpSearch(title, artist);
          videoId = result.id;
          // We already have a usable URL from yt-dlp — seed the decipher cache
          cacheSetBounded(decipheredCache, videoId, { url: result.url, time: Date.now() });
        }
        cacheSetBounded(videoIdCache, cacheKey, videoId, 2000);
        persistVideoIdCache();
      }

      // Best-effort pre-warm so the renderer's media request hits the decipher cache
      resolveStreamUrl(videoId).catch(() => {});

      const url = `${mediaBase()}/stream?id=${encodeURIComponent(videoId)}`;
      cacheSetBounded(streamCache, cacheKey, { url, time: Date.now() });
      return url;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, promise);
  return promise;
}

// Direct stream URL for a known YouTube video ID — skips the search step
// used by Spotify/Apple. Best-effort pre-warms the decipher cache.
function streamUrlForVideoId(videoId) {
  if (!YT_ID_RE.test(videoId)) throw new Error('Invalid YouTube video ID');
  resolveStreamUrl(videoId).catch(() => {});
  return `${mediaBase()}/stream?id=${encodeURIComponent(videoId)}`;
}

// Fetch a public/unlisted YouTube playlist via yt-dlp --flat-playlist.
// Returns an array of { videoId, title, artist, duration } — no API key
// or sign-in required.
async function fetchYouTubePlaylistViaYtDlp(url) {
  const { stdout } = await execFileAsync(getYtDlpPath(), [
    url,
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
  ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });

  const data = JSON.parse(stdout);
  const entries = data.entries || [];
  return entries
    .filter((e) => e && e.id && YT_ID_RE.test(e.id))
    .map((e) => ({
      videoId: e.id,
      title: e.title || e.id,
      artist: e.uploader || e.channel || '',
      duration: typeof e.duration === 'number' ? e.duration : null,
    }));
}

const isDev = process.env.NODE_ENV === 'development';

// ── Windows integration (tray, taskbar thumbnail toolbar, progress) ──
// All transport clicks are forwarded to the renderer as 'media-command'
// events — it owns the real semantics (room guests forward, etc.).
let tray = null;
let updateThumbar = null;
let lastPlaybackState = { isPlaying: false };

function sendMediaCommand(op) {
  BrowserWindow.getAllWindows()[0]?.webContents.send('media-command', op);
}

// Renderer pushes { isPlaying, title, progress } here; we mirror it onto
// the taskbar thumbnail toolbar, taskbar progress bar, and tray tooltip.
ipcMain.on('playback-state', (_e, s) => {
  if (!s || typeof s !== 'object') return;
  lastPlaybackState = s;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (updateThumbar) updateThumbar(!!s.isPlaying);
  const p = typeof s.progress === 'number' && Number.isFinite(s.progress) && s.progress >= 0
    ? Math.min(1, s.progress) : -1;
  win.setProgressBar(s.isPlaying ? p : -1);
  if (tray) tray.setToolTip(s.title ? `cupid — ${s.title}` : 'cupid player');
});

// ── Local audio library (user-editable playlist + mp3s) ───
// In dev: read/write directly from the project's audio/ folder so edits
// during development are picked up without a seeding dance.
// In prod: bundled audio/ ships via extraResources to process.resourcesPath;
// on first launch we copy it to userData so users can add/edit freely.
function bundledAudioDir() {
  return path.join(process.resourcesPath, 'audio');
}

function userAudioDir() {
  return isDev
    ? path.join(__dirname, '..', 'audio')
    : path.join(app.getPath('userData'), 'audio');
}

function userPlaylistFile() {
  return path.join(userAudioDir(), 'playlist.json');
}

async function seedUserAudioDirIfMissing() {
  if (isDev) return;
  const src = bundledAudioDir();
  const dest = userAudioDir();
  try {
    // Fill in files that don't exist yet — never overwrites user edits.
    // Recursive so subdirectories like `song photos/` (album art) seed too.
    await fs.promises.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
  } catch (err) {
    console.warn('[seed audio]', err.message);
  }
}

// Scale factor for pixel art
// Actual drawing area within 526x526 canvas: 306x497
// (23px top at bow, 110px left, 110px right, 6px bottom at heart)
const WIDTH = 415;
const HEIGHT = Math.round(415 * (497 / 306)); // maintain 306:497 aspect ratio

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Taskbar thumbnail toolbar — Windows only; icon PNGs are the pink set
  // (thumbnail buttons are tiny, the theme difference doesn't read).
  if (process.platform === 'win32') {
    const icon = (n) => nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'pink', n));
    const build = (isPlaying) => {
      if (win.isDestroyed()) return;
      win.setThumbarButtons([
        { tooltip: 'previous', icon: icon('backwards_button.png'), click: () => sendMediaCommand('prev') },
        { tooltip: isPlaying ? 'pause' : 'play', icon: icon(isPlaying ? 'pause_button.png' : 'play_button.png'), click: () => sendMediaCommand('toggle') },
        { tooltip: 'next', icon: icon('forwards_button.png'), click: () => sendMediaCommand('next') },
      ]);
    };
    build(lastPlaybackState.isPlaying);
    updateThumbar = build;
    win.on('closed', () => { updateThumbar = null; });
  }

  // Lock aspect ratio so only proportional resizing is allowed
  const ASPECT = WIDTH / HEIGHT;
  win.setAspectRatio(ASPECT);

  // Window control handlers
  let preMaxBounds = null;

  // Two window modes: 'compact' (aspect-locked floating player) and 'full'
  // (fullscreen; renderer re-lays-out as a centered full-height column).
  let isFullMode = false;
  let compactBounds = null;

  const onToggleMode = () => {
    if (win.isDestroyed()) return;
    if (!isFullMode) {
      compactBounds = win.getBounds();
      win.setAspectRatio(0); // clear lock so fullscreen can go landscape
      win.setFullScreen(true);
      isFullMode = true;
    } else {
      win.setFullScreen(false);
      win.setAspectRatio(ASPECT);
      if (compactBounds) win.setBounds(compactBounds);
      isFullMode = false;
    }
    win.webContents.send('window-mode-changed', isFullMode ? 'full' : 'compact');
  };

  const onMinimize = () => win.minimize();
  const onMaximize = () => {
    if (preMaxBounds) {
      // Restore to previous size
      win.setBounds(preMaxBounds);
      preMaxBounds = null;
    } else {
      // Fit to screen while maintaining aspect ratio
      preMaxBounds = win.getBounds();
      const { workArea } = screen.getPrimaryDisplay();
      let newWidth = workArea.width;
      let newHeight = Math.round(newWidth / ASPECT);
      if (newHeight > workArea.height) {
        newHeight = workArea.height;
        newWidth = Math.round(newHeight * ASPECT);
      }
      const x = workArea.x + Math.round((workArea.width - newWidth) / 2);
      const y = workArea.y + Math.round((workArea.height - newHeight) / 2);
      win.setBounds({ x, y, width: newWidth, height: newHeight });
    }
  };
  const onClose = () => win.close();

  const onResize = (_e, data) => {
    if (win.isDestroyed() || isFullMode) return;
    const { dx, dy, corner } = data || {};
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || typeof corner !== 'string') return;
    const bounds = win.getBounds();

    const isRight = corner.includes('right');
    const isBottom = corner.includes('bottom');

    const effectiveDx = isRight ? dx : -dx;
    const effectiveDy = isBottom ? dy : -dy;

    let delta;
    if (Math.abs(effectiveDx) > Math.abs(effectiveDy)) {
      delta = effectiveDx;
    } else {
      delta = effectiveDy;
    }

    const dw = Math.round(delta);
    const newWidth = bounds.width + dw;
    const newHeight = Math.round(newWidth / ASPECT);
    const dh = newHeight - bounds.height;

    const newBounds = {
      x: isRight ? bounds.x : bounds.x - dw,
      y: isBottom ? bounds.y : bounds.y - dh,
      width: newWidth,
      height: newHeight,
    };

    if (newBounds.width >= 200 && newBounds.height >= 200) {
      win.setBounds(newBounds);
    }
  };

  const onOpenExternal = (_e, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      if (url.includes('accounts.spotify.com/authorize')) {
        const authWin = new BrowserWindow({
          width: 500,
          height: 700,
          parent: win,
          modal: true,
          show: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        authWin.loadURL(url).catch(() => { if (!authWin.isDestroyed()) authWin.close(); });
        const handleAuthRedirect = (event, callbackUrl) => {
          if (callbackUrl.startsWith('http://127.0.0.1:5173/callback')) {
            event.preventDefault();
            const url = new URL(callbackUrl);
            let target;
            if (isDev) {
              target = `http://127.0.0.1:5173/${url.search}`;
            } else {
              const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
              fileUrl.search = url.search;
              target = fileUrl.href;
            }
            if (!win.isDestroyed()) win.loadURL(target).catch(() => {});
            if (!authWin.isDestroyed()) authWin.close();
          }
        };
        authWin.webContents.on('will-redirect', handleAuthRedirect);
        authWin.webContents.on('will-navigate', handleAuthRedirect);
        return;
      }
      shell.openExternal(url).catch(() => {});
    }
  };

  const onSetTheme = (_e, theme) => {
    if (typeof theme !== 'string' || /[/\\]|\.\./.test(theme)) return;
    try {
      let iconPath = path.join(__dirname, '..', 'assets', theme, 'favicon.png');
      // Only pink/blue have real asset dirs — mint/lavender are CSS hue-shifts,
      // so fall back to the pink icon rather than throwing a dialog.
      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, '..', 'assets', 'pink', 'favicon.png');
      }
      if (process.platform === 'darwin' && app.dock) {
        app.dock.setIcon(iconPath);
      }
      win.setIcon(iconPath);
    } catch {
      // Icon theming is cosmetic — never crash the main process over it.
    }
  };

  ipcMain.on('window-minimize', onMinimize);
  ipcMain.on('window-maximize', onMaximize);
  ipcMain.on('window-close', onClose);
  ipcMain.on('window-resize', onResize);
  ipcMain.on('window-toggle-mode', onToggleMode);
  ipcMain.on('open-external', onOpenExternal);
  ipcMain.on('set-theme', onSetTheme);

  // Clean up IPC listeners when window is destroyed
  win.on('closed', () => {
    ipcMain.removeListener('window-minimize', onMinimize);
    ipcMain.removeListener('window-maximize', onMaximize);
    ipcMain.removeListener('window-close', onClose);
    ipcMain.removeListener('window-resize', onResize);
    ipcMain.removeListener('window-toggle-mode', onToggleMode);
    ipcMain.removeListener('open-external', onOpenExternal);
    ipcMain.removeListener('set-theme', onSetTheme);
  });

  // Handle Spotify OAuth callback in production.
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'accounts.spotify.com') {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
        return;
      }
      if (parsed.pathname === '/callback' && parsed.searchParams.has('code')) {
        if (!isDev) {
          event.preventDefault();
          const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html'));
          fileUrl.search = parsed.search;
          if (!win.isDestroyed()) win.loadURL(fileUrl.href).catch(() => {});
        }
      }
    } catch {
      // ignore invalid URLs
    }
  });

  // Toggle DevTools with Cmd+Shift+I / Ctrl+Shift+I / F12 — dev only
  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return;
      const isDevToolsShortcut = input.key.toLowerCase() === 'i' && input.shift && (input.meta || input.control);
      if (isDevToolsShortcut || input.key === 'F12') {
        win.webContents.toggleDevTools({ mode: 'detach' });
      }
    });
  }

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173').catch(() => {});
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch(() => {});
  }
}

// ── Global IPC handlers (persist across window reloads) ──
ipcMain.handle('get-apple-music-token', () => {
  return generateAppleMusicToken();
});

ipcMain.handle('get-stream-url', async (_e, title, artist) => {
  try {
    return await getStreamUrl(title, artist);
  } catch (err) {
    throw new Error(`Failed to get stream: ${err.message}`);
  }
});

ipcMain.handle('get-local-playlist', async () => {
  try {
    const raw = await fs.promises.readFile(userPlaylistFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[playlist.json]', err.message);
    return [];
  }
});

ipcMain.handle('get-local-audio-path', (_e, filename) => {
  if (typeof filename !== 'string' || !filename) return null;
  // Normalize and reject path traversal and absolute paths — filename can be relative subpath
  const normalized = path.normalize(filename);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return null;
  }
  // Convert to forward slashes — path.normalize produces '\' on Windows, which
  // the media server rejects. Served over loopback http so the dev renderer
  // (served over http://) can play it — <audio> won't load file:// cross-origin.
  const posixPath = normalized.split(path.sep).join('/');
  return `${mediaBase()}/local/${encodeURIComponent(posixPath)}`;
});

ipcMain.handle('open-music-folder', async () => {
  const dir = userAudioDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

// Resolve a relative filename inside the audio dir — shared safety check.
function resolveLocalAudioFile(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const normalized = path.normalize(filename);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  const base = isDev ? path.join(__dirname, '..', 'audio') : userAudioDir();
  return path.join(base, normalized);
}

// ── User playlists ────────────────────────────────────────
// Stored as a single JSON object: { "name": [track, ...] }
function playlistsFile() {
  return path.join(app.getPath('userData'), 'playlists.json');
}

ipcMain.handle('playlists-load', async () => {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(playlistsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
});

ipcMain.handle('playlists-save', async (_e, playlists) => {
  if (!playlists || typeof playlists !== 'object' || Array.isArray(playlists)) return false;
  try {
    await fs.promises.mkdir(app.getPath('userData'), { recursive: true });
    await fs.promises.writeFile(playlistsFile(), JSON.stringify(playlists, null, 2));
    return true;
  } catch (err) {
    console.warn('[playlists-save]', err.message);
    return false;
  }
});

// ── Embedded album art ────────────────────────────────────
// music-metadata is ESM-only → dynamic import. Returns a data URL so the
// renderer can use it directly as an <img> src.
ipcMain.handle('get-embedded-art', async (_e, filename) => {
  const file = resolveLocalAudioFile(filename);
  if (!file) return null;
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(file);
    const pic = meta.common.picture?.[0];
    if (!pic) return null;
    return `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
  } catch {
    return null;
  }
});

// ── YouTube search (unified search fan-out) ───────────────
ipcMain.handle('youtube-search', async (_e, query) => {
  if (typeof query !== 'string' || !query.trim()) return [];
  try {
    const yt = await getInnertube();
    const res = await yt.music.search(query.trim(), { type: 'song' });
    const items = res.songs?.contents || [];
    return items.slice(0, 10).map((s) => ({
      videoId: s.id,
      title: s.title?.text ?? String(s.title ?? ''),
      artist: (s.artists || []).map((a) => a.name).join(', '),
      album: s.album?.name ?? '',
      art: s.thumbnails?.[0]?.url ?? '',
      durationMs: (s.duration?.seconds ?? 0) * 1000,
    })).filter((s) => s.videoId && s.title);
  } catch (err) {
    console.warn('[youtube-search]', err.message);
    return [];
  }
});

// ── Lyrics ────────────────────────────────────────────────
// Lookup order for local files: <song>.lrc sidecar → embedded (USLT/SYLT
// via music-metadata) → lrclib.net. Streams go straight to lrclib.net.
ipcMain.handle('get-lyrics', async (_e, track) => {
  if (!track?.title) return null;

  if (track.file) {
    const file = resolveLocalAudioFile(track.file);
    if (file) {
      // Sidecar .lrc next to the audio file
      const lrcPath = file.replace(/\.[^.]+$/, '.lrc');
      try {
        return { synced: await fs.promises.readFile(lrcPath, 'utf8'), plain: null };
      } catch { /* no sidecar */ }

      // Embedded lyrics
      try {
        const { parseFile } = await import('music-metadata');
        const meta = await parseFile(file);
        const lyr = meta.common.lyrics?.[0];
        if (lyr?.syncText?.length) {
          // SYLT-style: [{ text, timestamp(ms) }] → convert to LRC-ish lines
          return {
            synced: null,
            plain: null,
            syncText: lyr.syncText.map((l) => ({ time: l.timestamp / 1000, text: l.text })),
          };
        }
        if (lyr?.text) return { synced: null, plain: lyr.text };
      } catch { /* no embedded lyrics */ }
    }
  }

  // lrclib.net — free synced-lyrics DB, no auth
  try {
    const params = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist || '',
    });
    if (track.durationMs) params.set('duration', String(Math.round(track.durationMs / 1000)));
    if (track.album) params.set('album_name', track.album);
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.syncedLyrics || data.plainLyrics) {
        return { synced: data.syncedLyrics || null, plain: data.plainLyrics || null };
      }
    }
  } catch { /* offline or no match */ }

  return null;
});

// ── Listen Together ───────────────────────────────────────
// Host runs a ws server; guests' renderers connect via WebSocket.
// LAN: ws://ip:port. Internet: a cloudflared quick tunnel exposes the
// same local server as wss://<random>.trycloudflare.com — no account,
// no port forwarding. Guest commands are forwarded to the host renderer
// ('room-command') so anyone in the room can control playback.
let roomWss = null;
let roomTunnelProc = null;
let roomPublicUrl = null;
let roomHostPromise = null;

function getCloudflaredPath() {
  const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const p of [
    path.join(__dirname, '..', 'bin', binName),
    path.join(process.resourcesPath || '', 'bin', binName),
  ]) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return binName; // PATH fallback
}

// Spawn `cloudflared tunnel --url http://127.0.0.1:<port>` and grab the
// public https URL it prints. Resolves null on failure/timeout — the
// caller then falls back to LAN ip:port.
// (spawn, not execFile: execFile buffers output to maxBuffer and would kill
// a long-lived tunnel once cloudflared's logs exceeded it.)
function startRoomTunnel(localPort) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (url) => { if (!resolved) { resolved = true; resolve(url); } };
    try {
      const proc = spawn(getCloudflaredPath(), [
        'tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate',
      ]);
      roomTunnelProc = proc;
      // Spawn failure (missing binary) surfaces as 'error' — unhandled it
      // throws and crashes the main process.
      proc.on('error', () => done(null));
      // Scan a rolling tail — the URL can split across output chunks.
      let tail = '';
      const onData = (buf) => {
        tail = (tail + buf).slice(-500);
        const m = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) done(m[0]);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', () => done(null));
      setTimeout(() => { try { proc.kill(); } catch {} done(null); }, 15000);
    } catch {
      done(null);
    }
  });
}

ipcMain.handle('room-host', () => {
  if (roomWss) {
    return { port: roomWss.address().port, publicUrl: roomPublicUrl };
  }
  // Dedupe concurrent starts — address() is null until 'listening' fires.
  if (roomHostPromise) return roomHostPromise;
  roomHostPromise = (async () => {
    const { WebSocketServer } = require('ws');
    // maxPayload caps frame size — the room is internet-reachable via the
    // tunnel and unauthenticated, so don't let a stranger push 100 MiB frames
    const wss = new WebSocketServer({ host: '0.0.0.0', port: 0, maxPayload: 16 * 1024 });
    try {
      await new Promise((resolve, reject) => {
        wss.once('listening', resolve);
        wss.once('error', reject);
      });
    } catch (err) {
      try { wss.close(); } catch {}
      throw err;
    }
    // Server/socket 'error' events with no listener throw — keep the app
    // alive when a guest's connection dies abruptly.
    wss.on('error', () => {});
    roomWss = wss;
    const port = wss.address().port;

    // Guest commands → host renderer (anyone in the room can control)
    wss.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('message', (d) => {
        try {
          const msg = JSON.parse(d);
          BrowserWindow.getAllWindows()[0]?.webContents.send('room-command', msg);
        } catch { /* malformed message */ }
      });
    });

    // Try to open a public tunnel so guests on other networks can join
    roomPublicUrl = await startRoomTunnel(port);
    return { port, publicUrl: roomPublicUrl };
  })().finally(() => { roomHostPromise = null; });
  return roomHostPromise;
});

ipcMain.handle('room-stop', async () => {
  // If a host is mid-startup, wait for it so the teardown below sticks.
  if (roomHostPromise) {
    try { await roomHostPromise; } catch {}
  }
  if (roomTunnelProc) {
    try { roomTunnelProc.kill(); } catch {}
    roomTunnelProc = null;
  }
  roomPublicUrl = null;
  if (!roomWss) return;
  const wss = roomWss;
  roomWss = null;
  // wss.close() waits for connected clients — terminate them first or the
  // callback (and this IPC) never fires while a guest is connected.
  for (const c of wss.clients) c.terminate();
  await new Promise((res) => wss.close(res));
});

ipcMain.on('room-broadcast', (_e, msg) => {
  if (!roomWss) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const c of roomWss.clients) {
    if (c.readyState === 1) c.send(data);
  }
});

ipcMain.handle('room-peer-count', () => roomWss?.clients.size ?? 0);

ipcMain.handle('room-local-ip', () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
});

ipcMain.handle('get-stream-url-by-id', (_e, videoId) => {
  return streamUrlForVideoId(videoId);
});

ipcMain.handle('youtube-fetch-playlist', async (_e, url) => {
  // url is argv[0] to yt-dlp — a leading '-' would be parsed as a flag.
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error('yt-dlp playlist fetch failed: invalid URL');
  }
  try {
    return await fetchYouTubePlaylistViaYtDlp(url);
  } catch (err) {
    throw new Error(`yt-dlp playlist fetch failed: ${err.message}`);
  }
});

// ── Google OAuth loopback ─────────────────────────────────
// Google's auth servers refuse to render inside Electron's BrowserWindow
// (embedded-webview policy), so we open the system browser and run a tiny
// local HTTP server to capture the redirect. Returns the auth code synchronously
// after the user completes the flow in their browser.
let activeOauth = null;

ipcMain.handle('youtube-oauth-start', async (_e, { clientId, scope, state, codeChallenge }) => {
  // Tear down any previous attempt
  if (activeOauth) {
    try { activeOauth.reject(new Error('cancelled')); } catch {}
    try { activeOauth.server.close(); } catch {}
    activeOauth = null;
  }

  const { port, server, codePromise, rejectCode } = await new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((r1, r2) => { resolveCode = r1; rejectCode = r2; });

    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/youtube-callback') {
        res.writeHead(404); res.end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      const error = u.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (error) {
        res.end(`<!doctype html><meta charset=utf-8><title>cupid player</title><style>body{font-family:system-ui;background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>Auth failed: ${error}. You can close this window.</div>`);
        rejectCode(new Error(error));
      } else if (!code) {
        res.end('<!doctype html><meta charset=utf-8><div>Missing code. You can close this window.</div>');
        rejectCode(new Error('No code in callback'));
      } else if (returnedState !== state) {
        res.end('<!doctype html><meta charset=utf-8><div>State mismatch. You can close this window.</div>');
        rejectCode(new Error('OAuth state mismatch'));
      } else {
        res.end('<!doctype html><meta charset=utf-8><title>cupid player</title><style>body{font-family:system-ui;background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>✓ Signed in — you can close this window and return to Cupid Player.</div>');
        resolveCode(code);
      }

      // Close the server shortly after handling — single-shot
      setTimeout(() => { try { srv.close(); } catch {} }, 500);
    });

    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: srv.address().port, server: srv, codePromise, rejectCode });
    });
  });

  // Keep the reject fn reachable so cancel/timeout can settle the promise —
  // otherwise the renderer's await hangs forever after the server is closed.
  activeOauth = { server, reject: rejectCode };

  const redirectUri = `http://127.0.0.1:${port}/youtube-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  // Open in the user's default browser — Google refuses embedded webviews
  shell.openExternal(authUrl).catch(() => {});

  // Auto-timeout after 5 minutes so we don't leak the server forever
  const timeout = setTimeout(() => {
    try { server.close(); } catch {}
    if (activeOauth?.server === server) {
      activeOauth.reject(new Error('timed out'));
      activeOauth = null;
    }
  }, 5 * 60 * 1000);

  try {
    const code = await codePromise;
    clearTimeout(timeout);
    // A newer oauth-start may already own activeOauth — don't clobber it.
    if (activeOauth?.server === server) activeOauth = null;
    return { code, redirectUri };
  } catch (err) {
    clearTimeout(timeout);
    try { server.close(); } catch {}
    if (activeOauth?.server === server) activeOauth = null;
    throw err;
  }
});

ipcMain.handle('youtube-oauth-cancel', () => {
  if (activeOauth) {
    activeOauth.reject(new Error('cancelled'));
    try { activeOauth.server.close(); } catch {}
    activeOauth = null;
  }
});

app.whenReady().then(async () => {
  // Needed for Windows toast notifications (track changes) to be attributed
  // to the app instead of "Electron". Also what jump lists/SMTC hang off.
  app.setAppUserModelId('com.cupid.player');

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'));
  }

  if (process.platform === 'win32') {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'pink', 'favicon.png'));
    if (!trayIcon.isEmpty()) {
      tray = new Tray(trayIcon);
      tray.setToolTip('cupid player');
      const toggleWindow = () => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) { w.isVisible() ? w.hide() : w.show(); }
      };
      tray.on('click', toggleWindow);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'show / hide', click: toggleWindow },
        { type: 'separator' },
        { label: 'play / pause', click: () => sendMediaCommand('toggle') },
        { label: 'previous', click: () => sendMediaCommand('prev') },
        { label: 'next', click: () => sendMediaCommand('next') },
        { type: 'separator' },
        { label: 'quit', click: () => app.quit() },
      ]));
    }
  }

  // Auto-update from GitHub releases — packaged builds only.
  if (!isDev) {
    import('electron-updater')
      .then(({ autoUpdater }) => autoUpdater.checkForUpdatesAndNotify())
      .catch(() => {});
  }

  // Seed is async — tell the renderer when it lands so it can reload the
  // local playlist (first-launch race: renderer would otherwise see an
  // empty library until manual reload).
  seedUserAudioDirIfMissing()
    .then(() => BrowserWindow.getAllWindows()[0]?.webContents.send('audio-seeded'))
    .catch((err) => console.warn('[seed]', err.message));

  await startMediaServer();

  createWindow();

  // CI smoke test (CUPID_SMOKE_TEST=1): exercises the full real path —
  // seed, media server, window creation, renderer load — then exits 0.
  // The workflow kills it if it hangs, so a crash = CI failure.
  if (process.env.CUPID_SMOKE_TEST === '1') {
    const win = BrowserWindow.getAllWindows()[0];
    const ok = (msg) => { console.log(`[smoke] ${msg}`); app.exit(0); };
    win.webContents.once('did-finish-load', () => ok('renderer loaded'));
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[smoke] load failed: ${code} ${desc}`);
      app.exit(1);
    });
    setTimeout(() => ok('window created (renderer load timed out — non-fatal)'), 15000);
  }

  // Pre-warm both engines so the first track load skips cold-start
  getInnertube().catch(() => {});
  execFile(getYtDlpPath(), ['--version'], () => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// cloudflared is a detached child that would outlive the app (holding the
// room tunnel open); the ws/oauth servers die with the process but closing
// them here keeps shutdown clean.
app.on('will-quit', () => {
  if (roomTunnelProc) { try { roomTunnelProc.kill(); } catch {} roomTunnelProc = null; }
  if (roomWss) { try { roomWss.close(); } catch {} roomWss = null; }
  if (activeOauth) { try { activeOauth.server.close(); } catch {} activeOauth = null; }
  try { mediaServer.close(); } catch {}
});

#!/usr/bin/env node
/**
 * Playwright Electron smoke test — drives the *packaged* app binary.
 *
 * Runs on macOS dev machines (out/mac-arm64/*.app) and on the
 * windows-latest CI runner (out/win-unpacked/*.exe). Captures
 * screenshots to smoke-shots/, checks the userData seed, exercises
 * the loopback media server (art via <img>, audio via a
 * crossOrigin='anonymous' <audio> — the exact load path AudioEngine
 * uses, incl. Range/seek), and toggles compact ↔ full mode.
 *
 * Usage: node tests/electron-smoke.cjs
 * Exit 0 = all hard checks passed. Warnings (e.g. tunnel) don't fail.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

const OUT_DIR = path.join(__dirname, '..', 'smoke-shots');
const failures = [];
const warnings = [];

function check(name, cond, warn = false) {
  const tag = cond ? 'PASS' : warn ? 'WARN' : 'FAIL';
  console.log(`  [${tag}] ${name}`);
  if (!cond) (warn ? warnings : failures).push(name);
}

function findAppExe() {
  const outDir = path.join(__dirname, '..', 'out');
  if (process.platform === 'win32') {
    const dir = path.join(outDir, 'win-unpacked');
    const exe = fs.readdirSync(dir).find((f) => f.endsWith('.exe') && !/uninstall/i.test(f));
    return exe ? path.join(dir, exe) : null;
  }
  if (process.platform === 'darwin') {
    // mac build is dir-only
    for (const sub of fs.readdirSync(outDir)) {
      const p = path.join(outDir, sub);
      if (!fs.statSync(p).isDirectory()) continue;
      const appDir = fs.readdirSync(p).find((f) => f.endsWith('.app'));
      if (appDir) {
        return path.join(p, appDir, 'Contents', 'MacOS', appDir.replace(/\.app$/, ''));
      }
    }
    return null;
  }
  return null; // linux CI not used yet
}

// Poll an app.evaluate fn until truthy or timeout — fullscreen enters are
// animated; isFullScreen()/bounds lie mid-transition.
async function pollApp(app, fn, timeoutMs = 8000, everyMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await app.evaluate(fn);
    if (last && (last.isFS || last.covers || last === true)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

function userDataAudioDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA, 'cupid-player', 'audio');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'cupid-player', 'audio');
  }
  return path.join(os.homedir(), '.config', 'cupid-player', 'audio');
}

async function main() {
  const exe = findAppExe();
  if (!exe || !fs.existsSync(exe)) {
    console.error(`packaged app not found (looked in out/) — run npm run package first`);
    process.exit(1);
  }
  console.log(`launching ${exe}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const app = await electron.launch({
    executablePath: exe,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });
  // Pipe main-process console — the [cupid-local]/[seed] logs land here
  app.process().stderr.on('data', (d) => {
    const s = d.toString();
    if (/\[cupid|\[seed|error|Error/i.test(s)) process.stderr.write('  [app] ' + s);
  });
  const page = await app.firstWindow();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.waitForLoadState('domcontentloaded');
  // let seed + first paint settle
  await page.waitForTimeout(4000);

  await page.screenshot({ path: path.join(OUT_DIR, '01-compact.png') });
  console.log('  screenshot: 01-compact.png');

  // ── userData seed ──
  const audioDir = userDataAudioDir();
  check(`userData audio dir exists (${audioDir})`, fs.existsSync(audioDir));
  if (fs.existsSync(audioDir)) {
    const hasSubdirArt = fs.existsSync(path.join(audioDir, 'song photos'));
    check('song photos/ subdirectory seeded (windows path-sep regression)', hasSubdirArt);
  }

  // ── loopback media server — same way the app uses it: <img>/<audio> src ──
  const artFile = fs.existsSync(audioDir)
    ? fs.readdirSync(path.join(audioDir, 'song photos'))[0]
    : null;
  if (artFile) {
    const img = await page.evaluate((f) => new Promise(async (res) => {
      const url = await window.cupid.getLocalAudioPath(`song photos/${f}`);
      const el = new Image();
      el.onload = () => res({ loaded: true, w: el.naturalWidth, url });
      el.onerror = (e) => res({ loaded: false, url });
      el.src = url;
      setTimeout(() => res({ loaded: false, timeout: true, url }), 8000);
    }), artFile);
    if (!img.loaded) console.log(`    url was: ${img.url}`);
    check(`media server serves subdirectory art (${artFile})`, img.loaded === true && img.w > 0);
  } else {
    check('media server subdirectory art', false);
  }

  // ── audio load — CORS-enabled <audio>, exactly what AudioEngine does.
  // This is the check that would have caught the custom-scheme CORS bug:
  // an <img> has no CORS mode, so the old test could pass while every
  // track failed to load.
  const audioFile = fs.existsSync(audioDir)
    ? fs.readdirSync(audioDir).find((f) => /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i.test(f))
    : null;
  if (audioFile) {
    const au = await page.evaluate((f) => new Promise(async (res) => {
      const url = await window.cupid.getLocalAudioPath(f);
      const el = new Audio();
      el.crossOrigin = 'anonymous'; // REQUIRED — matches AudioEngine
      const fail = (why) => res({ ok: false, why, url });
      el.onerror = () => fail(`media error code ${el.error?.code}`);
      el.onloadedmetadata = () => {
        const dur = el.duration;
        if (!(dur > 0)) return fail(`duration=${dur}`);
        // seek exercises the Range/206 path
        el.onseeked = () => res({ ok: true, duration: dur, sought: el.currentTime, url });
        el.currentTime = dur / 2;
      };
      el.src = url;
      setTimeout(() => fail('timeout'), 15000);
    }), audioFile);
    if (!au.ok) console.log(`    url was: ${au.url} (${au.why})`);
    check(`media server streams audio CORS-enabled (${audioFile})`, au.ok === true);
    if (au.ok) check(`  → duration ${au.duration.toFixed(1)}s, seek to ${au.sought.toFixed(1)}s`, true);
  } else {
    check('media server audio streaming (no audio file in seed)', false);
  }

  // ── local playlist IPC (validates playlist.json + seed on this OS) ──
  const lp = await page.evaluate(() => window.cupid.getLocalPlaylist());
  check(`local playlist loads (${lp?.length ?? 'err'} tracks)`, Array.isArray(lp) && lp.length > 0);

  // ── full mode toggle ──
  await page.evaluate(() => window.cupid?.toggleMode?.());
  // isFullScreen() lies mid-transition and on some CI displays — poll for
  // fullscreen OR the window covering ~the whole work area.
  const full = await pollApp(app, ({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const b = win.getBounds();
    return {
      isFS: win.isFullScreen(),
      covers: b.width >= wa.width * 0.9 && b.height >= wa.height * 0.9,
    };
  });
  check(`window covers display (isFullScreen=${full?.isFS}, covers=${full?.covers})`,
    !!(full?.isFS || full?.covers));
  await page.screenshot({ path: path.join(OUT_DIR, '02-full.png') });
  console.log('  screenshot: 02-full.png');

  // side panels should exist in full mode
  const panels = await page.evaluate(() => ({
    library: !!document.querySelector('.library-panel'),
    search: !!document.querySelector('.search-panel'),
    lyrics: !!document.querySelector('.lyrics-panel'),
  }));
  check('library panel visible in full mode', panels.library);
  check('search panel visible in full mode', panels.search);
  check('lyrics panel visible in full mode', panels.lyrics);

  // ── back to compact, bounds restored ──
  await page.evaluate(() => window.cupid?.toggleMode?.());
  const compact = await pollApp(app, ({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const b = win.getBounds();
    return !win.isFullScreen() && b.width < wa.width * 0.9;
  });
  check('window restored to compact', compact === true);
  await page.screenshot({ path: path.join(OUT_DIR, '03-compact-restored.png') });
  console.log('  screenshot: 03-compact-restored.png');

  // ── playlist IPC round-trip ──
  const pl = await page.evaluate(async () => {
    await window.cupid.savePlaylists({ 'smoke test': [{ title: 't', artist: 'a', source: 'local', file: 'x.mp3' }] });
    return window.cupid.loadPlaylists();
  });
  check('playlists save/load round-trip', pl?.['smoke test']?.[0]?.title === 't');
  await page.evaluate(() => window.cupid.savePlaylists({})); // clean up

  // ── room host (ws + optional tunnel) ──
  try {
    const room = await page.evaluate(() => window.cupid.roomHost());
    check('room host started (ws server up)', typeof room?.port === 'number' && room.port > 0);
    if (room?.publicUrl) {
      console.log(`    tunnel: ${room.publicUrl}`);
    } else {
      check('public tunnel URL', false, true); // warn-only — needs network + DNS
    }
    await page.evaluate(() => window.cupid.roomStop());
  } catch (e) {
    check('room host', false, true);
  }

  await app.close();

  if (consoleErrors.length) {
    console.log('  renderer pageerrors:');
    for (const e of consoleErrors.slice(0, 10)) console.log(`    ${e}`);
  }

  console.log(`\n${failures.length} failure(s), ${warnings.length} warning(s)`);
  if (failures.length) { console.log('FAILED:', failures.join(', ')); process.exit(1); }
  console.log('smoke test passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

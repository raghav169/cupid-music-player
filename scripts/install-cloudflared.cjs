#!/usr/bin/env node
/**
 * Download the platform-specific cloudflared binary into ./bin —
 * used for Listen Together rooms over the internet (quick tunnels to
 * *.trycloudflare.com, no Cloudflare account needed). LAN rooms work
 * without it.
 *
 * Failures are non-fatal — npm install still succeeds.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const REPO = 'cloudflare/cloudflared';

function assetForPlatform() {
  const { platform, arch } = process;
  const arm = arch === 'arm64' || arch === 'aarch64';
  if (platform === 'darwin') {
    return { asset: `cloudflared-darwin-${arm ? 'arm64' : 'amd64'}.tgz`, outName: 'cloudflared', tgz: true };
  }
  if (platform === 'linux') {
    return { asset: `cloudflared-linux-${arm ? 'arm64' : 'amd64'}`, outName: 'cloudflared' };
  }
  if (platform === 'win32') {
    return { asset: 'cloudflared-windows-amd64.exe', outName: 'cloudflared.exe' };
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

function httpsGet(url, accept = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': 'cupid-player-install-script', 'Accept': accept },
    };
    const req = https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGet(res.headers.location, accept).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    // A stalled connection must not hang `npm install` forever.
    req.setTimeout(60000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

function download(url, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpsGet(url);
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const tmp = `${dest}.partial`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      // Response stream errors don't hit file.on('error') — without this the
      // error is unhandled (crash) and the promise never settles (hang).
      res.on('error', (err) => {
        file.destroy();
        try { fs.unlinkSync(tmp); } catch {}
        reject(err);
      });
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      file.on('error', (err) => { res.destroy(); try { fs.unlinkSync(tmp); } catch {} reject(err); });
    } catch (err) {
      reject(err);
    }
  });
}

async function fetchLatestTag() {
  const res = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`, 'application/vnd.github+json');
  if (res.statusCode !== 200) throw new Error(`GitHub API returned ${res.statusCode}`);
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body).tag_name;
}

async function main() {
  if (process.env.SKIP_CLOUDFLARED_INSTALL === '1') {
    console.log('[install-cloudflared] skipped (SKIP_CLOUDFLARED_INSTALL=1)');
    return;
  }

  const { asset, outName, tgz } = assetForPlatform();
  const dest = path.join(BIN_DIR, outName);

  try {
    const stat = fs.statSync(dest);
    if (Date.now() - stat.mtimeMs < 14 * 24 * 60 * 60 * 1000) {
      console.log(`[install-cloudflared] using cached binary at ${dest}`);
      return;
    }
  } catch {}

  fs.mkdirSync(BIN_DIR, { recursive: true });

  let tag = 'latest';
  try {
    tag = await fetchLatestTag();
  } catch (err) {
    console.warn(`[install-cloudflared] couldn't resolve latest tag (${err.message}); falling back to /latest/download URL`);
  }

  const url = tag === 'latest'
    ? `https://github.com/${REPO}/releases/latest/download/${asset}`
    : `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

  console.log(`[install-cloudflared] downloading ${url}`);

  if (tgz) {
    const tgzPath = `${dest}.tgz`;
    await download(url, tgzPath);
    execFileSync('tar', ['-xzf', tgzPath, '-C', BIN_DIR]);
    fs.unlinkSync(tgzPath);
  } else {
    await download(url, dest);
  }

  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`[install-cloudflared] installed cloudflared (${tag}) at ${dest}`);
}

main().catch((err) => {
  console.warn(`[install-cloudflared] failed: ${err.message}`);
  console.warn('[install-cloudflared] continuing — internet rooms will be unavailable; LAN rooms still work.');
  process.exit(0);
});

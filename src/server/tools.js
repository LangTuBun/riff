const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { IS_WIN, BIN_DIR, resolveBinary, clearBinaryCache } = require('../shared/platform');
const logger = require('../shared/logger');

const state = { status: 'idle', tool: '', percent: 0, error: '' };
const STAMP = path.join(BIN_DIR, '.ytdlp-update-stamp');

function ytDlpAsset() {
  const a = process.arch;
  if (IS_WIN) return a === 'arm64' ? 'yt-dlp_arm64.exe' : a === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return a === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function ffmpegAsset() {
  const a = process.arch === 'arm64' ? 'arm64' : '64';
  if (IS_WIN) return { name: `ffmpeg-master-latest-win${a}-gpl.zip` };
  if (process.platform === 'linux') return { name: `ffmpeg-master-latest-linux${a}-gpl.tar.xz` };
  return null;
}

function get(url, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Riff' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function getText(url) {
  const res = await get(url);
  let out = '';
  res.setEncoding('utf8');
  for await (const chunk of res) out += chunk;
  return out;
}

async function downloadFile(url, dest) {
  const res = await get(url);
  const total = Number(res.headers['content-length']) || 0;
  let done = 0;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on('data', (c) => {
      hash.update(c);
      done += c.length;
      if (total) state.percent = Math.round((done / total) * 100);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  return hash.digest('hex');
}

function expectedHash(sums, fileName) {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/i);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

function run(cmd, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      clearTimeout(t);
      try { logger.error(`${cmd} spawn error`, e); } catch (_) {}
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve();
      } else {
        const lastStderr = (err || '').split('\n').slice(-20).join('\n');
        try { logger.error(`${cmd} exited with ${code}`, new Error(lastStderr)); } catch (_) {}
        reject(new Error(err || `${cmd} exited with ${code}`));
      }
    });
  });
}

function findFile(dir, fileName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, fileName);
      if (hit) return hit;
    } else if (entry.name === fileName) return full;
  }
  return null;
}

async function installYtDlp() {
  const asset = ytDlpAsset();
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const sums = await getText(`${base}/SHA2-256SUMS`);
  const want = expectedHash(sums, asset);
  if (!want) throw new Error(`No checksum published for ${asset}`);
  const target = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
  const tmp = `${target}.download`;
  const got = await downloadFile(`${base}/${asset}`, tmp);
  if (got !== want) { fs.rmSync(tmp, { force: true }); throw new Error('yt-dlp checksum mismatch'); }
  if (!IS_WIN) fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, target);
}

async function installFfmpeg() {
  const asset = ffmpegAsset();
  if (!asset) throw new Error('No ffmpeg build for this system. Install ffmpeg with your package manager (for macOS: brew install ffmpeg).');
  const base = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download';
  const sums = await getText(`${base}/checksums.sha256`);
  const want = expectedHash(sums, asset.name);
  if (!want) throw new Error(`No checksum published for ${asset.name}`);
  const archive = path.join(os.tmpdir(), `riff-${asset.name}`);
  const got = await downloadFile(`${base}/${asset.name}`, archive);
  if (got !== want) { fs.rmSync(archive, { force: true }); throw new Error('ffmpeg checksum mismatch'); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-ffmpeg-'));
  try {
    await run('tar', ['-xf', archive, '-C', work]);
    for (const name of ['ffmpeg', 'ffprobe']) {
      const exe = IS_WIN ? `${name}.exe` : name;
      const src = findFile(work, exe);
      if (!src) throw new Error(`${exe} not found inside the archive`);
      const dest = path.join(BIN_DIR, exe);
      fs.copyFileSync(src, dest);
      if (!IS_WIN) fs.chmodSync(dest, 0o755);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}

const SOCKSEEK_VERSION = '3.0.6';
const SOCKSEEK_ASSETS = {
  'win32-x64': { name: 'sockseek_3.0.6_win-x64.zip', sha256: 'aa965bdf3bc9b04757380889e1ce96ce1d57fdf89423fb3f7ebf378e469e66c4' },
  'linux-x64': { name: 'sockseek_3.0.6_linux-x64.tar.gz', sha256: '91d7d14fa1293afe94ccb0299e0103f8477a558223f62f4027f5712e4bbf521a' },
  'linux-arm': { name: 'sockseek_3.0.6_linux-arm.tar.gz', sha256: 'd45b87720b6ab006e471f79055ea3865020fae0761b3e9100731729bdff9f7ea' },
  'darwin-arm64': { name: 'sockseek_3.0.6_osx-arm64.tar.gz', sha256: 'b7b9602b3ea0d8724b2a4dd1370c97f2f1f7175f901e7088dad714352c4926d9' },
  'darwin-x64': { name: 'sockseek_3.0.6_osx-x64.tar.gz', sha256: '6211374e1fca1f0b0bb4bfc6395e493c5969416e116a976f87bac4bdb99320fd' }
};
const sockseekState = { status: 'idle', percent: 0, error: '' };

function sockseekAsset() {
  return SOCKSEEK_ASSETS[`${process.platform}-${process.arch}`] || null;
}

async function installSockseek() {
  if (sockseekState.status === 'downloading') return;
  const asset = sockseekAsset();
  if (!asset) throw new Error('No sockseek build for this system');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  sockseekState.status = 'downloading';
  sockseekState.percent = 0;
  sockseekState.error = '';
  const archive = path.join(os.tmpdir(), `riff-${asset.name}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-sockseek-'));
  try {
    const res = await get(`https://github.com/fiso64/sockseek/releases/download/v${SOCKSEEK_VERSION}/${asset.name}`);
    const total = Number(res.headers['content-length']) || 0;
    let done = 0;
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(archive);
      res.on('data', (c) => {
        hash.update(c);
        done += c.length;
        if (total) sockseekState.percent = Math.round((done / total) * 100);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (hash.digest('hex') !== asset.sha256) throw new Error('sockseek checksum mismatch');
    const sysTar = IS_WIN && path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await run(sysTar && fs.existsSync(sysTar) ? sysTar : 'tar', ['-xf', archive, '-C', work]);
    const exe = IS_WIN ? 'sockseek.exe' : 'sockseek';
    const src = findFile(work, exe);
    if (!src) throw new Error(`${exe} not found inside the archive`);
    const dest = path.join(BIN_DIR, exe);
    fs.copyFileSync(src, dest);
    if (!IS_WIN) fs.chmodSync(dest, 0o755);
    clearBinaryCache();
    sockseekState.status = 'done';
  } catch (e) {
    try { logger.error('sockseek download failed', e); } catch (_) {}
    sockseekState.status = 'error';
    sockseekState.error = e.message;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}

function sockseekInstallStatus() {
  return { installed: !!resolveBinary('sockseek'), supported: !!sockseekAsset(), version: SOCKSEEK_VERSION, ...sockseekState };
}

function toolsStatus() {
  return {
    ytDlp: !!resolveBinary('yt-dlp'),
    ffmpeg: !!resolveBinary('ffmpeg'),
    progress: Object.assign({}, state)
  };
}

async function ensureTools() {
  if (state.status === 'downloading') return toolsStatus();
  fs.mkdirSync(BIN_DIR, { recursive: true });
  state.status = 'downloading';
  state.error = '';
  try {
    if (!resolveBinary('yt-dlp')) { state.tool = 'yt-dlp'; state.percent = 0; await installYtDlp(); clearBinaryCache(); }
    if (!resolveBinary('ffmpeg')) { state.tool = 'ffmpeg'; state.percent = 0; await installFfmpeg(); clearBinaryCache(); }
    state.status = 'done';
  } catch (e) {
    try { logger.error(`Tool download failed: ${state.tool}`, e); } catch (_) {}
    state.status = 'error';
    state.error = e.message;
  }
  return toolsStatus();
}

async function updateYtDlpIfManaged() {
  const bin = resolveBinary('yt-dlp');
  if (!bin || path.dirname(bin) !== BIN_DIR) return false;
  try {
    const last = Number(fs.readFileSync(STAMP, 'utf8')) || 0;
    if (Date.now() - last < 24 * 3600 * 1000) return false;
  } catch (e) {}
  try {
    await run(bin, ['-U'], 120000);
    fs.writeFileSync(STAMP, String(Date.now()));
    return true;
  } catch (e) {
    try { logger.error('yt-dlp update failed', e); } catch (_) {}
    return false;
  }
}

module.exports = { ensureTools, toolsStatus, updateYtDlpIfManaged, expectedHash, ytDlpAsset, ffmpegAsset, installSockseek, sockseekInstallStatus };

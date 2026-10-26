const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { DATA_DIR, resolveBinary } = require('../shared/platform');
const { cleanSoulseekQuery, buildSongJobRequest, buildSockseekConf, isLosslessExtension } = require('../shared/lossless');
const logger = require('../shared/logger');

const WORK_DIR = path.join(DATA_DIR, 'sockseek');
const INCOMING_DIR = path.join(WORK_DIR, 'incoming');
const CONF_PATH = path.join(WORK_DIR, 'sockseek.conf');
const PID_PATH = path.join(WORK_DIR, 'daemon.pid');
const AUTH_PATH = path.join(DATA_DIR, 'soulseek-auth.enc');
const MOCK_DIR = process.env.RIFF_SOCKSEEK_MOCK_DIR || '';
const safeStorage = process.versions.electron ? require('electron').safeStorage : null;

const daemon = { proc: null, port: 0, starting: null, error: '', soulseek: null };
const jobs = new Map();
let pollTimer = null;
let pollInFlight = false;
let importChain = Promise.resolve();
let hasLibraryTrack = null;
let onDownloaded = null;

const FAILURE_MESSAGES = {
  NoSearchResults: 'No lossless copy found on Soulseek',
  NoMatchingResults: 'No lossless copy found on Soulseek',
  InvalidSearchString: 'Track title is missing',
  AllDownloadsFailed: 'Every peer failed to send the file',
  OutOfDownloadRetries: 'Every peer failed to send the file',
  Cancelled: 'Cancelled'
};

function canStoreAuth() {
  return !!(safeStorage && safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'));
}

function loadAuth() {
  if (!canStoreAuth()) return null;
  try {
    const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(AUTH_PATH)));
    if (saved && typeof saved.username === 'string' && typeof saved.password === 'string') return saved;
  } catch (e) {}
  return null;
}

function saveAuth(username, password) {
  if (!canStoreAuth()) throw new Error('Secure storage is not available on this system');
  buildSockseekConf({ username, password });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${AUTH_PATH}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify({ username, password })), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_PATH);
  stopDaemon();
}

function clearAuth() {
  stopDaemon();
  fs.rmSync(AUTH_PATH, { force: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) throw new Error((data && (data.detail || data.title || data.error)) || `sockseek HTTP ${res.status}`);
  return data;
}

async function startDaemon() {
  if (daemon.proc) return;
  if (daemon.starting) return daemon.starting;
  daemon.starting = (async () => {
    const bin = resolveBinary('sockseek');
    if (!bin) throw new Error('sockseek is not installed');
    const auth = MOCK_DIR ? null : loadAuth();
    if (!MOCK_DIR && !auth) throw new Error('Add your Soulseek account first');
    killStaleDaemon();
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    if (auth) fs.writeFileSync(CONF_PATH, buildSockseekConf(auth), { mode: 0o600 });
    daemon.port = await freePort();
    const args = ['daemon', '-c', auth ? CONF_PATH : 'none', '-o', INCOMING_DIR, '--server-ip', '127.0.0.1', '--server-port', String(daemon.port)];
    if (MOCK_DIR) args.push('--mock-files-dir', MOCK_DIR);
    const proc = spawn(bin, args, { cwd: WORK_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-4000); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    daemon.proc = proc;
    daemon.error = '';
    if (proc.pid) fs.writeFileSync(PID_PATH, String(proc.pid));
    proc.on('exit', (code) => {
      if (daemon.proc !== proc) return;
      daemon.proc = null;
      daemon.soulseek = null;
      if (code) {
        daemon.error = `sockseek stopped (exit ${code})`;
        try { logger.error('sockseek daemon exited', new Error(tail.split('\n').slice(-12).join('\n'))); } catch (_) {}
      }
      for (const job of jobs.values()) {
        if (!job.finished) finishJob(job, 'failed', 'sockseek stopped unexpectedly');
      }
    });
    proc.on('error', (e) => { daemon.error = e.message; });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (!daemon.proc) throw new Error(daemon.error || 'sockseek failed to start');
      try {
        const status = await api('GET', '/api/server/status');
        daemon.soulseek = status && status.soulseekClient;
        return;
      } catch (e) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    stopDaemon();
    throw new Error('sockseek did not start in time');
  })();
  try {
    await daemon.starting;
  } finally {
    daemon.starting = null;
  }
}

function stopDaemon() {
  const proc = daemon.proc;
  daemon.proc = null;
  daemon.soulseek = null;
  if (proc) {
    try { proc.kill(); } catch (e) {}
  }
  for (const job of jobs.values()) {
    if (!job.finished && job.state !== 'importing') finishJob(job, 'cancelled', 'Downloader stopped');
  }
  fs.rmSync(CONF_PATH, { force: true });
  fs.rmSync(PID_PATH, { force: true });
}

function pidIsSockseek(pid) {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 3000 }).toString()
      : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 3000 }).toString();
    return /sockseek/i.test(out);
  } catch (e) {
    return false;
  }
}

function killStaleDaemon() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PID_PATH, 'utf8')) || 0; } catch (e) {}
  if (pid > 0 && pidIsSockseek(pid)) {
    try { process.kill(pid); } catch (e) {}
  }
  fs.rmSync(PID_PATH, { force: true });
  fs.rmSync(CONF_PATH, { force: true });
}

function publicJob(job) {
  const { ssJobId, finished, cleanArtist, cleanTitle, thumbnail, key, ...rest } = job;
  return rest;
}

function finishJob(job, state, error) {
  job.state = state;
  job.error = error || '';
  job.finished = true;
  job.updatedAt = Date.now();
}

async function pollJobs() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollJobsOnce();
  } finally {
    pollInFlight = false;
  }
}

async function pollJobsOnce() {
  const active = [...jobs.values()].filter(j => !j.finished && j.ssJobId);
  if (!active.length || !daemon.proc) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  try {
    const status = await api('GET', '/api/server/status');
    daemon.soulseek = status && status.soulseekClient;
  } catch (e) {}
  for (const job of active) {
    if (job.state === 'importing') continue;
    let detail;
    try {
      detail = await api('GET', `/api/jobs/${encodeURIComponent(job.ssJobId)}`);
    } catch (e) {
      continue;
    }
    const s = detail && detail.summary;
    const p = (detail && detail.payload) || {};
    if (!s) continue;
    job.updatedAt = Date.now();
    if (typeof p.progressPercent === 'number') job.progress = Math.round(p.progressPercent);
    if (p.resolvedFilename) job.peerFile = String(p.resolvedFilename).split(/[\\/]/).pop();
    if (p.resolvedSampleRate) job.sampleRate = Number(p.resolvedSampleRate);
    const depth = (p.resolvedAttributes || []).find(a => a && a.type === 'BitDepth');
    if (depth) job.bitDepth = Number(depth.value);
    if (s.lifecycleState !== 'Terminal') {
      job.state = p.transferState || job.progress ? 'downloading' : 'searching';
      continue;
    }
    if (s.terminalOutcome !== 'Succeeded') {
      finishJob(job, s.terminalOutcome === 'Cancelled' ? 'cancelled' : 'failed',
        FAILURE_MESSAGES[s.failureReason] || s.failureMessage || 'Download failed');
      continue;
    }
    if (p.downloadSource !== 'Soulseek' || !p.downloadPath || !isLosslessExtension(path.extname(p.downloadPath))) {
      if (p.downloadPath) fs.rmSync(p.downloadPath, { force: true });
      finishJob(job, 'failed', 'Result was not a lossless Soulseek file');
      continue;
    }
    job.state = 'importing';
    const filePath = path.resolve(p.downloadPath);
    importChain = importChain.then(async () => {
      try {
        const imported = await onDownloaded(job, filePath);
        Object.assign(job, imported);
        finishJob(job, 'done');
      } catch (e) {
        finishJob(job, 'failed', e.message);
      }
    });
  }
}

function jobKey(query) {
  return `${query.artist || ''}\u0000${query.title || ''}`.toLowerCase();
}

async function submitBatch(tracks, opts) {
  const batchId = crypto.randomBytes(6).toString('hex');
  const summary = { batchId, submitted: 0, skipped: 0 };
  for (const track of tracks) {
    const query = cleanSoulseekQuery(track);
    if (!query.title) continue;
    const key = jobKey(query);
    const queued = [...jobs.values()].some(j => !j.finished && j.key === key);
    const owned = hasLibraryTrack ? hasLibraryTrack(key) : false;
    if (queued || owned) {
      const job = {
        id: crypto.randomBytes(8).toString('hex'),
        batchId,
        batchName: opts.name || '',
        title: track.title || query.title,
        artist: track.artist || query.artist || '',
        query: [query.artist, query.title].filter(Boolean).join(' - '),
        key,
        state: 'skipped',
        error: owned ? 'Already in your library' : 'Already in the download queue',
        progress: 0,
        finished: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      jobs.set(job.id, job);
      summary.skipped++;
      continue;
    }
    await submitDownload({ ...track, preferHiRes: opts.preferHiRes }, { batchId, batchName: opts.name || '' });
    summary.submitted++;
  }
  return summary;
}

async function submitDownload(track, batch) {
  const query = cleanSoulseekQuery(track);
  if (!query.title) throw new Error('Track title is missing');
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    batchId: batch ? batch.batchId : '',
    batchName: batch ? batch.batchName : '',
    key: jobKey(query),
    title: track.title || query.title,
    artist: track.artist || query.artist || '',
    query: [query.artist, query.title].filter(Boolean).join(' - '),
    cleanArtist: query.artist || '',
    cleanTitle: query.title || '',
    thumbnail: /^https?:\/\//i.test(track.thumbnail || '') ? track.thumbnail : '',
    preferHiRes: !!track.preferHiRes,
    state: 'starting',
    progress: 0,
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  jobs.set(job.id, job);
  try {
    await startDaemon();
    const res = await api('POST', '/api/jobs/downloads/song', buildSongJobRequest(query, { preferHiRes: job.preferHiRes }));
    job.ssJobId = res && res.jobId;
    if (!job.ssJobId) throw new Error('sockseek did not accept the job');
    job.state = 'searching';
    if (!pollTimer) pollTimer = setInterval(() => { pollJobs().catch(() => {}); }, 1000);
  } catch (e) {
    finishJob(job, 'failed', e.message);
  }
  return publicJob(job);
}

async function cancelDownload(id) {
  const job = jobs.get(id);
  if (!job || job.finished) return;
  if (job.ssJobId && daemon.proc) {
    try { await api('POST', `/api/jobs/${encodeURIComponent(job.ssJobId)}/cancel`); } catch (e) {}
  }
  finishJob(job, 'cancelled', 'Cancelled');
}

function listDownloads() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 500).map(publicJob);
}

function sockseekStatus() {
  const auth = loadAuth();
  return {
    mock: !!MOCK_DIR,
    secureStorage: canStoreAuth(),
    configured: !!MOCK_DIR || !!auth,
    username: auth ? auth.username : '',
    daemon: daemon.proc ? 'running' : daemon.starting ? 'starting' : 'stopped',
    soulseek: daemon.soulseek,
    error: daemon.error
  };
}

function init(opts) {
  onDownloaded = opts.onDownloaded;
  hasLibraryTrack = opts.hasLibraryTrack || null;
}

process.on('exit', stopDaemon);

module.exports = { init, saveAuth, clearAuth, startDaemon, stopDaemon, submitDownload, submitBatch, cancelDownload, listDownloads, sockseekStatus, INCOMING_DIR };

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getSettings, cookiesFile, PATHS } = require('./store');

const isWin = process.platform === 'win32';
const LOOKUP_EXTENSIONS = isWin ? ['', '.exe', '.cmd', '.bat'] : [''];

let cachedBinary = null;
let cachedFfmpeg = undefined;

/** Locate the yt-dlp executable (or fall back to `python -m yt_dlp`). */
function findYtdlp() {
  if (cachedBinary) return cachedBinary;

  const explicit = (process.env.YTDLP_PATH || '').trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (isWin) {
    const localDir = path.join(PATHS.data, 'bin');
    if (fs.existsSync(localDir)) {
      for (const f of fs.readdirSync(localDir)) {
        if (/^yt-?dlp(\.exe)?$/i.test(f)) candidates.push(path.join(localDir, f));
      }
    }
  }
  for (const ext of LOOKUP_EXTENSIONS) {
    candidates.push(`${isWin ? 'yt-dlp' : 'yt-dlp'}${ext}`);
  }

  for (const cmd of candidates) {
    if (path.isAbsolute(cmd) || cmd.includes(path.sep)) {
      if (fs.existsSync(cmd)) {
        const version = probeVersion(cmd, []);
        if (version) return (cachedBinary = { cmd, args: [], version, kind: 'binary' });
      }
      continue;
    }
    const resolved = whichSync(cmd);
    if (resolved) {
      const version = probeVersion(resolved, []);
      if (version) return (cachedBinary = { cmd: resolved, args: [], version, kind: 'binary' });
    }
  }

  // Last resort: the Python module.
  for (const py of [process.env.PYTHON || '', 'python', 'python3', 'py'].filter(Boolean)) {
    const resolved = whichSync(py);
    if (!resolved) continue;
    const version = probeVersion(resolved, ['-m', 'yt_dlp', '--version']);
    if (version) return (cachedBinary = { cmd: resolved, args: ['-m', 'yt_dlp'], version, kind: 'python' });
  }

  cachedBinary = null;
  return null;
}

function whichSync(cmd) {
  try {
    const r = spawnSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!first) return null;
    return isWin && /\.(exe|cmd|bat)$/i.test(first) ? first : first;
  } catch {
    return null;
  }
}

function probeVersion(cmd, args) {
  try {
    const r = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0) return null;
    const v = (r.stdout || '').trim().split(/\r?\n/)[0];
    return v || null;
  } catch {
    return null;
  }
}

function ffmpegBinary() {
  const s = getSettings();
  const explicit = (s.ffmpegPath || process.env.FFMPEG_PATH || '').trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  for (const ext of LOOKUP_EXTENSIONS) candidates.push(`ffmpeg${ext}`);

  for (const cmd of candidates) {
    if (path.isAbsolute(cmd) || cmd.includes(path.sep)) {
      if (fs.existsSync(cmd) && probeVersion(cmd, ['-version'])) return cmd;
      continue;
    }
    const resolved = whichSync(cmd);
    if (resolved && probeVersion(resolved, ['-version'])) return resolved;
  }
  return null;
}

function hasFfmpeg() {
  if (cachedFfmpeg === undefined) cachedFfmpeg = !!ffmpegBinary();
  return cachedFfmpeg;
}

function resetFfmpegCache() {
  cachedFfmpeg = undefined;
}

function runProbe(url, { cookiesFromBrowser } = {}) {
  const bin = findYtdlp();
  if (!bin) return Promise.reject(new Error('yt-dlp was not found. Install it with: pip install -U yt-dlp'));
  const args = [...bin.args, ...globalArgs(), '--no-update', '--dump-json', '--no-playlist', '--no-warnings'];
  const cf = cookiesFile();
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  else if (fs.existsSync(cf)) args.push('--cookies', cf);
  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(bin.cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const MAX = 32 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX) child.kill();
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Could not parse yt-dlp metadata output.'));
      }
    });
  });
}

function runPlaylist(url, { cookiesFromBrowser, limit } = {}) {
  const bin = findYtdlp();
  if (!bin) return Promise.reject(new Error('yt-dlp was not found. Install it with: pip install -U yt-dlp'));
  const args = [
    ...bin.args,
    ...globalArgs(),
    '--no-update',
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
  ];
  if (limit) args.push('--playlist-end', String(limit));
  const cf = cookiesFile();
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  else if (fs.existsSync(cf)) args.push('--cookies', cf);
  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn(bin.cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const MAX = 64 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX) child.kill();
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`));
      }
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      const items = [];
      for (const line of lines) {
        try { items.push(JSON.parse(line)); } catch { /* skip */ }
      }
      resolve(items);
    });
  });
}

function cleanError(text) {
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\s*\[?(debug|download)\]?\s*$/i.test(l));
  const last = lines.slice(-4).join(' ');
  return last.replace(/^ERROR:\s*/i, '').slice(0, 500);
}

/** Kill a process and its children (Windows needs taskkill for the tree). */
function killTree(child, signal = 'SIGKILL') {
  if (!child || child.killed) return;
  try {
    if (isWin && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill(signal);
    }
  } catch { /* already gone */ }
}

/**
 * YouTube now requires an external JavaScript runtime for extraction. yt-dlp
 * looks for `deno` by default, so detect whatever is actually installed and
 * pass it through with --js-runtimes.
 */
function detectJsRuntime() {
  for (const cmd of ['deno', 'node']) {
    if (whichSync(cmd)) return cmd;
  }
  return null;
}

/** Flags every yt-dlp invocation needs, given the local environment. */
function globalArgs() {
  const args = [];
  const rt = detectJsRuntime();
  if (rt) args.push('--js-runtimes', rt);
  return args;
}

function systemInfo() {
  const bin = findYtdlp();
  resetFfmpegCache();
  const ff = ffmpegBinary();
  return {
    jsRuntime: detectJsRuntime(),
    ytdlpFound: !!bin,
    ytdlpVersion: bin ? bin.version : null,
    ytdlpCommand: bin ? bin.cmd : null,
    ytdlpKind: bin ? bin.kind : null,
    ffmpegFound: !!ff,
    ffmpegPath: ff || null,
    platform: `${process.platform} ${process.arch}`,
    node: process.versions.node,
  };
}

module.exports = {
  findYtdlp,
  hasFfmpeg,
  ffmpegBinary,
  resetFfmpegCache,
  runProbe,
  runPlaylist,
  killTree,
  systemInfo,
  isWin,
  cleanError,
  globalArgs,
  detectJsRuntime,
};

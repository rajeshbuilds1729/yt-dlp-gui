'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getSettings, cookiesFile, PATHS } = require('./store');
const ytdlp = require('./ytdlp');

/** Options that are safe to pass through from the client. Everything else is dropped. */
const OPTION_SPEC = {
  preset: 'string',
  maxHeight: 'number',
  videoFormatId: 'string',
  audioFormatId: 'string',
  container: 'string',
  audioFormat: 'string',
  audioQuality: 'number',
  writeSubs: 'boolean',
  autoSubs: 'boolean',
  subLangs: 'string',
  embedSubs: 'boolean',
  subFormat: 'string',
  writeThumbnail: 'boolean',
  embedThumbnail: 'boolean',
  embedMetadata: 'boolean',
  embedChapters: 'boolean',
  archive: 'boolean',
  rateLimit: 'string',
  playlist: 'boolean',
  playlistItems: 'string',
  outputDir: 'string',
  filenameTemplate: 'string',
  concurrentFragments: 'number',
  cookiesFromBrowser: 'string',
};

const LIMITS = {
  string: 500,
  number: 100000,
};

function sanitizeOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, kind] of Object.entries(OPTION_SPEC)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (kind === 'string') {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed.slice(0, LIMITS.string);
    } else if (kind === 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.min(LIMITS.number, Math.max(0, Math.round(n)));
    } else if (kind === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
    }
  }
  return out;
}

function baseSettings() {
  const s = getSettings();
  return {
    preset: s.preset,
    maxHeight: s.maxHeight,
    videoFormatId: s.videoFormatId,
    audioFormatId: s.audioFormatId,
    container: s.container,
    audioFormat: s.audioFormat,
    audioQuality: s.audioQuality,
    writeSubs: s.writeSubs,
    autoSubs: s.autoSubs,
    subLangs: s.subLangs,
    embedSubs: s.embedSubs,
    subFormat: s.subFormat,
    writeThumbnail: s.writeThumbnail,
    embedThumbnail: s.embedThumbnail,
    embedMetadata: s.embedMetadata,
    embedChapters: s.embedChapters,
    archive: s.archiveEnabled,
    rateLimit: s.rateLimit,
    playlist: false,
    playlistItems: '',
    outputDir: s.outputDir,
    filenameTemplate: s.filenameTemplate,
    concurrentFragments: s.concurrentFragments,
    cookiesFromBrowser: s.cookiesEnabled ? s.cookiesFromBrowser : '',
  };
}

function resolveFormatSelector(opts, ffmpeg) {
  const out = [];
  const preset = opts.preset || 'best';

  if (preset === 'manual' && opts.videoFormatId) {
    const parts = [opts.videoFormatId];
    if (opts.audioFormatId) parts.push(opts.audioFormatId);
    out.push('-f', parts.join('+'));
    return out;
  }

  if (preset === 'height' && opts.maxHeight) {
    const h = Math.min(Number(opts.maxHeight) || 1080, 4320);
    // Merged first; without ffmpeg fall back to the tallest combined stream
    // (some sites offer none, so end with "any video+audio").
    const best = ffmpeg
      ? `bv*[height<=${h}]+ba/b[height<=${h}]/bv*[height<=${h}]`
      : `b[height<=${h}]/bv*[height<=${h}]`;
    out.push('-f', best);
    return out;
  }

  if (preset === 'bestaudio') {
    if (ffmpeg) {
      out.push('-f', 'ba/b', '-x', '--audio-format', opts.audioFormat || 'mp3');
      if ((opts.audioFormat || 'mp3') === 'mp3' || (opts.audioFormat || 'mp3') === 'm4a') {
        out.push('--audio-quality', String(opts.audioQuality ?? 0));
      }
    } else {
      out.push('-f', 'ba/b');
    }
    return out;
  }

  if (preset === 'bestvideo') {
    out.push('-f', 'bv*');
    return out;
  }

  // "best" — merged video+audio when ffmpeg is available, otherwise the best
  // single stream, falling back to video-only (many sites have no combined).
  out.push('-f', ffmpeg ? 'bv*+ba/b' : 'b/bv');
  return out;
}

/** Build the full yt-dlp argument list for a job. */
function buildArgs(job) {
  const settings = baseSettings();
  const opts = { ...settings, ...sanitizeOptions(job.options) };
  const ffmpeg = ytdlp.hasFfmpeg();
  const isPlaylist = !!job.playlist;

  const args = [
    ...ytdlp.globalArgs(),
    '--newline',
    '--no-colors',
    '--no-update',
    '--ignore-config',
    '--progress',
    '--progress-template',
    'download:PROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.status)s',
    '--print',
    'after_move:FILE %(filepath)s',
  ];

  args.push(...resolveFormatSelector(opts, ffmpeg));

  if (opts.playlist) {
    args.push('--yes-playlist');
    if (opts.playlistItems) args.push('--playlist-items', opts.playlistItems);
  } else {
    args.push('--no-playlist');
  }

  // Destination
  const outDir = path.resolve(opts.outputDir || PATHS.downloads);
  fs.mkdirSync(outDir, { recursive: true });
  const isDir = isPlaylist && (settings.usePlaylistsFolder !== false);
  const template = opts.filenameTemplate || '%(title).180B [%(id)s].%(ext)s';
  args.push('--paths', outDir);
  if (isDir) {
    args.push('-o', `%(playlist_title).100B/${template}`);
  } else {
    args.push('-o', template);
  }

  if (ffmpeg) {
    const container = opts.container || 'mp4';
    if (opts.preset === 'bestaudio') {
      if (container) args.push('--merge-output-format', container);
    } else if (opts.preset !== 'manual' || !ffmpeg) {
      args.push('--merge-output-format', container);
    }
  }

  // Subs
  if (opts.writeSubs) args.push('--write-subs');
  if (opts.autoSubs) args.push('--write-auto-subs');
  if (opts.writeSubs || opts.autoSubs) {
    args.push('--sub-langs', opts.subLangs || 'en.*,en');
    if (ffmpeg && opts.embedSubs) {
      args.push('--embed-subs');
      if ((opts.subFormat || 'srt') !== 'srt') args.push('--convert-subs', 'srt');
    } else if (ffmpeg && opts.subFormat && opts.subFormat !== 'srt') {
      args.push('--convert-subs', opts.subFormat);
    }
  }

  // Thumbnail + metadata
  if (opts.writeThumbnail) args.push('--write-thumbnail');
  if (ffmpeg && opts.embedThumbnail && opts.writeThumbnail) args.push('--embed-thumbnail');
  if (ffmpeg && opts.embedMetadata) args.push('--embed-metadata');
  if (ffmpeg && opts.embedChapters) args.push('--embed-chapters');

  // Cookies
  if (opts.cookiesFromBrowser) {
    args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  } else if (getSettings().cookiesEnabled && fs.existsSync(cookiesFile())) {
    args.push('--cookies', cookiesFile());
  }

  // Network / performance
  if (opts.rateLimit && /^\d+(\.\d+)?[KMG]?$/i.test(opts.rateLimit)) {
    args.push('--limit-rate', opts.rateLimit);
  }
  args.push('--concurrent-fragments', String(Math.min(16, Math.max(1, opts.concurrentFragments || 1))));
  args.push('--retries', '10');
  args.push('--fragment-retries', '10');

  if (opts.archive) args.push('--download-archive', PATHS.archive);

  args.push(job.url);
  return args;
}

const PROGRESS_RE = /^PROG\s+(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)/;
const FILE_RE = /^FILE\s+(.+)$/;

function parseLine(job, line) {
  const prog = PROGRESS_RE.exec(line);
  if (prog) {
    const [, pct, speed, eta, status] = prog;
    job.percent = clampPercent(pct);
    job.speed = speed && speed !== 'NA' ? speed : null;
    job.eta = eta && eta !== 'NA' ? eta : null;
    job.statusLine = status || '';
    return true;
  }
  const file = FILE_RE.exec(line);
  if (file) {
    job.files.push(file[1].trim());
    job.file = file[1].trim();
    return true;
  }
  return false;
}

function clampPercent(text) {
  if (!text) return 0;
  const n = parseFloat(String(text).replace('%', ''));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Spawn yt-dlp for a job. onLog receives every non-progress output line,
 * onExit receives the final state.
 */
function start(job, onLog, onExit, onProgress) {
  const bin = ytdlp.findYtdlp();
  if (!bin) {
    onLog('ERROR: yt-dlp not found. Install it with: pip install -U yt-dlp', 'stderr');
    onExit(1);
    return null;
  }
  const args = buildArgs(job);
  job.args = args.slice(bin.args.length);

  const child = spawn(bin.cmd, [...bin.args, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const consume = (line, stream) => {
    if (!line.trim()) return;
    if (parseLine(job, line)) {
      if (onProgress) onProgress();
    } else {
      onLog(line, stream);
    }
  };

  let buffer = { stdout: '', stderr: '' };
  const handle = (stream) => (chunk) => {
    buffer[stream] += chunk.toString('utf8');
    const lines = buffer[stream].split(/\r?\n|\r/);
    buffer[stream] = lines.pop() || '';
    for (const line of lines) consume(line, stream);
  };
  child.stdout.on('data', handle('stdout'));
  child.stderr.on('data', handle('stderr'));

  let closed = false;
  const finish = (code) => {
    if (closed) return;
    closed = true;
    for (const stream of ['stdout', 'stderr']) {
      const rest = buffer[stream];
      buffer[stream] = '';
      consume(rest, stream);
    }
    onExit(code === null ? -1 : code);
  };

  child.on('error', (err) => {
    onLog(`ERROR: ${err.message}`, 'stderr');
    finish(-1);
  });
  child.on('close', (code) => finish(code));

  return child;
}

module.exports = { start, buildArgs, sanitizeOptions, OPTION_SPEC, baseSettings };

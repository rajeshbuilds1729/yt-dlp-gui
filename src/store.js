'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PATHS = {
  root: ROOT,
  data: process.env.YTDLP_GUI_DATA_DIR || path.join(ROOT, 'data'),
  uploads: null,
  downloads: process.env.YTDLP_GUI_DOWNLOAD_DIR || path.join(ROOT, 'downloads'),
  settings: null,
  history: null,
  archive: null,
};
PATHS.uploads = path.join(PATHS.data, 'uploads');
PATHS.settings = path.join(PATHS.data, 'settings.json');
PATHS.history = path.join(PATHS.data, 'history.json');
PATHS.archive = path.join(PATHS.data, 'archive.txt');

function ensureDirs() {
  for (const dir of [PATHS.data, PATHS.uploads, PATHS.downloads]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(PATHS.archive)) fs.writeFileSync(PATHS.archive, '');
}

const DEFAULTS = {
  // destination
  outputDir: PATHS.downloads,
  usePlaylistsFolder: true,
  filenameTemplate: '%(title).180B [%(id)s].%(ext)s',
  // format
  preset: 'best', // best | bestvideo | bestaudio | height | manual
  maxHeight: 1080,
  videoFormatId: '',
  audioFormatId: '',
  container: 'mp4', // mp4 | mkv | webm
  audioFormat: 'mp3',
  audioQuality: '0',
  // extras
  writeSubs: false,
  autoSubs: false,
  subLangs: 'en.*,en',
  embedSubs: false,
  subFormat: 'srt',
  writeThumbnail: true,
  embedThumbnail: true,
  embedMetadata: true,
  embedChapters: true,
  // network / engine
  cookiesEnabled: true,
  cookiesFromBrowser: '',
  rateLimit: '',
  retries: 10,
  fragmentRetries: 10,
  concurrentFragments: 4,
  archiveEnabled: false,
  maxConcurrent: 2,
  // ui
  openBrowserOnStart: true,
  ffmpegPath: '',
};

const BOOL_KEYS = new Set([
  'usePlaylistsFolder', 'writeSubs', 'autoSubs', 'embedSubs', 'writeThumbnail',
  'embedThumbnail', 'embedMetadata', 'embedChapters', 'cookiesEnabled',
  'archiveEnabled', 'openBrowserOnStart',
]);
const NUM_KEYS = new Set([
  'maxHeight', 'audioQuality', 'retries', 'fragmentRetries', 'concurrentFragments', 'maxConcurrent',
]);
const STR_KEYS = new Set(Object.keys(DEFAULTS).filter((k) => !BOOL_KEYS.has(k) && !NUM_KEYS.has(k)));

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSettings(input) {
  const out = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return out;
  for (const key of BOOL_KEYS) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  for (const key of NUM_KEYS) {
    if (input[key] !== undefined) out[key] = clampNumber(input[key], NUM_RANGES[key][0], NUM_RANGES[key][1], DEFAULTS[key]);
  }
  for (const key of STR_KEYS) {
    if (typeof input[key] === 'string') out[key] = input[key].slice(0, 400);
  }
  out.preset = ['best', 'bestvideo', 'bestaudio', 'height', 'manual'].includes(out.preset) ? out.preset : 'best';
  out.container = ['mp4', 'mkv', 'webm'].includes(out.container) ? out.container : 'mp4';
  out.audioFormat = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'vorbis', 'aac'].includes(out.audioFormat) ? out.audioFormat : 'mp3';
  out.subFormat = ['srt', 'vtt', 'ass', 'lrc'].includes(out.subFormat) ? out.subFormat : 'srt';
  out.outputDir = out.outputDir.trim() || DEFAULTS.outputDir;
  out.cookiesFromBrowser = BRAWSERS.includes(out.cookiesFromBrowser) ? out.cookiesFromBrowser : '';
  if (out.rateLimit && !/^\d+(\.\d+)?[KMG]?$/i.test(out.rateLimit.trim())) out.rateLimit = '';
  if (out.filenameTemplate && /[\r\n]/.test(out.filenameTemplate)) out.filenameTemplate = DEFAULTS.filenameTemplate;
  if (!/%\(/.test(out.filenameTemplate)) out.filenameTemplate = DEFAULTS.filenameTemplate;
  return out;
}

const NUM_RANGES = {
  maxHeight: [144, 4320, 1080],
  audioQuality: [0, 10, 0],
  retries: [0, 100, 10],
  fragmentRetries: [0, 100, 10],
  concurrentFragments: [1, 16, 4],
  maxConcurrent: [1, 6, 2],
};

const BRAWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];

let cache = null;
let saveTimer = null;

function getSettings() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(PATHS.settings, 'utf8'));
  } catch { /* first run */ }
  cache = sanitizeSettings(raw);
  return cache;
}

function saveSettings(patch) {
  const next = sanitizeSettings({ ...getSettings(), ...(patch || {}) });
  cache = next;
  try {
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(PATHS.settings, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('[settings] save failed:', err.message);
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; }, 1000);
  if (saveTimer.unref) saveTimer.unref();
  return next;
}

let historyCache = null;

function getHistory() {
  if (historyCache) return historyCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(PATHS.history, 'utf8'));
    historyCache = Array.isArray(parsed) ? parsed : [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}

function addHistory(entry) {
  const list = getHistory();
  list.unshift({
    url: entry.url,
    title: entry.title,
    file: entry.file || null,
    status: entry.status,
    error: entry.error || null,
    durationMs: entry.durationMs || 0,
    at: Date.now(),
  });
  historyCache = list.slice(0, 300);
  try {
    fs.writeFileSync(PATHS.history, JSON.stringify(historyCache, null, 2));
  } catch (err) {
    console.error('[history] save failed:', err.message);
  }
  return historyCache;
}

function clearHistory() {
  historyCache = [];
  try { fs.writeFileSync(PATHS.history, '[]'); } catch { /* ignore */ }
  return historyCache;
}

function cookiesFile() {
  return path.join(PATHS.uploads, 'cookies.txt');
}

module.exports = {
  PATHS,
  DEFAULTS,
  BRAWSERS,
  ensureDirs,
  getSettings,
  saveSettings,
  sanitizeSettings,
  getHistory,
  addHistory,
  clearHistory,
  cookiesFile,
};

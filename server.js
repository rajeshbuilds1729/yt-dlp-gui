'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const store = require('./src/store');
const ytdlp = require('./src/ytdlp');
const queue = require('./src/queue');

const app = express();
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';

store.ensureDirs();

app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '8mb' }));

// ---------------------------------------------------------------- helpers

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value) return null;
  if (value.length > 4096) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(value)) return null;
    value = `https://${value}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.toString();
}

function fail(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function withinDir(target, base) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------- system

app.get('/api/system', (req, res) => {
  const info = ytdlp.systemInfo();
  const cookies = store.cookiesFile();
  res.json({
    ok: true,
    ...info,
    cookies: {
      path: cookies,
      present: fs.existsSync(cookies),
      size: fs.existsSync(cookies) ? fs.statSync(cookies).size : 0,
    },
    settings: store.getSettings(),
    paused: queue.paused,
    queue: queue.list(),
    history: store.getHistory(),
  });
});

// ---------------------------------------------------------------- settings

app.get('/api/settings', (req, res) => {
  res.json({ ok: true, settings: store.getSettings() });
});

app.post('/api/settings', (req, res) => {
  const next = store.saveSettings(req.body || {});
  if (req.body && 'ffmpegPath' in req.body) ytdlp.resetFfmpegCache();
  res.json({ ok: true, settings: next, system: ytdlp.systemInfo() });
});

app.get('/api/queue/pause', (req, res) => {
  res.json({ ok: true, paused: queue.setPaused(req.query.value !== '0' && req.query.value !== 'false') });
});

// ---------------------------------------------------------------- probe

function shapeFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  return formats
    .filter((f) => f && f.format_id)
    .map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      height: f.height || null,
      fps: f.fps || null,
      vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
      acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
      filesize: f.filesize || f.filesize_approx || null,
      tbr: f.tbr || null,
      abr: f.abr || null,
      note: f.format_note || '',
      protocol: f.protocol || '',
      hasVideo: !!(f.vcodec && f.vcodec !== 'none'),
      hasAudio: !!(f.acodec && f.acodec !== 'none'),
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
}

app.post('/api/probe', async (req, res) => {
  const url = normalizeUrl(req.body && req.body.url);
  if (!url) return fail(res, 400, 'That does not look like a valid http(s) URL.');
  const cookiesFromBrowser = (req.body && req.body.cookiesFromBrowser) || store.getSettings().cookiesFromBrowser || '';
  try {
    const info = await ytdlp.runProbe(url, { cookiesFromBrowser });
    res.json({
      ok: true,
      info: {
        id: info.id,
        title: info.title,
        uploader: info.uploader || info.channel || '',
        duration: info.duration || 0,
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null),
        isLive: !!info.is_live,
        extractor: info.extractor_key || info.extractor || '',
        webpageUrl: info.webpage_url || url,
        formats: shapeFormats(info),
      },
    });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

app.post('/api/playlist', async (req, res) => {
  const url = normalizeUrl(req.body && req.body.url);
  if (!url) return fail(res, 400, 'That does not look like a valid http(s) URL.');
  const cookiesFromBrowser = (req.body && req.body.cookiesFromBrowser) || store.getSettings().cookiesFromBrowser || '';
  const limit = Math.min(500, Math.max(1, Number(req.body && req.body.limit) || 200));
  try {
    const items = await ytdlp.runPlaylist(url, { cookiesFromBrowser, limit });
    res.json({
      ok: true,
      count: items.length,
      items: items.map((it, i) => ({
        index: it.playlist_index ?? i + 1,
        id: it.id,
        title: it.title || it.id,
        duration: it.duration || 0,
        uploader: it.uploader || it.channel || '',
        thumbnail: it.thumbnail || null,
        url: normalizeUrl(it.webpage_url || it.original_url || it.url) || url,
      })),
    });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

// ---------------------------------------------------------------- queue

app.get('/api/queue', (req, res) => {
  res.json({ ok: true, jobs: queue.list(), paused: queue.paused });
});

app.post('/api/queue', (req, res) => {
  const body = req.body || {};
  const entries = Array.isArray(body.items) ? body.items : [body];
  const jobs = [];
  const errors = [];
  for (const entry of entries) {
    const url = normalizeUrl(entry && entry.url);
    if (!url) {
      errors.push({ title: (entry && entry.title) || 'unknown', error: 'invalid url' });
      continue;
    }
    jobs.push(queue.add({
      url,
      title: entry.title,
      uploader: entry.uploader,
      thumbnail: entry.thumbnail,
      duration: entry.duration,
      playlist: !!entry.playlist,
      playlistTitle: entry.playlistTitle,
      options: entry.options,
    }));
  }
  res.json({ ok: errors.length === 0, jobs, errors });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = queue.find(req.params.id);
  if (!job) return fail(res, 404, 'Job not found.');
  res.json({ ok: true, job: { ...queue.publicJob(job), log: job.log } });
});

for (const action of ['cancel', 'pause', 'resume', 'remove']) {
  app.post(`/api/jobs/:id/${action}`, (req, res) => {
    const ok = queue[action](req.params.id);
    if (!ok) return fail(res, 400, `Cannot ${action} a job in that state.`);
    res.json({ ok: true });
  });
}

app.post('/api/queue/clear-finished', (req, res) => {
  res.json({ ok: true, removed: queue.clearFinished() });
});

app.get('/api/history', (req, res) => {
  res.json({ ok: true, history: store.getHistory() });
});

app.post('/api/history/clear', (req, res) => {
  store.clearHistory();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- cookies

app.post('/api/cookies', (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text || !/# Netscape HTTP Cookie File/i.test(text)) {
    return fail(res, 400, 'That does not look like a Netscape-format cookies.txt file.');
  }
  const file = store.cookiesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  res.json({ ok: true, size: fs.statSync(file).size });
});

app.delete('/api/cookies', (req, res) => {
  const file = store.cookiesFile();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- files

function listFiles(dir) {
  const out = [];
  const walk = (current, depth) => {
    if (depth > 3 || out.length >= 500) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 500) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size === 0) continue;
        out.push({
          name: entry.name,
          path: full,
          rel: path.relative(dir, full),
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

app.get('/api/files', (req, res) => {
  const dir = store.getSettings().outputDir || store.PATHS.downloads;
  res.json({ ok: true, dir, files: listFiles(dir) });
});

app.post('/api/open', (req, res) => {
  const target = (req.body && req.body.path) || '';
  const base = store.getSettings().outputDir || store.PATHS.downloads;
  if (!target || !withinDir(target, base)) return fail(res, 400, 'Path is outside the download folder.');
  if (!fs.existsSync(target)) return fail(res, 404, 'File no longer exists.');
  try {
    const { spawn } = require('child_process');
    const child = ytdlp.isWin
      ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* ignore */ });
    child.unref();
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

app.get('/api/open-folder', (req, res) => {
  const base = store.getSettings().outputDir || store.PATHS.downloads;
  try {
    const { spawn } = require('child_process');
    const child = ytdlp.isWin
      ? spawn('explorer.exe', [base], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('xdg-open', [base], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    res.json({ ok: true });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ---------------------------------------------------------------- events (SSE)

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onChange = (job) => send('job', job);
  const onLog = (payload) => send('log', payload);
  const onRemoved = (payload) => send('removed', payload);

  queue.on('change', onChange);
  queue.on('log', onLog);
  queue.on('removed', onRemoved);

  send('hello', { jobs: queue.list(), paused: queue.paused });

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    queue.off('change', onChange);
    queue.off('log', onLog);
    queue.off('removed', onRemoved);
  });
});

// ---------------------------------------------------------------- static

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((req, res) => fail(res, 404, 'Not found.'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  fail(res, 500, err.message || 'Internal error');
});

const server = app.listen(PORT, HOST, () => {
  const info = ytdlp.systemInfo();
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  yt-dlp GUI');
  console.log(`  ${url}`);
  console.log('');
  console.log(`  yt-dlp : ${info.ytdlpFound ? info.ytdlpVersion : 'NOT FOUND — install with: pip install -U yt-dlp'}`);
  console.log(`  ffmpeg : ${info.ffmpegFound ? info.ffmpegPath : 'not found (merging/post-processing disabled)'}`);
  console.log(`  output : ${store.getSettings().outputDir}`);
  console.log('');

  if (store.getSettings().openBrowserOnStart) openBrowser(url);
});

function openBrowser(url) {
  try {
    const { spawn } = require('child_process');
    const cmd = ytdlp.isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = ytdlp.isWin ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* ignore */ }
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down, stopping active downloads...');
  queue.killAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;

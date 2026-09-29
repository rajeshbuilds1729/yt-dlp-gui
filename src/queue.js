'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const downloader = require('./downloader');
const ytdlp = require('./ytdlp');
const { getSettings, addHistory } = require('./store');

const MAX_LOG_LINES = 400;
const ACTIVE = new Set(['queued', 'running', 'paused']);

class Queue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.children = new Map(); // id -> child process
    this.paused = false;
  }

  get concurrency() {
    const n = Number(getSettings().maxConcurrent);
    return Math.min(6, Math.max(1, Number.isFinite(n) ? n : 2));
  }

  list() {
    return this.jobs.map(publicJob);
  }

  find(id) {
    return this.jobs.find((j) => j.id === id);
  }

  add(input) {
    const job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url: input.url,
      title: input.title || input.url,
      uploader: input.uploader || '',
      thumbnail: input.thumbnail || null,
      duration: input.duration || 0,
      playlist: !!input.playlist,
      playlistTitle: input.playlistTitle || '',
      options: downloader.sanitizeOptions(input.options),
      status: 'queued',
      percent: 0,
      speed: null,
      eta: null,
      files: [],
      file: null,
      log: [],
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.unshift(job);
    if (this.jobs.length > 200) this.jobs.length = 200;
    this.emit('change', publicJob(job));
    this.pump();
    return publicJob(job);
  }

  addMany(inputs) {
    return inputs.map((i) => this.add(i));
  }

  appendLog(job, line, stream) {
    if (job.log.length >= MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES + 1);
    job.log.push({ t: Date.now(), s: stream === 'stderr' ? 'e' : 'o', m: line.slice(0, 2000) });
    this.emit('log', { id: job.id, line: job.log[job.log.length - 1] });
  }

  pump() {
    if (this.paused) return;
    const limit = this.concurrency;
    let running = this.jobs.filter((j) => j.status === 'running').length;
    if (running >= limit) return;

    for (const job of this.jobs) {
      if (running >= limit) break;
      if (job.status !== 'queued') continue;
      this.run(job);
      running += 1;
    }
  }

  run(job) {
    job.status = 'running';
    job.percent = 0;
    job.error = null;
    job.startedAt = job.startedAt || Date.now();
    job.speed = null;
    job.eta = null;
    this.emit('change', publicJob(job));

    // Throttle progress broadcasts: yt-dlp emits a line several times a second,
    // and each one would otherwise be pushed to every connected browser.
    let lastEmit = 0;
    const emitProgress = () => {
      const now = Date.now();
      if (now - lastEmit < 400) return;
      lastEmit = now;
      this.emit('change', publicJob(job));
    };

    const child = downloader.start(
      job,
      (line, stream) => this.appendLog(job, line, stream),
      (code) => this.finish(job, code),
      emitProgress,
    );

    if (!child) return;
    this.children.set(job.id, child);
  }

  finish(job, code) {
    this.children.delete(job.id);
    job.finishedAt = Date.now();
    job.percent = code === 0 ? 100 : job.percent;
    job.speed = null;
    job.eta = null;

    if (code === 0) {
      job.status = 'done';
    } else if (job.status === 'cancelling') {
      job.status = 'cancelled';
    } else if (job.status === 'pausing') {
      job.status = 'paused';
    } else {
      job.status = 'error';
      const tail = [...job.log].reverse().find((l) => l.s === 'e' && /error|unable|failed|not available|403|404/i.test(l.m));
      job.error = tail ? tail.m.slice(0, 300) : `yt-dlp exited with code ${code}`;
    }
    if (job.status !== 'cancelled') {
      addHistory({
        url: job.url,
        title: job.title,
        file: job.file,
        status: job.status,
        error: job.error,
        durationMs: job.finishedAt - (job.startedAt || job.finishedAt),
      });
    }
    this.emit('change', publicJob(job));
    this.pump();
  }

  cancel(id) {
    const job = this.find(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.emit('change', publicJob(job));
      return true;
    }
    if (job.status !== 'running') return false;
    job.status = 'cancelling';
    this.appendLog(job, 'Cancelled by user.', 'o');
    this.emit('change', publicJob(job));
    const child = this.children.get(id);
    if (child) ytdlp.killTree(child);
    else this.finish(job, -1);
    return true;
  }

  /**
   * yt-dlp has no pause signal. Pausing terminates the process but keeps the
   * .part files, and resuming restarts yt-dlp with --continue so it picks up
   * where it left off.
   */
  pause(id) {
    const job = this.find(id);
    if (!job || job.status !== 'running') return false;
    job.status = 'pausing';
    this.appendLog(job, 'Pausing — partial file will be kept for resume.', 'o');
    this.emit('change', publicJob(job));
    const child = this.children.get(id);
    if (child) ytdlp.killTree(child);
    else this.finish(job, -1);
    return true;
  }

  resume(id) {
    const job = this.find(id);
    if (!job) return false;
    if (job.status === 'queued' || job.status === 'running') return true;
    if (!ACTIVE.has(job.status) && job.status !== 'error') return false;
    job.status = 'queued';
    job.percent = 0;
    job.error = null;
    job.finishedAt = null;
    this.appendLog(job, 'Resuming download.', 'o');
    this.emit('change', publicJob(job));
    this.pump();
    return true;
  }

  remove(id) {
    const job = this.find(id);
    if (!job) return false;
    if (job.status === 'running') this.cancel(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emit('removed', { id });
    return true;
  }

  clearFinished() {
    const isActive = (j) => ACTIVE.has(j.status) || j.status === 'cancelling' || j.status === 'pausing';
    const removed = this.jobs.filter((j) => !isActive(j));
    this.jobs = this.jobs.filter((j) => isActive(j));
    for (const job of removed) this.emit('removed', { id: job.id });
    return removed.length;
  }

  setPaused(value) {
    this.paused = !!value;
    if (!this.paused) this.pump();
    return this.paused;
  }

  killAll() {
    for (const [id] of this.children) {
      const child = this.children.get(id);
      if (child) ytdlp.killTree(child);
    }
  }
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    uploader: job.uploader,
    thumbnail: job.thumbnail,
    duration: job.duration,
    playlist: job.playlist,
    playlistTitle: job.playlistTitle,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    file: job.file,
    files: job.files,
    error: job.error,
    logCount: job.log.length,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

module.exports = new Queue();
module.exports.publicJob = publicJob;

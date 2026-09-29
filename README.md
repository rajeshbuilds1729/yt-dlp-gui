# yt-dlp GUI

A local web interface for [yt-dlp](https://github.com/yt-dlp/yt-dlp). Paste a URL, preview the
available formats, and queue downloads with live progress.

## Requirements

- **Node.js 18+** — runs the server
- **yt-dlp** — `pip install -U yt-dlp`
- **ffmpeg** — required for merging video+audio, audio extraction, thumbnails, and metadata.
  Without it the app still works but only for sources that offer a single combined stream.
- **A JavaScript runtime** (Node or Deno) — YouTube now requires one; Node is used automatically
  since you already have it installed.

## Run

```bash
npm install
npm start
```

Then open http://127.0.0.1:4321. Your browser opens automatically.

## Features

- **Format picker** — see every available format with resolution, codec and size, or use the
  presets (best, capped resolution, audio only, manual pick).
- **Playlists** — detected automatically, with per-item selection.
- **Live progress** — percentage, speed, ETA and a full log streamed over SSE.
- **Queue** — multiple downloads, configurable concurrency, pause / resume / cancel.
- **Cookies** — upload a `cookies.txt` or pull cookies straight from a browser profile.
- **Subtitles, thumbnails and metadata** — optional, embedded into the output file.
- **Archive mode** — skip anything already downloaded.

## How pause/resume works

yt-dlp has no pause signal. Pausing terminates the process but keeps the `.part` file; resuming
restarts yt-dlp, which continues from where it stopped rather than re-downloading.

## Configuration

Set `PORT` and `HOST` to change the bind address. Output folder, format defaults and other options
are saved from the UI to `data/settings.json` and apply to all new downloads.

## Security note

The server binds to `127.0.0.1` and is intended for local use. It has no authentication, so do not
expose it to a network you don't control.

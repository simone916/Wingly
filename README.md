# Wingly

A self-hosted media server for your own movies and shows — open source, no account,
no cloud, no paid tier. The "smart" features run on **an AI you bring yourself**:
a Claude or OpenAI API key, any OpenAI-compatible service, or a free local model via Ollama.

> Status: early MVP. It scans, plays, transcodes, tracks progress and talks to your AI.
> See [Roadmap](#roadmap) for what is not there yet.

## What you get

- **Libraries** — point it at folders of movies or TV shows; filenames like
  `The.Matrix.1999.1080p.BluRay.x264.mkv` or `Show/Season 1/S01E02.mkv` are understood.
- **Plays in the browser** — direct play when the browser can handle the file, otherwise
  ffmpeg remuxes/transcodes on the fly (seeking included). No "pass" needed for transcoding.
- **Subtitles** — sidecar `.srt`/`.vtt` and embedded text tracks.
- **Resume, watched state, next episode** — per person, with multiple local accounts.
- **Artwork without a metadata account** — `poster.jpg`/`folder.jpg` next to your files if
  present, otherwise a frame grabbed from the video.
- **✨ Bring-your-own AI** (optional — everything above works without it)
  - *Identify & describe*: cleans up messy titles and writes a short synopsis and genres.
  - *Ask your library*: "something funny under two hours I haven't seen" → picks from what you own.

## Quick start

Needs [Node.js](https://nodejs.org) 22.5+ and `ffmpeg` on your PATH.

```bash
npm install
npm start          # → http://localhost:8686
```

Open the page, create the admin account, then add a library in **Settings**.

With Docker: edit the media path in `docker-compose.yml`, then `docker compose up -d`.

## Connecting your AI

**Settings → Your AI.** Pick one:

| Provider | What you need |
|---|---|
| Claude (Anthropic API) | An API key from the [Claude Console](https://platform.claude.com). Default model `claude-opus-5-5`; type another model ID to change it. |
| OpenAI | An OpenAI API key and a chat model name. |
| Ollama | Nothing but a running [Ollama](https://ollama.com) — free and fully local. |
| Other (OpenAI-compatible) | Base URL + key for LM Studio, OpenRouter, Groq, llama.cpp, etc. |

Good to know:

- These are **API keys, billed per use by the provider** — a Claude.ai or ChatGPT *chat
  subscription* does not include API access and cannot be plugged in. Ollama is the zero-cost route.
- The key is stored in Wingly's local database and never sent to the browser.
- When you use an AI feature, your library's **title list** (not your files) is sent to the
  provider you chose. With Ollama nothing leaves your machine.
- AI-written descriptions come from the model's memory and are labelled as such; they can be wrong.

You can also configure by environment: `WINGLY_AI_PROVIDER`, `WINGLY_AI_API_KEY`,
`WINGLY_AI_MODEL`, `WINGLY_AI_BASE_URL` (or just `ANTHROPIC_API_KEY`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8686` / `0.0.0.0` | Where to listen |
| `WINGLY_DATA` | `./data` | Database and thumbnail cache |
| `WINGLY_SCAN_MINUTES` | `60` | Automatic rescan interval (`0` = off) |
| `WINGLY_MAX_HEIGHT` | `1080` | Max resolution when transcoding |
| `FFMPEG_PATH` / `FFPROBE_PATH` | from PATH | Custom ffmpeg binaries |

Wingly speaks plain HTTP. To reach it from outside your home, put it behind a reverse proxy
with HTTPS (Caddy, nginx, Tailscale…) rather than exposing the port directly.

## Roadmap

- Adaptive (HLS) streaming and hardware-accelerated transcoding
- Posters and cast from free metadata sources (TMDB, TVmaze)
- Music and photo libraries
- AI subtitle translation, "skip intro" detection
- Native TV/mobile clients, casting, offline downloads

## Development

```bash
npm run dev    # restart on change
npm test       # filename parser + subtitle tests
```

No build step: `server/` is plain Node (built-in HTTP and SQLite), `web/` is plain JS.
The only runtime dependency is the Anthropic SDK.

## Legal

Wingly is an independent project, not affiliated with Plex or any other media server.
It plays files you already have; it does not provide or locate content.

MIT licensed.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, THUMB_DIR } from './db.js';
import { parseMedia, VIDEO_EXT } from './parse.js';

const run = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export const scanState = { running: false, library: null, done: 0, total: 0, lastError: null, finishedAt: null };

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip, don't abort the scan
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      if (/\b(sample|trailer)\b/i.test(e.name)) continue;
      yield full;
    }
  }
}

export async function probe(file) {
  const { stdout } = await run(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
  let n = -1;
  const subtitles = [];
  for (const s of streams) {
    if (s.codec_type !== 'subtitle') continue;
    n += 1; // index among subtitle streams (ffmpeg's 0:s:N)
    if (!TEXT_SUBS.has(s.codec_name)) continue; // image subs (PGS/VobSub) need burn-in: not supported yet
    subtitles.push({ source: 'embedded', index: n, lang: s.tags?.language || 'und', label: s.tags?.title || null });
  }
  return {
    duration: Number(info.format?.duration) || null,
    container: (info.format?.format_name || '').split(',')[0] || null,
    video_codec: video?.codec_name || null,
    audio_codec: audio?.codec_name || null,
    width: video?.width || null,
    height: video?.height || null,
    subtitles,
  };
}

async function sidecarSubs(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  const out = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!name.startsWith(stem) || !/\.(srt|vtt)$/i.test(name)) continue;
    const tag = name.slice(stem.length).replace(/\.(srt|vtt)$/i, '').replace(/^\./, '');
    out.push({ source: 'file', file: name, lang: tag || 'und', label: null });
  }
  return out;
}

export async function scanLibrary(lib) {
  // If the root is missing (unmounted drive), leave existing rows alone.
  if (!fs.existsSync(lib.path)) throw new Error(`Library folder not found: ${lib.path}`);

  const files = [];
  for await (const f of walk(lib.path)) files.push(f);
  scanState.total += files.length;

  const existing = new Map(
    db.prepare('SELECT id, path, size, mtime FROM items WHERE library_id = ?').all(lib.id).map((r) => [r.path, r]),
  );
  const insert = db.prepare(
    `INSERT INTO items (library_id, kind, path, size, mtime, title, year, show_title, season, episode,
       duration, container, video_codec, audio_codec, width, height, subtitles, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const refresh = db.prepare(
    `UPDATE items SET size = ?, mtime = ?, duration = ?, container = ?, video_codec = ?, audio_codec = ?,
       width = ?, height = ?, subtitles = ? WHERE id = ?`,
  );

  for (const file of files) {
    try {
      const st = await fsp.stat(file);
      const mtime = Math.floor(st.mtimeMs);
      const prev = existing.get(file);
      existing.delete(file);
      if (prev && prev.size === st.size && prev.mtime === mtime) continue;

      const p = await probe(file);
      const subs = JSON.stringify([...p.subtitles, ...(await sidecarSubs(file))]);
      if (prev) {
        refresh.run(st.size, mtime, p.duration, p.container, p.video_codec, p.audio_codec, p.width, p.height, subs, prev.id);
        fs.rm(path.join(THUMB_DIR, `${prev.id}.jpg`), { force: true }, () => {});
      } else {
        const m = parseMedia(path.relative(path.dirname(lib.path), file), lib.type);
        if (m.kind === 'episode') {
          db.prepare('INSERT OR IGNORE INTO shows (title, year) VALUES (?, ?)').run(m.showTitle, m.year ?? null);
        }
        insert.run(
          lib.id, m.kind, file, st.size, mtime, m.title, m.year ?? null,
          m.showTitle ?? null, m.season ?? null, m.episode ?? null,
          p.duration, p.container, p.video_codec, p.audio_codec, p.width, p.height, subs, Date.now(),
        );
      }
    } catch (e) {
      scanState.lastError = `${path.basename(file)}: ${e.message.split('\n')[0]}`;
    } finally {
      scanState.done += 1;
    }
  }

  // Whatever is left in `existing` no longer exists on disk.
  const del = db.prepare('DELETE FROM items WHERE id = ?');
  for (const row of existing.values()) {
    del.run(row.id);
    fs.rm(path.join(THUMB_DIR, `${row.id}.jpg`), { force: true }, () => {});
  }
}

export async function scanAll() {
  if (scanState.running) return;
  Object.assign(scanState, { running: true, done: 0, total: 0, lastError: null });
  try {
    for (const lib of db.prepare('SELECT * FROM libraries').all()) {
      scanState.library = lib.name;
      try {
        await scanLibrary(lib);
      } catch (e) {
        scanState.lastError = e.message;
      }
    }
  } finally {
    db.exec('DELETE FROM shows WHERE title NOT IN (SELECT show_title FROM items WHERE show_title IS NOT NULL)');
    Object.assign(scanState, { running: false, library: null, finishedAt: Date.now() });
  }
}

const POSTER_NAMES = ['poster', 'folder', 'cover'];
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function findLocalArt(dir, stems) {
  for (const stem of stems) {
    for (const ext of IMG_EXT) {
      const f = path.join(dir, stem + ext);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

/** Local artwork next to the file if present, otherwise a frame grabbed with ffmpeg (cached). */
export async function thumbnailFor(item, { preferShowArt = false } = {}) {
  const dir = path.dirname(item.path);
  const stem = path.basename(item.path, path.extname(item.path));
  let art;
  if (item.kind === 'movie') art = findLocalArt(dir, [stem, ...POSTER_NAMES]);
  else if (preferShowArt) art = findLocalArt(path.dirname(dir), POSTER_NAMES) || findLocalArt(dir, POSTER_NAMES);
  else art = findLocalArt(dir, [stem]); // episode-specific still only
  if (art) return art;

  const out = path.join(THUMB_DIR, `${item.id}.jpg`);
  if (fs.existsSync(out)) return out;
  const at = Math.max(1, Math.min((item.duration || 60) * 0.2, 600));
  const tmp = `${out}.${process.pid}.tmp.jpg`;
  await run(FFMPEG, [
    '-v', 'error', '-ss', String(at), '-i', item.path, '-frames:v', '1',
    '-vf', 'scale=480:-2', '-q:v', '4', '-y', tmp,
  ]);
  await fsp.rename(tmp, out);
  return out;
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG } from './scanner.js';
import { srtToVtt, shiftVtt } from './subtitles.js';

const run = promisify(execFile);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
export const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

const DIRECT_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/** Can a typical browser play the file untouched? Otherwise we remux/transcode on the fly. */
export function playbackPlan(item) {
  const direct =
    DIRECT_EXT.has(path.extname(item.path).toLowerCase()) &&
    DIRECT_VIDEO.has(item.video_codec) &&
    (!item.audio_codec || DIRECT_AUDIO.has(item.audio_codec));
  return {
    mode: direct ? 'direct' : 'transcode',
    // In transcode mode we still copy streams that are already browser-friendly (cheap remux).
    video: item.video_codec === 'h264' ? 'copy' : 'transcode',
    audio: item.audio_codec === 'aac' ? 'copy' : 'transcode',
  };
}

/** Static file with HTTP range support (seeking in direct play). */
export function sendFile(req, res, file, { cache = false } = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const headers = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache ? 'private, max-age=86400' : 'no-store',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = st.size - 1;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), end);
    } else {
      start = Math.max(0, st.size - Number(m[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
  }
  if (req.method === 'HEAD' || st.size === 0) return void res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Live fragmented-MP4 stream starting at `start` seconds. The client re-requests to seek. */
export function sendTranscode(req, res, item, start = 0) {
  const plan = playbackPlan(item);
  const maxH = Number(process.env.WINGLY_MAX_HEIGHT) || 1080;
  const args = ['-v', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', item.path, '-map', '0:v:0', '-map', '0:a:0?', '-sn');
  if (plan.video === 'copy') args.push('-c:v', 'copy');
  else {
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-vf', `scale=-2:'min(${maxH},ih)'`, '-g', '48',
    );
  }
  if (plan.audio === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  ff.on('error', (e) => {
    console.error('ffmpeg failed to start:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  ff.on('close', (code) => {
    if (code && !res.destroyed && err) console.error(`ffmpeg exited ${code}: ${err.trim()}`);
    res.end();
  });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL')); // viewer left or seeked
}

export async function subtitleVtt(item, sub, start = 0) {
  let vtt;
  if (sub.source === 'file') {
    // `sub.file` came from our own directory listing at scan time; basename() keeps it inside that folder.
    const file = path.join(path.dirname(item.path), path.basename(sub.file));
    const text = await fs.promises.readFile(file, 'utf8');
    vtt = /\.vtt$/i.test(file) ? text : srtToVtt(text);
  } else {
    const { stdout } = await run(
      FFMPEG,
      ['-v', 'error', '-nostdin', '-i', item.path, '-map', `0:s:${Number(sub.index)}`, '-f', 'webvtt', 'pipe:1'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    vtt = stdout;
  }
  return shiftVtt(vtt, start);
}

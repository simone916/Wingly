import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, setSetting } from './db.js';
import * as auth from './auth.js';
import { httpError } from './auth.js';
import { scanAll, scanState, thumbnailFor } from './scanner.js';
import { playbackPlan, sendFile, sendTranscode, subtitleVtt } from './stream.js';
import { PROVIDERS, publicAIConfig, getAIConfig, completeJSON } from './ai/index.js';
import { ask, enrichLibrary, enrichState } from './ai/features.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT) || 8686;
const HOST = process.env.HOST || '0.0.0.0';

// ── tiny router ───────────────────────────────────────────────────────────────
const routes = [];
function route(method, pattern, access, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, access, handler });
}
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw httpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
const genres = (s) => { try { return JSON.parse(s); } catch { return []; } };
const getItem = (id) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
  if (!item) throw httpError(404, 'Not found');
  return item;
};
const card = (r) => ({
  id: r.id, kind: r.kind, title: r.title, year: r.year, duration: r.duration,
  showTitle: r.show_title, showId: r.show_id ?? null, season: r.season, episode: r.episode,
  position: r.position || 0, watched: !!r.watched,
});
const ITEM_COLS = `i.*, p.position, p.watched, (SELECT id FROM shows WHERE title = i.show_title) AS show_id`;
const WITH_PROGRESS = `FROM items i LEFT JOIN progress p ON p.item_id = i.id AND p.user_id = ?`;

// ── session ───────────────────────────────────────────────────────────────────
route('GET', '/api/status', 'public', (ctx) => ({
  needsSetup: !auth.hasUsers(),
  user: ctx.user,
  ai: publicAIConfig(),
}));
route('POST', '/api/setup', 'public', (ctx) => {
  if (auth.hasUsers()) throw httpError(403, 'Setup is already complete');
  const id = auth.createUser(ctx.body.username, ctx.body.password, true);
  auth.startSession(ctx.res, id, ctx.secure);
  return { ok: true };
});
route('POST', '/api/login', 'public', (ctx) => {
  auth.startSession(ctx.res, auth.login(ctx.body.username, ctx.body.password), ctx.secure);
  return { ok: true };
});
route('POST', '/api/logout', 'public', (ctx) => (auth.endSession(ctx.req, ctx.res), { ok: true }));

// ── browsing ──────────────────────────────────────────────────────────────────
const SHOW_LIST = `SELECT s.id, s.title, s.year, COUNT(i.id) AS episodes, MAX(i.added_at) AS added_at
  FROM shows s JOIN items i ON i.show_title = s.title GROUP BY s.id`;

route('GET', '/api/home', 'user', (ctx) => ({
  continueWatching: db.prepare(
    `SELECT ${ITEM_COLS} ${WITH_PROGRESS} WHERE p.watched = 0 AND p.position > 30 ORDER BY p.updated_at DESC LIMIT 12`,
  ).all(ctx.user.id).map(card),
  recentMovies: db.prepare(
    `SELECT ${ITEM_COLS} ${WITH_PROGRESS} WHERE i.kind = 'movie' ORDER BY i.added_at DESC, i.id DESC LIMIT 18`,
  ).all(ctx.user.id).map(card),
  recentShows: db.prepare(`${SHOW_LIST} ORDER BY added_at DESC LIMIT 18`).all(),
  counts: db.prepare(
    `SELECT (SELECT COUNT(*) FROM items WHERE kind = 'movie') AS movies,
            (SELECT COUNT(*) FROM shows) AS shows, (SELECT COUNT(*) FROM libraries) AS libraries`,
  ).get(),
}));
route('GET', '/api/movies', 'user', (ctx) =>
  db.prepare(`SELECT ${ITEM_COLS} ${WITH_PROGRESS} WHERE i.kind = 'movie' ORDER BY i.title COLLATE NOCASE`)
    .all(ctx.user.id).map(card));
route('GET', '/api/shows', 'user', () => db.prepare(`${SHOW_LIST} ORDER BY s.title COLLATE NOCASE`).all());
route('GET', '/api/search', 'user', (ctx) => {
  const q = `%${(ctx.query.get('q') || '').trim().replace(/[%_\\]/g, '\\$&')}%`;
  return {
    movies: db.prepare(
      `SELECT ${ITEM_COLS} ${WITH_PROGRESS} WHERE i.kind = 'movie' AND i.title LIKE ? ESCAPE '\\' ORDER BY i.title LIMIT 40`,
    ).all(ctx.user.id, q).map(card),
    shows: db.prepare(`${SHOW_LIST} HAVING s.title LIKE ? ESCAPE '\\' ORDER BY s.title LIMIT 40`).all(q),
  };
});
route('GET', '/api/shows/:id', 'user', (ctx) => {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(Number(ctx.params.id));
  if (!show) throw httpError(404, 'Not found');
  const episodes = db.prepare(
    `SELECT ${ITEM_COLS} ${WITH_PROGRESS} WHERE i.show_title = ? ORDER BY i.season, i.episode, i.id`,
  ).all(ctx.user.id, show.title).map(card);
  return { id: show.id, title: show.title, year: show.year, overview: show.overview, genres: genres(show.genres),
    aiEnriched: !!show.ai_enriched, episodes };
});
route('GET', '/api/items/:id', 'user', (ctx) => {
  const r = db.prepare(`SELECT ${ITEM_COLS} ${WITH_PROGRESS} WHERE i.id = ?`).get(ctx.user.id, Number(ctx.params.id));
  if (!r) throw httpError(404, 'Not found');
  let next = null;
  if (r.kind === 'episode') {
    next = db.prepare(
      `SELECT id, title, season, episode FROM items WHERE show_title = ? AND (season > ? OR (season = ? AND episode > ?))
       ORDER BY season, episode LIMIT 1`,
    ).get(r.show_title, r.season, r.season, r.episode) || null;
  }
  return {
    ...card(r), overview: r.overview, genres: genres(r.genres), aiEnriched: !!r.ai_enriched,
    file: path.basename(r.path), size: r.size, width: r.width, height: r.height,
    videoCodec: r.video_codec, audioCodec: r.audio_codec,
    subtitles: genres(r.subtitles).map((s, n) => ({ n, lang: s.lang, label: s.label })),
    playback: playbackPlan(r), next,
  };
});
route('PUT', '/api/items/:id/progress', 'user', (ctx) => {
  const item = getItem(ctx.params.id);
  const position = Math.max(0, Number(ctx.body.position) || 0);
  const watched = typeof ctx.body.watched === 'boolean'
    ? ctx.body.watched
    : !!item.duration && position >= item.duration * 0.92;
  db.prepare(
    `INSERT INTO progress (user_id, item_id, position, watched, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, item_id) DO UPDATE SET position = excluded.position, watched = excluded.watched,
       updated_at = excluded.updated_at`,
  ).run(ctx.user.id, item.id, watched ? 0 : position, watched ? 1 : 0, Date.now());
  return { ok: true, watched };
});

// ── media ─────────────────────────────────────────────────────────────────────
route('GET', '/api/items/:id/thumb', 'user', async (ctx) => {
  sendFile(ctx.req, ctx.res, await thumbnailFor(getItem(ctx.params.id)), { cache: true });
});
route('GET', '/api/shows/:id/thumb', 'user', async (ctx) => {
  const ep = db.prepare(
    `SELECT i.* FROM items i JOIN shows s ON s.title = i.show_title WHERE s.id = ? ORDER BY i.season, i.episode LIMIT 1`,
  ).get(Number(ctx.params.id));
  if (!ep) throw httpError(404, 'Not found');
  sendFile(ctx.req, ctx.res, await thumbnailFor(ep, { preferShowArt: true }), { cache: true });
});
route('GET', '/api/items/:id/stream', 'user', (ctx) => sendFile(ctx.req, ctx.res, getItem(ctx.params.id).path));
route('GET', '/api/items/:id/transcode', 'user', (ctx) => {
  sendTranscode(ctx.req, ctx.res, getItem(ctx.params.id), Math.max(0, Number(ctx.query.get('start')) || 0));
});
route('GET', '/api/items/:id/subs/:n', 'user', async (ctx) => {
  const item = getItem(ctx.params.id);
  const sub = genres(item.subtitles)[Number(ctx.params.n)];
  if (!sub) throw httpError(404, 'Not found');
  const vtt = await subtitleVtt(item, sub, Math.max(0, Number(ctx.query.get('start')) || 0));
  ctx.res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
  ctx.res.end(vtt);
});

// ── AI ────────────────────────────────────────────────────────────────────────
route('POST', '/api/ai/ask', 'user', (ctx) => {
  if (!String(ctx.body.question || '').trim()) throw httpError(400, 'Ask a question');
  return ask(ctx.user.id, ctx.body.question, Array.isArray(ctx.body.history) ? ctx.body.history : []);
});
route('GET', '/api/settings/ai', 'admin', () => ({ ...publicAIConfig(), providers: PROVIDERS }));
route('PUT', '/api/settings/ai', 'admin', (ctx) => {
  const b = ctx.body;
  if (!b.provider) return (setSetting('ai', {}), publicAIConfig());
  if (!PROVIDERS.includes(b.provider)) throw httpError(400, 'Unknown provider');
  const prev = getSetting('ai') || {};
  setSetting('ai', {
    provider: b.provider,
    model: String(b.model || '').trim(),
    baseUrl: String(b.baseUrl || '').trim(),
    // An empty key field means "keep the saved one" (it is never sent back to the browser).
    apiKey: b.apiKey ? String(b.apiKey).trim() : prev.provider === b.provider ? prev.apiKey || '' : '',
  });
  return publicAIConfig();
});
route('POST', '/api/ai/test', 'admin', async () => {
  const out = await completeJSON({
    system: 'You are a connectivity check.',
    messages: [{ role: 'user', content: 'Reply with {"ok": true}.' }],
    schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
    maxTokens: 2000,
  });
  return { ok: out.ok === true, provider: getAIConfig().provider };
});
route('POST', '/api/ai/enrich', 'admin', () => {
  if (!getAIConfig()) throw httpError(400, 'No AI provider is configured');
  enrichLibrary();
  return { started: true };
});

// ── admin ─────────────────────────────────────────────────────────────────────
route('GET', '/api/admin/state', 'admin', () => ({
  libraries: db.prepare(
    'SELECT l.*, (SELECT COUNT(*) FROM items WHERE library_id = l.id) AS items FROM libraries l ORDER BY l.name',
  ).all(),
  users: db.prepare('SELECT id, username, is_admin AS isAdmin FROM users ORDER BY username').all(),
  scan: scanState,
  enrich: { ...enrichState, pending: db.prepare(
    "SELECT (SELECT COUNT(*) FROM items WHERE kind = 'movie' AND ai_enriched = 0) + (SELECT COUNT(*) FROM shows WHERE ai_enriched = 0) AS n",
  ).get().n },
}));
route('POST', '/api/libraries', 'admin', (ctx) => {
  const name = String(ctx.body.name || '').trim();
  const dir = path.resolve(String(ctx.body.path || '').trim());
  if (!name) throw httpError(400, 'Give the library a name');
  if (!['movie', 'show'].includes(ctx.body.type)) throw httpError(400, 'Type must be movie or show');
  if (!ctx.body.path || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw httpError(400, `Folder not found on the server: ${dir}`);
  }
  try {
    db.prepare('INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)').run(name, ctx.body.type, dir);
  } catch {
    throw httpError(409, 'That folder is already a library');
  }
  scanAll();
  return { ok: true };
});
route('DELETE', '/api/libraries/:id', 'admin', (ctx) => {
  db.prepare('DELETE FROM libraries WHERE id = ?').run(Number(ctx.params.id));
  db.exec('DELETE FROM shows WHERE title NOT IN (SELECT show_title FROM items WHERE show_title IS NOT NULL)');
  return { ok: true };
});
route('POST', '/api/scan', 'admin', () => (scanAll(), { started: true }));
route('POST', '/api/users', 'admin', (ctx) => ({ id: auth.createUser(ctx.body.username, ctx.body.password, !!ctx.body.isAdmin) }));
route('DELETE', '/api/users/:id', 'admin', (ctx) => {
  if (Number(ctx.params.id) === ctx.user.id) throw httpError(400, "You can't delete yourself");
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(ctx.params.id));
  return { ok: true };
});

// ── server ────────────────────────────────────────────────────────────────────
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const rel = path.normalize(pathname).replace(/^([/\\]|\.\.)+/, '');
    let file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(WEB_DIR, 'index.html');
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    return void fs.createReadStream(file).pipe(res);
  }

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    // Cookie auth + a custom header on writes: cross-site forms can't set it, so no CSRF.
    if (method !== 'GET' && req.headers['x-wingly'] !== '1') throw httpError(403, 'Missing X-Wingly header');
    const user = auth.currentUser(req);
    if (r.access !== 'public' && !user) throw httpError(401, 'Sign in first');
    if (r.access === 'admin' && !user.isAdmin) throw httpError(403, 'Admins only');
    const ctx = {
      req, res, user, query: url.searchParams,
      params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])),
      body: method === 'GET' ? {} : await readBody(req),
      secure: req.headers['x-forwarded-proto'] === 'https',
    };
    const out = await r.handler(ctx);
    if (out !== undefined && !res.headersSent) json(res, out);
    return;
  }
  throw httpError(404, 'Not found');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (res.headersSent) return void res.destroy();
    json(res, { error: e.status ? e.message : e.message || 'Internal error' }, e.status || 500);
  });
}).listen(PORT, HOST, () => {
  console.log(`Wingly is running → http://localhost:${PORT}`);
  if (db.prepare('SELECT COUNT(*) AS n FROM libraries').get().n) scanAll();
});

// Rescan periodically so new files show up without a click.
const every = Number(process.env.WINGLY_SCAN_MINUTES ?? 60);
if (every > 0) setInterval(scanAll, every * 60_000).unref();

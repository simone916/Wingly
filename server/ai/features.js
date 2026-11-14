import path from 'node:path';
import { db } from '../db.js';
import { completeJSON } from './index.js';

const parseGenres = (s) => { try { return JSON.parse(s); } catch { return []; } };

// ── 1. Metadata enrichment ────────────────────────────────────────────────────
// No metadata account needed: the model identifies titles from messy filenames
// and writes a short synopsis from what it already knows.

const ENRICH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'title', 'year', 'overview', 'genres'],
        properties: {
          ref: { type: 'string' },
          title: { type: 'string' },
          year: { type: ['integer', 'null'] },
          overview: { type: ['string', 'null'] },
          genres: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const ENRICH_SYSTEM = `You tidy the catalog of a personal media library.
For each entry you get a ref, the file path, and a title/year guessed from the filename.
Return, for every ref: the proper title (correct capitalization and punctuation), the release year
(first-air year for series), a spoiler-free overview of at most two sentences, and up to four genres.
If you do not recognize the work with confidence, keep the guessed title, and set overview to null
and genres to [] rather than inventing details. Home videos and personal recordings are common — never
make up a plot for them.`;

export const enrichState = { running: false, done: 0, total: 0, lastError: null };

export async function enrichLibrary() {
  if (enrichState.running) return;
  const movies = db.prepare("SELECT id, path, title, year FROM items WHERE kind = 'movie' AND ai_enriched = 0").all();
  const shows = db.prepare('SELECT id, title, year FROM shows WHERE ai_enriched = 0').all();
  const entries = [
    ...movies.map((m) => ({ ref: `m${m.id}`, type: 'movie', file: path.basename(m.path), guessedTitle: m.title, guessedYear: m.year })),
    ...shows.map((s) => ({ ref: `s${s.id}`, type: 'series', guessedTitle: s.title, guessedYear: s.year })),
  ];
  Object.assign(enrichState, { running: true, done: 0, total: entries.length, lastError: null });
  const updMovie = db.prepare('UPDATE items SET title = ?, year = ?, overview = ?, genres = ?, ai_enriched = 1 WHERE id = ?');
  const updShow = db.prepare('UPDATE shows SET year = ?, overview = ?, genres = ?, ai_enriched = 1 WHERE id = ?');
  try {
    for (let i = 0; i < entries.length; i += 40) {
      const batch = entries.slice(i, i + 40);
      const known = new Set(batch.map((e) => e.ref));
      const { results = [] } = await completeJSON({
        system: ENRICH_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(batch) }],
        schema: ENRICH_SCHEMA,
      });
      for (const r of results) {
        if (!known.has(r.ref) || typeof r.title !== 'string' || !r.title.trim()) continue;
        const id = Number(r.ref.slice(1));
        const year = Number.isInteger(r.year) ? r.year : null;
        const genres = JSON.stringify((Array.isArray(r.genres) ? r.genres : []).slice(0, 4).map(String));
        const overview = typeof r.overview === 'string' && r.overview.trim() ? r.overview.trim() : null;
        // Show titles are the join key to episodes, so only movies get retitled.
        if (r.ref[0] === 'm') updMovie.run(r.title.trim(), year, overview, genres, id);
        else updShow.run(year, overview, genres, id);
      }
      enrichState.done += batch.length;
    }
  } catch (e) {
    enrichState.lastError = e.message;
  } finally {
    enrichState.running = false;
  }
}

// ── 2. Ask your library ───────────────────────────────────────────────────────

const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'picks'],
  properties: {
    reply: { type: 'string' },
    picks: { type: 'array', items: { type: 'string' } },
  },
};

function catalog(userId) {
  const movies = db.prepare(
    `SELECT i.id, i.title, i.year, i.genres, i.duration, p.watched, p.position
     FROM items i LEFT JOIN progress p ON p.item_id = i.id AND p.user_id = ?
     WHERE i.kind = 'movie' ORDER BY i.title`,
  ).all(userId);
  const shows = db.prepare(
    `SELECT s.id, s.title, s.year, s.genres, COUNT(i.id) AS episodes,
            COALESCE(SUM(p.watched), 0) AS watched
     FROM shows s JOIN items i ON i.show_title = s.title
     LEFT JOIN progress p ON p.item_id = i.id AND p.user_id = ?
     GROUP BY s.id ORDER BY s.title`,
  ).all(userId);
  const lines = [];
  for (const m of movies) {
    const state = m.watched ? 'watched' : m.position > 60 ? 'started' : 'unwatched';
    const mins = m.duration ? `${Math.round(m.duration / 60)} min` : '';
    lines.push(`m${m.id} | movie | ${m.title}${m.year ? ` (${m.year})` : ''} | ${parseGenres(m.genres).join(', ')} | ${mins} | ${state}`);
  }
  for (const s of shows) {
    lines.push(`s${s.id} | series | ${s.title}${s.year ? ` (${s.year})` : ''} | ${parseGenres(s.genres).join(', ')} | ${s.watched}/${s.episodes} episodes watched`);
  }
  return lines;
}

export async function ask(userId, question, history = []) {
  const lines = catalog(userId);
  const system = `You are the librarian of a personal media server. Help the viewer find something to watch
from THEIR library, listed below one title per line as: ref | type | title (year) | genres | details.
Use your own knowledge of these films and series (plot, mood, cast, director) to answer.
Only recommend titles that are in the library. If nothing fits, say so plainly.
Answer in "reply" in a friendly sentence or three, in the viewer's language. Put the refs of the titles you
mention in "picks", best match first, at most 8.

LIBRARY (${lines.length} titles):
${lines.join('\n') || '(empty)'}`;
  const messages = [
    ...history.slice(-10).flatMap((h) =>
      (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string'
        ? [{ role: h.role, content: h.content.slice(0, 4000) }]
        : [],
    ),
    { role: 'user', content: String(question).slice(0, 4000) },
  ];
  const out = await completeJSON({ system, messages, schema: ASK_SCHEMA });
  const picks = [];
  for (const ref of Array.isArray(out.picks) ? out.picks.slice(0, 8) : []) {
    const m = /^([ms])(\d+)$/.exec(String(ref));
    if (!m) continue;
    const row = m[1] === 'm'
      ? db.prepare("SELECT id, title, year FROM items WHERE id = ? AND kind = 'movie'").get(Number(m[2]))
      : db.prepare('SELECT id, title, year FROM shows WHERE id = ?').get(Number(m[2]));
    if (row) picks.push({ type: m[1] === 'm' ? 'movie' : 'show', ...row });
  }
  return { reply: String(out.reply || ''), picks };
}

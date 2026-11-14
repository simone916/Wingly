import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.WINGLY_DATA || './data');
export const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'wingly.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('movie','show')),
  path TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('movie','episode')),
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  show_title TEXT,
  season INTEGER,
  episode INTEGER,
  overview TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  ai_enriched INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  container TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  width INTEGER,
  height INTEGER,
  subtitles TEXT NOT NULL DEFAULT '[]',
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  year INTEGER,
  overview TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  ai_enriched INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_show ON items(show_title, season, episode);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

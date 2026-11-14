import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'wingly_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split('$');
  const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

export function hasUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

export function createUser(username, password, isAdmin) {
  username = String(username || '').trim();
  if (!/^[\w.-]{2,32}$/.test(username)) throw httpError(400, 'Username must be 2–32 letters, digits, . _ or -');
  if (String(password || '').length < 8) throw httpError(400, 'Password must be at least 8 characters');
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password), isAdmin ? 1 : 0, Date.now());
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw httpError(409, 'That username is taken');
    throw e;
  }
}

export function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw httpError(401, 'Wrong username or password');
  }
  return user.id;
}

export function startSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`,
  );
}

function readToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

export function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).get(sha(token), Date.now());
  return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : null;
}

export function endSession(req, res) {
  const token = readToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

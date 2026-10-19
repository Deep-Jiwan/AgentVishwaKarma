import { SCHEMA } from './schema.js';

const COOKIE = 'vk_session';
const SESSION_SECONDS = 30 * 24 * 3600;
const MIN_PASSWORD = 15;
const MAX_FAILS = 8; // wrong passwords per IP per window
const FAIL_WINDOW_MS = 15 * 60 * 1000;

// Colour-blind-safe palette (Okabe-Ito based). Each project also gets a pattern.
export const COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9', '#F0E442', '#5B6770'];
export const PATTERNS = ['solid', 'diagonal', 'backdiagonal', 'dots', 'grid', 'horizontal', 'checks', 'zigzag'];
const STATUSES = ['planned', 'in_progress', 'done'];
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // 56 chars, no look-alikes

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const enc = new TextEncoder();
const bad = (msg) => new HttpError(400, msg);

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw bad('Expected JSON');
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw bad('Invalid JSON');
}

// ---------- crypto helpers ----------

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePassword(length = 20) {
  const out = [];
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 224 && out.length < length) out.push(PASSWORD_ALPHABET[b % 56]); // 224 = 56 * 4, no modulo bias
    }
  }
  return out.join('');
}

// ---------- validation ----------

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function cleanText(v, field, max, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  v = v.trim();
  if (required && !v) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field} is too long (max ${max})`);
  return v;
}

function cleanEvent(input) {
  const e = {
    project_id: Number(input.project_id),
    title: cleanText(input.title, 'Title', 120, { required: true }),
    notes: cleanText(input.notes, 'Notes', 2000),
    start_date: input.start_date,
    end_date: input.end_date,
    start_time: input.start_time || null,
    end_time: input.end_time || null,
    status: input.status || 'planned',
  };
  if (!Number.isInteger(e.project_id)) throw bad('Pick a project');
  if (!isDate(e.start_date) || !isDate(e.end_date)) throw bad('Dates must look like 2026-10-19');
  if (e.end_date < e.start_date) throw bad('End date is before the start date');
  if ((e.start_time == null) !== (e.end_time == null)) throw bad('Add both a start and end time, or neither');
  if (e.start_time != null) {
    if (!isTime(e.start_time) || !isTime(e.end_time)) throw bad('Times must look like 09:30');
    if (e.start_date === e.end_date && e.end_time <= e.start_time) throw bad('End time must be after the start time');
  }
  if (!STATUSES.includes(e.status)) throw bad('Unknown status');
  return e;
}

function cleanProject(input) {
  const p = {
    name: cleanText(input.name, 'Name', 40, { required: true }),
    color: input.color,
    pattern: input.pattern,
  };
  if (!COLORS.includes(p.color)) throw bad('Pick one of the listed colours');
  if (!PATTERNS.includes(p.pattern)) throw bad('Pick one of the listed patterns');
  return p;
}

// ---------- auth & access ----------

function requireConfig(env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw new HttpError(500, 'Server is not set up yet (missing ADMIN_PASSWORD or SESSION_SECRET).');
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function authenticate(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const tokenHash = await hmac(env.SESSION_SECRET, 'sess:' + token);
  return env.DB.prepare(
    'SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
  )
    .bind(tokenHash, Math.floor(Date.now() / 1000))
    .first();
}

// Projects this user may see, each with the level they hold on it.
async function projectsFor(db, user) {
  if (user.role === 'editor') {
    const { results } = await db
      .prepare(
        `SELECT p.id, p.name, p.color, p.pattern, a.level FROM projects p
         JOIN project_access a ON a.project_id = p.id WHERE a.user_id = ? ORDER BY p.name COLLATE NOCASE`
      )
      .bind(user.id)
      .all();
    return results;
  }
  const level = user.role === 'admin' ? 'edit' : 'view';
  const { results } = await db.prepare('SELECT id, name, color, pattern FROM projects ORDER BY name COLLATE NOCASE').all();
  return results.map((p) => ({ ...p, level }));
}

async function levelOn(db, user, projectId) {
  if (user.role === 'admin') {
    return (await db.prepare('SELECT 1 x FROM projects WHERE id = ?').bind(projectId).first()) ? 'edit' : null;
  }
  const projects = await projectsFor(db, user);
  return projects.find((p) => p.id === projectId)?.level ?? null;
}

async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND ts > ?').bind(ip, now - FAIL_WINDOW_MS).first();
  if (recent.n >= MAX_FAILS) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');

  const { password } = await readJson(request);
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
    throw bad(`Passwords are at least ${MIN_PASSWORD} characters.`);
  }

  const key = await hmac(env.SESSION_SECRET, 'pw:' + password);
  const adminKey = await hmac(env.SESSION_SECRET, 'pw:' + env.ADMIN_PASSWORD);
  let user;
  if (safeEqual(key, adminKey)) {
    const adminName = (env.ADMIN_NAME || 'Admin').slice(0, 40);
    user = await env.DB.prepare("SELECT id, name, role FROM users WHERE role = 'admin' LIMIT 1").first();
    if (!user) {
      const r = await env.DB.prepare("INSERT INTO users (name, role, pw_key) VALUES (?, 'admin', '__admin__')").bind(adminName).run();
      user = { id: r.meta.last_row_id, name: adminName, role: 'admin' };
    } else if (user.name !== adminName) {
      await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(adminName, user.id).run();
      user.name = adminName;
    }
  } else {
    user = await env.DB.prepare('SELECT id, name, role FROM users WHERE pw_key = ? AND role != ?').bind(key, 'admin').first();
  }

  if (!user) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_fails (ip, ts) VALUES (?, ?)').bind(ip, now),
      env.DB.prepare('DELETE FROM login_fails WHERE ts < ?').bind(now - 24 * 3600 * 1000),
    ]);
    throw new HttpError(401, "That password isn't right.");
  }

  const token = randomToken();
  const tokenHash = await hmac(env.SESSION_SECRET, 'sess:' + token);
  const nowSec = Math.floor(now / 1000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(tokenHash, user.id, nowSec + SESSION_SECONDS),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowSec),
  ]);
  return json({ me: { name: user.name, role: user.role } }, 200, { 'set-cookie': sessionCookie(token, SESSION_SECONDS) });
}

// ---------- routes ----------

async function getState(env, user) {
  const projects = await projectsFor(env.DB, user);
  let events;
  if (user.role === 'editor') {
    events = (
      await env.DB.prepare(
        'SELECT e.* FROM events e JOIN project_access a ON a.project_id = e.project_id WHERE a.user_id = ? ORDER BY e.start_date, e.start_time'
      )
        .bind(user.id)
        .all()
    ).results;
  } else {
    events = (await env.DB.prepare('SELECT * FROM events ORDER BY start_date, start_time').all()).results;
  }
  return { me: { name: user.name, role: user.role }, projects, events };
}

async function saveEvent(env, user, id, input) {
  const e = cleanEvent(input);
  if ((await levelOn(env.DB, user, e.project_id)) !== 'edit') throw new HttpError(403, "You can't edit that project.");
  const cols = [e.project_id, e.title, e.notes, e.start_date, e.end_date, e.start_time, e.end_time, e.status, user.name];
  if (id == null) {
    const r = await env.DB.prepare(
      'INSERT INTO events (project_id, title, notes, start_date, end_date, start_time, end_time, status, updated_by) VALUES (?,?,?,?,?,?,?,?,?)'
    )
      .bind(...cols)
      .run();
    id = r.meta.last_row_id;
  } else {
    await env.DB.prepare(
      `UPDATE events SET project_id=?, title=?, notes=?, start_date=?, end_date=?, start_time=?, end_time=?, status=?, updated_by=?,
       updated_at=datetime('now') WHERE id=?`
    )
      .bind(...cols, id)
      .run();
  }
  return json({ event: await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first() });
}

function newUserResponse(user, password) {
  return json({ user: { ...user, access: [] }, password });
}

async function handleApi(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');

  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  }

  requireConfig(env);
  await ensureSchema(env.DB);

  if (path === '/api/login' && method === 'POST') return login(request, env);

  const user = await authenticate(request, env);
  if (!user) throw new HttpError(401, 'Sign in required');

  if (path === '/api/logout' && method === 'POST') {
    const token = readCookie(request, COOKIE);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hmac(env.SESSION_SECRET, 'sess:' + token)).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (path === '/api/state' && method === 'GET') return json(await getState(env, user));

  // ----- events (anyone with edit access to the project) -----
  if (path === '/api/events' && method === 'POST') {
    if (user.role === 'guest') throw new HttpError(403, 'Guests can only look.');
    return saveEvent(env, user, null, await readJson(request));
  }
  let m = path.match(/^\/api\/events\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const existing = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
    // Same answer whether it doesn't exist or you can't see it, so ids can't be probed.
    if (!existing || !(await levelOn(env.DB, user, existing.project_id))) throw new HttpError(404, 'Not found');
    if ((await levelOn(env.DB, user, existing.project_id)) !== 'edit') throw new HttpError(403, "You can't edit that project.");
    if (method === 'PATCH') return saveEvent(env, user, id, { ...existing, ...(await readJson(request)) });
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  // ----- admin only -----
  if (user.role !== 'admin' && /^\/api\/(projects|users)/.test(path)) throw new HttpError(403, 'Admins only');

  if (path === '/api/projects' && method === 'POST') {
    const p = cleanProject(await readJson(request));
    const r = await env.DB.prepare('INSERT INTO projects (name, color, pattern) VALUES (?,?,?)').bind(p.name, p.color, p.pattern).run();
    return json({ project: { id: r.meta.last_row_id, ...p, level: 'edit' } });
  }
  m = path.match(/^\/api\/projects\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const existing = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
      if (!existing) throw new HttpError(404, 'Not found');
      const p = cleanProject({ ...existing, ...(await readJson(request)) });
      await env.DB.prepare('UPDATE projects SET name=?, color=?, pattern=? WHERE id=?').bind(p.name, p.color, p.pattern, id).run();
      return json({ project: { id, ...p, level: 'edit' } });
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM events WHERE project_id = ?').bind(id),
        env.DB.prepare('DELETE FROM project_access WHERE project_id = ?').bind(id),
        env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if (path === '/api/users' && method === 'GET') {
    const users = (await env.DB.prepare("SELECT id, name, role FROM users WHERE role != 'admin' ORDER BY name COLLATE NOCASE").all()).results;
    const access = (await env.DB.prepare('SELECT user_id, project_id, level FROM project_access').all()).results;
    return json({ users: users.map((u) => ({ ...u, access: access.filter((a) => a.user_id === u.id).map(({ project_id, level }) => ({ project_id, level })) })) });
  }
  if (path === '/api/users' && method === 'POST') {
    const body = await readJson(request);
    const name = cleanText(body.name, 'Name', 40, { required: true });
    if (!['editor', 'guest'].includes(body.role)) throw bad('Role must be editor or guest');
    const password = generatePassword();
    const key = await hmac(env.SESSION_SECRET, 'pw:' + password);
    const r = await env.DB.prepare('INSERT INTO users (name, role, pw_key) VALUES (?,?,?)').bind(name, body.role, key).run();
    return newUserResponse({ id: r.meta.last_row_id, name, role: body.role }, password);
  }
  m = path.match(/^\/api\/users\/(\d+)(\/reset-password)?$/);
  if (m) {
    const id = Number(m[1]);
    const target = await env.DB.prepare("SELECT id, name, role FROM users WHERE id = ? AND role != 'admin'").bind(id).first();
    if (!target) throw new HttpError(404, 'Not found');

    if (m[2] && method === 'POST') {
      const password = generatePassword();
      const key = await hmac(env.SESSION_SECRET, 'pw:' + password);
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pw_key = ? WHERE id = ?').bind(key, id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id), // old password's logins end now
      ]);
      return json({ password });
    }
    if (method === 'PATCH') {
      const body = await readJson(request);
      const stmts = [];
      if (body.name !== undefined) stmts.push(env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(cleanText(body.name, 'Name', 40, { required: true }), id));
      if (body.access !== undefined) {
        if (target.role !== 'editor') throw bad('Only editors have per-project access');
        if (!Array.isArray(body.access)) throw bad('access must be a list');
        const seen = new Set();
        stmts.push(env.DB.prepare('DELETE FROM project_access WHERE user_id = ?').bind(id));
        for (const a of body.access) {
          if (!Number.isInteger(a.project_id) || !['edit', 'view'].includes(a.level) || seen.has(a.project_id)) throw bad('Bad access entry');
          seen.add(a.project_id);
          stmts.push(env.DB.prepare('INSERT INTO project_access (user_id, project_id, level) VALUES (?,?,?)').bind(id, a.project_id, a.level));
        }
      }
      if (stmts.length) {
        try {
          await env.DB.batch(stmts);
        } catch {
          throw bad('One of those projects no longer exists');
        }
      }
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM project_access WHERE user_id = ?').bind(id),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

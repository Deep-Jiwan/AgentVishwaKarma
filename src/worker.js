import { SCHEMA } from './schema.js';
import { handleMcp } from './mcp.js';
import {
  HttpError, bad, json, readJson, hmac, safeEqual, randomToken, generatePassword,
  cleanText, cleanEvent, cleanProject, shiftDate,
} from './core.js';

const COOKIE = 'vk_session';
const SESSION_SECONDS = 30 * 24 * 3600;
const MIN_PASSWORD = 15;
const MAX_FAILS = 8; // wrong passwords per IP per window
const FAIL_WINDOW_MS = 15 * 60 * 1000;

let schemaReady = null;
function ensureSchema(db) {
  schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

// ---------- sign-in (shared by the website and MCP) ----------

export function requireConfig(env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw new HttpError(500, 'Server is not set up yet (missing ADMIN_PASSWORD or SESSION_SECRET).');
}

export async function checkLoginRate(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND ts > ?').bind(ip, Date.now() - FAIL_WINDOW_MS).first();
  if (recent.n >= MAX_FAILS) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.');
  return ip;
}

export async function recordLoginFail(env, ip) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_fails (ip, ts) VALUES (?, ?)').bind(ip, now),
    env.DB.prepare('DELETE FROM login_fails WHERE ts < ?').bind(now - 24 * 3600 * 1000),
  ]);
}

// Password -> user (or null). The password itself is never stored, only a keyed hash.
export async function userFromPassword(env, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
    throw bad(`Passwords are at least ${MIN_PASSWORD} characters.`);
  }
  const key = await hmac(env.SESSION_SECRET, 'pw:' + password);
  const adminKey = await hmac(env.SESSION_SECRET, 'pw:' + env.ADMIN_PASSWORD);
  if (!safeEqual(key, adminKey)) {
    return env.DB.prepare('SELECT id, name, role FROM users WHERE pw_key = ? AND role != ?').bind(key, 'admin').first();
  }
  const adminName = (env.ADMIN_NAME || 'Admin').slice(0, 40);
  const user = await env.DB.prepare("SELECT id, name, role FROM users WHERE role = 'admin' LIMIT 1").first();
  if (!user) {
    const r = await env.DB.prepare("INSERT INTO users (name, role, pw_key) VALUES (?, 'admin', '__admin__')").bind(adminName).run();
    return { id: r.meta.last_row_id, name: adminName, role: 'admin' };
  }
  if (user.name !== adminName) {
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(adminName, user.id).run();
    user.name = adminName;
  }
  return user;
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

async function login(request, env) {
  const ip = await checkLoginRate(env, request);
  const { password } = await readJson(request);
  const user = await userFromPassword(env, password);
  if (!user) {
    await recordLoginFail(env, ip);
    throw new HttpError(401, "That password isn't right.");
  }
  const token = randomToken();
  const tokenHash = await hmac(env.SESSION_SECRET, 'sess:' + token);
  const nowSec = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(tokenHash, user.id, nowSec + SESSION_SECONDS),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowSec),
  ]);
  return json({ me: { name: user.name, role: user.role } }, 200, { 'set-cookie': sessionCookie(token, SESSION_SECONDS) });
}

// ---------- operations (the website API and MCP both call these) ----------
// Every function checks what `user` is allowed to do, so the rules live in one place.

function needAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
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

export async function getState(env, user) {
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

export async function getProject(env, user, id) {
  const p = (await projectsFor(env.DB, user)).find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Not found');
  return p;
}

// Same answer whether it doesn't exist or you can't see it, so ids can't be probed.
async function loadEvent(env, user, id, { edit = false } = {}) {
  const existing = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  const level = existing ? await levelOn(env.DB, user, existing.project_id) : null;
  if (!level) throw new HttpError(404, 'Not found');
  if (edit && level !== 'edit') throw new HttpError(403, "You can't edit that project.");
  return existing;
}

export async function getEvent(env, user, id) {
  return loadEvent(env, user, id);
}

export async function listEvents(env, user, { project_id, from, to, status, q, limit = 200 } = {}) {
  const state = await getState(env, user);
  const names = new Map(state.projects.map((p) => [p.id, p.name]));
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  const matches = state.events.filter(
    (e) =>
      (project_id == null || e.project_id === project_id) &&
      (!from || e.end_date >= from) &&
      (!to || e.start_date <= to) &&
      (!status || e.status === status) &&
      (!needle || (e.title + ' ' + e.notes).toLowerCase().includes(needle))
  );
  limit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const events = matches.slice(0, limit).map((e) => ({ ...e, project: names.get(e.project_id) }));
  return { total: matches.length, returned: events.length, events };
}

export async function saveEvent(env, user, id, input) {
  if (user.role === 'guest') throw new HttpError(403, 'Guests can only look.');
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
  return env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}

export async function updateEvent(env, user, id, changes) {
  const existing = await loadEvent(env, user, id, { edit: true });
  return saveEvent(env, user, id, { ...existing, ...changes });
}

export async function moveEvent(env, user, id, days) {
  if (!Number.isInteger(days) || Math.abs(days) > 3650) throw bad('days must be a whole number (negative moves earlier)');
  const existing = await loadEvent(env, user, id, { edit: true });
  return saveEvent(env, user, id, { ...existing, start_date: shiftDate(existing.start_date, days), end_date: shiftDate(existing.end_date, days) });
}

export async function deleteEvent(env, user, id) {
  await loadEvent(env, user, id, { edit: true });
  await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
  return { ok: true, deleted: id };
}

export async function createProject(env, user, input) {
  needAdmin(user);
  const p = cleanProject(input);
  const r = await env.DB.prepare('INSERT INTO projects (name, color, pattern) VALUES (?,?,?)').bind(p.name, p.color, p.pattern).run();
  return { id: r.meta.last_row_id, ...p, level: 'edit' };
}

export async function updateProject(env, user, id, changes) {
  needAdmin(user);
  const existing = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Not found');
  const p = cleanProject({ ...existing, ...changes });
  await env.DB.prepare('UPDATE projects SET name=?, color=?, pattern=? WHERE id=?').bind(p.name, p.color, p.pattern, id).run();
  return { id, ...p, level: 'edit' };
}

export async function deleteProject(env, user, id) {
  needAdmin(user);
  const existing = await env.DB.prepare('SELECT 1 x FROM projects WHERE id = ?').bind(id).first();
  if (!existing) throw new HttpError(404, 'Not found');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM events WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM project_access WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
  return { ok: true, deleted: id };
}

export async function listUsers(env, user) {
  needAdmin(user);
  const users = (await env.DB.prepare("SELECT id, name, role FROM users WHERE role != 'admin' ORDER BY name COLLATE NOCASE").all()).results;
  const access = (await env.DB.prepare('SELECT user_id, project_id, level FROM project_access').all()).results;
  return users.map((u) => ({ ...u, access: access.filter((a) => a.user_id === u.id).map(({ project_id, level }) => ({ project_id, level })) }));
}

export async function getUser(env, user, id) {
  const u = (await listUsers(env, user)).find((x) => x.id === id);
  if (!u) throw new HttpError(404, 'Not found');
  return u;
}

export async function createUser(env, user, body) {
  needAdmin(user);
  const name = cleanText(body.name, 'Name', 40, { required: true });
  if (!['editor', 'guest'].includes(body.role)) throw bad('Role must be editor or guest');
  const password = generatePassword();
  const key = await hmac(env.SESSION_SECRET, 'pw:' + password);
  const r = await env.DB.prepare('INSERT INTO users (name, role, pw_key) VALUES (?,?,?)').bind(name, body.role, key).run();
  return { user: { id: r.meta.last_row_id, name, role: body.role, access: [] }, password };
}

export async function updateUser(env, user, id, body) {
  const target = await getUser(env, user, id);
  const stmts = [];
  if (body.name !== undefined) stmts.push(env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(cleanText(body.name, 'Name', 40, { required: true }), id));
  if (body.access !== undefined) {
    if (target.role !== 'editor') throw bad('Only editors have per-project access');
    if (!Array.isArray(body.access)) throw bad('access must be a list');
    const seen = new Set();
    stmts.push(env.DB.prepare('DELETE FROM project_access WHERE user_id = ?').bind(id));
    for (const a of body.access) {
      if (!Number.isInteger(a?.project_id) || !['edit', 'view'].includes(a.level) || seen.has(a.project_id)) throw bad('Bad access entry');
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
  return getUser(env, user, id);
}

export async function resetPassword(env, user, id) {
  await getUser(env, user, id);
  const password = generatePassword();
  const key = await hmac(env.SESSION_SECRET, 'pw:' + password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_key = ? WHERE id = ?').bind(key, id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id), // old password's logins end now
  ]);
  return { password };
}

export async function deleteUser(env, user, id) {
  await getUser(env, user, id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM project_access WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return { ok: true, deleted: id };
}

// ---------- website API ----------

async function handleApi(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');

  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  }

  if (path === '/api/config' && method === 'GET') return json({ brand: (env.BRAND_NAME || 'Calendar').slice(0, 40) });

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
  if (path === '/api/events' && method === 'POST') return json({ event: await saveEvent(env, user, null, await readJson(request)) });
  let m = path.match(/^\/api\/events\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PATCH') return json({ event: await updateEvent(env, user, id, await readJson(request)) });
    if (method === 'DELETE') return json(await deleteEvent(env, user, id));
  }

  // ----- admin only -----
  if (user.role !== 'admin' && /^\/api\/(projects|users)/.test(path)) throw new HttpError(403, 'Admins only');

  if (path === '/api/projects' && method === 'POST') return json({ project: await createProject(env, user, await readJson(request)) });
  m = path.match(/^\/api\/projects\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PATCH') return json({ project: await updateProject(env, user, id, await readJson(request)) });
    if (method === 'DELETE') return json(await deleteProject(env, user, id));
  }

  if (path === '/api/users' && method === 'GET') return json({ users: await listUsers(env, user) });
  if (path === '/api/users' && method === 'POST') return json(await createUser(env, user, await readJson(request)));
  m = path.match(/^\/api\/users\/(\d+)(\/reset-password)?$/);
  if (m) {
    const id = Number(m[1]);
    if (m[2] && method === 'POST') return json(await resetPassword(env, user, id));
    if (method === 'PATCH') return json({ ok: true, user: await updateUser(env, user, id, await readJson(request)) });
    if (method === 'DELETE') return json(await deleteUser(env, user, id));
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const isMcp = url.pathname === '/mcp';
    if (!isApi && !isMcp) return env.ASSETS.fetch(request);
    try {
      if (isMcp) {
        requireConfig(env);
        await ensureSchema(env.DB);
        return await handleMcp(request, env, url, {
          checkLoginRate, recordLoginFail, userFromPassword,
          getState, getProject, getEvent, listEvents, saveEvent, updateEvent, moveEvent, deleteEvent,
          createProject, updateProject, deleteProject,
          listUsers, getUser, createUser, updateUser, resetPassword, deleteUser,
        });
      }
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

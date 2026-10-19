// Small shared helpers: errors, JSON responses, crypto, and input checks.

// Colour-blind-safe palette (Okabe-Ito based). Each project also gets a pattern.
export const COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9', '#F0E442', '#5B6770'];
export const PATTERNS = ['solid', 'diagonal', 'backdiagonal', 'dots', 'grid', 'horizontal', 'checks', 'zigzag'];
export const STATUSES = ['planned', 'in_progress', 'done'];
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // 56 chars, no look-alikes

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg) => new HttpError(400, msg);

const enc = new TextEncoder();

export function json(body, status = 200, extraHeaders = {}) {
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

export async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw bad('Expected JSON');
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw bad('Invalid JSON');
}

// ---------- crypto ----------

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePassword(length = 20) {
  const out = [];
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 224 && out.length < length) out.push(PASSWORD_ALPHABET[b % 56]); // 224 = 56 * 4, no modulo bias
    }
  }
  return out.join('');
}

// ---------- validation ----------

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function shiftDate(s, days) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function cleanText(v, field, max, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  v = v.trim();
  if (required && !v) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field} is too long (max ${max})`);
  return v;
}

export function cleanEvent(input) {
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

export function cleanProject(input) {
  const p = {
    name: cleanText(input.name, 'Name', 40, { required: true }),
    color: input.color,
    pattern: input.pattern,
  };
  if (!COLORS.includes(p.color)) throw bad('Pick one of the listed colours');
  if (!PATTERNS.includes(p.pattern)) throw bad('Pick one of the listed patterns');
  return p;
}

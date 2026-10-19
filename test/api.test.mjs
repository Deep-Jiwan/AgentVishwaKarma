// Run against `wrangler dev` (default http://127.0.0.1:8787) with the values from .dev.vars.example-style secrets.
// Usage: BASE=http://127.0.0.1:8787 ADMIN_PASSWORD=... node test/api.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'local-admin-pass-1234';

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, ip } = {}) => {
    const res = await fetch(BASE + '/api' + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})), setCookie: set };
  };
}

const ok = (name) => console.log('  ok  ' + name);

const anon = client();
assert.equal((await anon('/state')).status, 401); ok('no cookie -> 401');
assert.equal((await anon('/login', { method: 'POST', body: { password: 'short' } })).status, 400); ok('short password rejected');
const wrong = await anon('/login', { method: 'POST', body: { password: 'x'.repeat(20) }, ip: '9.9.9.1' });
assert.equal(wrong.status, 401); ok('wrong password -> 401');

const admin = client();
const login = await admin('/login', { method: 'POST', body: { password: ADMIN } });
assert.equal(login.status, 200);
assert.match(login.setCookie, /HttpOnly/); assert.match(login.setCookie, /SameSite=Strict/); assert.match(login.setCookie, /Max-Age=2592000/);
ok('admin login sets 30-day HttpOnly cookie');

const stamp = Date.now();
const pA = (await admin('/projects', { method: 'POST', body: { name: 'Alpha ' + stamp, color: '#0072B2', pattern: 'dots' } })).data.project;
const pB = (await admin('/projects', { method: 'POST', body: { name: 'Beta ' + stamp, color: '#E69F00', pattern: 'checks' } })).data.project;
const pC = (await admin('/projects', { method: 'POST', body: { name: 'Gamma ' + stamp, color: '#009E73', pattern: 'zigzag' } })).data.project;
assert.equal((await admin('/projects', { method: 'POST', body: { name: 'bad', color: 'red', pattern: 'dots' } })).status, 400); ok('projects: colour/pattern validated');

const mk = async (p, title) => (await admin('/events', { method: 'POST', body: { project_id: p.id, title, start_date: '2026-10-20', end_date: '2026-10-22' } })).data.event;
const eA = await mk(pA, 'A task'), eB = await mk(pB, 'B task'), eC = await mk(pC, 'C task');

const ed = (await admin('/users', { method: 'POST', body: { name: 'Eddie', role: 'editor' } })).data;
assert.equal(ed.password.length, 20);
const gu = (await admin('/users', { method: 'POST', body: { name: 'Gus', role: 'guest' } })).data;
await admin('/users/' + ed.user.id, { method: 'PATCH', body: { access: [{ project_id: pA.id, level: 'edit' }, { project_id: pB.id, level: 'view' }] } });

const editor = client();
assert.equal((await editor('/login', { method: 'POST', body: { password: ed.password } })).status, 200);
const es = (await editor('/state')).data;
assert.equal(es.me.role, 'editor');
assert.deepEqual(es.projects.map((p) => [p.id, p.level]).sort(), [[pA.id, 'edit'], [pB.id, 'view']].sort()); ok('editor sees only assigned projects, with levels');
assert.deepEqual(es.events.map((e) => e.id).sort(), [eA.id, eB.id].sort()); ok('editor gets no events from hidden project');
assert.equal((await editor('/events/' + eA.id, { method: 'PATCH', body: { start_date: '2026-10-25', end_date: '2026-10-27' } })).status, 200); ok('editor can move own project task');
assert.equal((await editor('/events/' + eB.id, { method: 'PATCH', body: { start_date: '2026-10-25', end_date: '2026-10-27' } })).status, 403); ok('editor cannot move view-only task');
assert.equal((await editor('/events/' + eC.id, { method: 'PATCH', body: { title: 'x' } })).status, 404); ok('hidden project task looks non-existent');
assert.equal((await editor('/events/' + eC.id, { method: 'DELETE' })).status, 404);
assert.equal((await editor('/events', { method: 'POST', body: { project_id: pB.id, title: 'sneaky', start_date: '2026-10-20', end_date: '2026-10-20' } })).status, 403); ok('editor cannot create in view-only project');
assert.equal((await editor('/events/' + eA.id, { method: 'PATCH', body: { project_id: pC.id } })).status, 403); ok('editor cannot move task into hidden project');
assert.equal((await editor('/users')).status, 403);
assert.equal((await editor('/projects', { method: 'POST', body: { name: 'x', color: '#0072B2', pattern: 'dots' } })).status, 403); ok('editor cannot use admin routes');

const guest = client();
assert.equal((await guest('/login', { method: 'POST', body: { password: gu.password } })).status, 200);
const gs = (await guest('/state')).data;
assert.equal(gs.projects.length >= 3, true); assert.equal(gs.projects.every((p) => p.level === 'view'), true); ok('guest sees everything, read-only');
assert.equal((await guest('/events/' + eA.id, { method: 'PATCH', body: { title: 'hax' } })).status, 403);
assert.equal((await guest('/events', { method: 'POST', body: { project_id: pA.id, title: 'hax', start_date: '2026-10-20', end_date: '2026-10-20' } })).status, 403); ok('guest cannot write');

assert.equal((await admin('/events/' + eA.id, { method: 'PATCH', body: { start_date: '2026-10-30', end_date: '2026-10-29' } })).status, 400); ok('end before start rejected');
assert.equal((await admin('/events/' + eA.id, { method: 'PATCH', body: { start_time: '10:00' } })).status, 400); ok('one-sided time rejected');

const reset = (await admin(`/users/${ed.user.id}/reset-password`, { method: 'POST' })).data;
assert.equal((await editor('/state')).status, 401); ok('password reset signs the person out');
assert.equal((await client()('/login', { method: 'POST', body: { password: ed.password } })).status, 401); ok('old password no longer works');
assert.equal((await client()('/login', { method: 'POST', body: { password: reset.password } })).status, 200);

await admin('/logout', { method: 'POST' });
assert.equal((await admin('/state')).status, 401); ok('logout kills session');

const bf = client();
let last;
for (let i = 0; i < 9; i++) last = await bf('/login', { method: 'POST', body: { password: 'z'.repeat(20) + i }, ip: '9.9.9.2' });
assert.equal(last.status, 429); ok('brute force locked out after 8 wrong tries');
assert.equal((await bf('/login', { method: 'POST', body: { password: ADMIN }, ip: '9.9.9.2' })).status, 429);

const csrf = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ password: ADMIN }) });
assert.equal(csrf.status, 403); ok('cross-origin POST blocked');

// cleanup
const a2 = client(); await a2('/login', { method: 'POST', body: { password: ADMIN } });
for (const p of [pA, pB, pC]) await a2('/projects/' + p.id, { method: 'DELETE' });
for (const u of [ed.user, gu.user]) await a2('/users/' + u.id, { method: 'DELETE' });
console.log('\nAll API checks passed.');

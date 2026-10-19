// MCP checks against `wrangler dev`. Usage: BASE=http://127.0.0.1:8787 ADMIN_PASSWORD=... node test/mcp.test.mjs
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'local-admin-pass-1234';
const ok = (name) => console.log('  ok  ' + name);

let nextId = 1;
function mcp(password, ip) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(password ? { authorization: 'Bearer ' + password } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) };
  const post = async (body) => {
    const res = await fetch(BASE + '/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    post,
    rpc: (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, params }),
    // call a tool, return parsed JSON (or the error text)
    async call(name, args = {}) {
      const r = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
      assert.equal(r.status, 200);
      if (r.body.error) return { rpcError: r.body.error };
      const text = r.body.result.content[0].text;
      return r.body.result.isError ? { error: text } : JSON.parse(text);
    },
  };
}
const names = async (c) => (await c.rpc('tools/list')).body.result.tools.map((t) => t.name);

// --- auth & protocol ---
const none = mcp(null);
let r = await none.rpc('initialize', {});
assert.equal(r.status, 401); ok('no password -> 401');
r = await mcp('x'.repeat(20), '9.9.8.1').rpc('initialize', {});
assert.equal(r.status, 401); ok('wrong password -> 401');
assert.equal((await fetch(BASE + '/mcp')).status, 405); ok('GET /mcp -> 405');

const admin = mcp(ADMIN);
r = await admin.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
assert.equal(r.body.result.protocolVersion, '2025-06-18');
assert.ok(r.body.result.capabilities.tools); assert.match(r.body.result.instructions, /admin/); ok('initialize works');
assert.equal((await admin.post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202); ok('notification -> 202');
assert.deepEqual((await admin.rpc('ping')).body.result, {}); ok('ping');
assert.equal((await admin.rpc('nope')).body.error.code, -32601); ok('unknown method -> -32601');
const batch = await admin.post([{ jsonrpc: '2.0', id: 901, method: 'ping' }, { jsonrpc: '2.0', id: 902, method: 'ping' }]);
assert.equal(batch.body.length, 2); ok('batch');

// --- admin: projects CRUD ---
const stamp = Date.now();
const adminTools = await names(admin);
for (const t of ['create_project', 'update_project', 'delete_project', 'list_users', 'create_user', 'update_user', 'reset_user_password', 'delete_user', 'create_event', 'move_event']) assert.ok(adminTools.includes(t), t);
ok(`admin sees ${adminTools.length} tools`);
const who = await admin.call('whoami'); assert.equal(who.role, 'admin');
const pA = (await admin.call('create_project', { name: 'MCP Alpha ' + stamp, color: '#0072B2', pattern: 'dots' })).project;
const pB = (await admin.call('create_project', { name: 'MCP Beta ' + stamp, color: '#E69F00', pattern: 'checks' })).project;
const pC = (await admin.call('create_project', { name: 'MCP Gamma ' + stamp, color: '#009E73', pattern: 'zigzag' })).project;
assert.equal((await admin.call('create_project', { name: 'bad', color: 'red', pattern: 'dots' })).error, 'Pick one of the listed colours');
assert.equal((await admin.call('update_project', { id: pA.id, name: 'MCP Alpha2 ' + stamp })).project.name, 'MCP Alpha2 ' + stamp);
assert.equal((await admin.call('get_project', { id: pA.id })).project.color, '#0072B2');
assert.ok((await admin.call('list_projects')).projects.length >= 3); ok('projects: create / read / update / list');

// --- admin: events CRUD ---
const eA = (await admin.call('create_event', { project_id: pA.id, title: 'A task', start_date: '2026-10-20', end_date: '2026-10-22' })).event;
const eB = (await admin.call('create_event', { project_id: pB.id, title: 'B task', start_date: '2026-10-20' })).event;
const eC = (await admin.call('create_event', { project_id: pC.id, title: 'C task', notes: 'secret-ish', start_date: '2026-10-21', start_time: '09:00', end_time: '10:00' })).event;
assert.equal(eB.end_date, '2026-10-20'); ok('create_event (end_date defaults to start_date)');
assert.equal((await admin.call('get_event', { id: eA.id })).event.title, 'A task');
const moved = (await admin.call('move_event', { id: eA.id, days: 3 })).event;
assert.deepEqual([moved.start_date, moved.end_date], ['2026-10-23', '2026-10-25']); ok('move_event keeps the length');
const upd = (await admin.call('update_event', { id: eA.id, status: 'in_progress', title: 'A renamed' })).event;
assert.equal(upd.status, 'in_progress'); assert.equal(upd.title, 'A renamed'); assert.equal(upd.start_date, '2026-10-23'); ok('update_event changes only what is sent');
assert.equal((await admin.call('update_event', { id: eC.id, start_time: null, end_time: null })).event.start_time, null); ok('update_event can clear times');
const found = await admin.call('list_events', { project_id: pA.id }); assert.equal(found.returned, 1);
assert.equal((await admin.call('list_events', { q: 'secret-ish' })).events[0].id, eC.id);
assert.equal((await admin.call('list_events', { status: 'in_progress', from: '2026-10-24', to: '2026-10-24' })).events.some((e) => e.id === eA.id), true); ok('list_events filters');
assert.match((await admin.call('create_event', { project_id: pA.id, title: 'x', start_date: '2026-13-40' })).error, /Dates must/); ok('validation errors come back as tool errors');
assert.match((await admin.call('move_event', { id: eA.id, days: 1.5 })).error, /whole number/);

// --- admin: people CRUD ---
const ed = await admin.call('create_user', { name: 'MCP Eddie', role: 'editor' });
const gu = await admin.call('create_user', { name: 'MCP Gus', role: 'guest' });
assert.equal(ed.password.length, 20);
assert.equal((await admin.call('update_user', { id: ed.user.id, name: 'MCP Eddie2', access: [{ project_id: pA.id, level: 'edit' }, { project_id: pB.id, level: 'view' }] })).user.access.length, 2);
assert.equal((await admin.call('get_user', { id: ed.user.id })).user.name, 'MCP Eddie2');
assert.ok((await admin.call('list_users')).users.some((u) => u.id === gu.user.id)); ok('users: create / read / update / list');
assert.match((await admin.call('update_user', { id: gu.user.id, access: [] })).error, /Only editors/);

// --- editor ---
const editor = mcp(ed.password);
const edTools = await names(editor);
assert.ok(edTools.includes('update_event') && !edTools.includes('create_project') && !edTools.includes('list_users')); ok(`editor sees ${edTools.length} tools (no admin tools)`);
assert.equal((await editor.call('create_project', { name: 'x', color: '#0072B2', pattern: 'dots' })).rpcError.code, -32602); ok('editor cannot call admin tools');
const es = await editor.call('list_events'); assert.deepEqual(es.events.map((e) => e.id).sort(), [eA.id, eB.id].sort()); ok('editor sees only assigned projects');
assert.equal((await editor.call('move_event', { id: eA.id, days: 1 })).event.start_date, '2026-10-24'); ok('editor can move tasks in own project');
assert.match((await editor.call('move_event', { id: eB.id, days: 1 })).error, /can't edit/); ok('editor blocked on view-only project');
assert.equal((await editor.call('get_event', { id: eC.id })).error, 'Not found'); ok('hidden task looks non-existent');
assert.match((await editor.call('create_event', { project_id: pB.id, title: 'sneaky', start_date: '2026-10-20' })).error, /can't edit/);
assert.match((await editor.call('update_event', { id: eA.id, project_id: pC.id })).error, /can't edit/); ok('editor cannot move a task into a hidden project');
assert.equal((await editor.call('get_project', { id: pC.id })).error, 'Not found');
assert.equal((await editor.call('create_event', { project_id: pA.id, title: 'by editor', start_date: '2026-11-01' })).event.updated_by, 'MCP Eddie2'); ok('editor can create in own project');

// --- guest ---
const guest = mcp(gu.password);
const guTools = await names(guest);
assert.ok(guTools.every((t) => ['whoami', 'list_projects', 'get_project', 'list_events', 'get_event'].includes(t))); ok(`guest sees ${guTools.length} read-only tools`);
assert.ok((await guest.call('list_projects')).projects.every((p) => p.level === 'view'));
assert.equal((await guest.call('delete_event', { id: eA.id })).rpcError.code, -32602); ok('guest cannot write');

// --- delete safeguards ---
assert.match((await admin.call('delete_project', { id: pC.id })).error, /confirm: true/);
assert.match((await admin.call('delete_user', { id: ed.user.id })).error, /confirm: true/); ok('deletes need confirm: true');
assert.equal((await admin.call('delete_event', { id: eB.id })).deleted, eB.id);
assert.equal((await admin.call('get_event', { id: eB.id })).error, 'Not found');

// --- password reset kills the old password ---
const reset = await admin.call('reset_user_password', { id: ed.user.id });
assert.equal((await mcp(ed.password, '9.9.8.2').rpc('tools/list')).status, 401);
assert.equal((await mcp(reset.password).rpc('tools/list')).status, 200); ok('reset_user_password: old password dies, new one works');

// --- cleanup (also exercises the deletes) ---
assert.equal((await admin.call('delete_user', { id: ed.user.id, confirm: true })).deleted, ed.user.id);
assert.equal((await admin.call('delete_user', { id: gu.user.id, confirm: true })).deleted, gu.user.id);
for (const p of [pA, pB, pC]) assert.equal((await admin.call('delete_project', { id: p.id, confirm: true })).deleted, p.id);
assert.equal((await admin.call('get_event', { id: eC.id })).error, 'Not found'); ok('delete_project removes its tasks');
assert.equal((await mcp(gu.password, '9.9.8.3').rpc('tools/list')).status, 401); ok('deleted user is locked out');

// --- brute force on /mcp ---
let last;
for (let i = 0; i < 9; i++) last = await mcp('q'.repeat(20) + i, '9.9.8.4').rpc('tools/list');
assert.equal(last.status, 429); ok('brute force on /mcp is locked out');

console.log('\nAll MCP checks passed.');

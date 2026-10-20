// OAuth checks (what Claude's website connector does). Usage: BASE=http://127.0.0.1:8787 ADMIN_PASSWORD=... node test/oauth.test.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'local-admin-pass-1234';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const ok = (n) => console.log('  ok  ' + n);
const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const get = (path, init) => fetch(BASE + path, { redirect: 'manual', ...init });
const form = (obj) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString() });
const rpc = async (token, method, params, ip) => {
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null, headers: res.headers };
};
const toolCount = async (token) => (await rpc(token, 'tools/list')).body.result.tools.length;
const call = async (token, name, args) => JSON.parse((await rpc(token, 'tools/call', { name, arguments: args })).body.result.content[0].text);

async function register(name = 'Claude', uris = [CB]) {
  const r = await get('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: uris }) });
  return { status: r.status, body: await r.json() };
}
const pkce = () => { const verifier = b64u(randomBytes(48)); return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }; };
const authQuery = (clientId, challenge, extra = {}) => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CB, state: 'st-123', code_challenge: challenge, code_challenge_method: 'S256', ...extra });

// Full browser flow: returns {code, verifier}
async function getCode(clientId, password, ip) {
  const { verifier, challenge } = pkce();
  const q = authQuery(clientId, challenge);
  const page = await get('/authorize?' + q);
  assert.equal(page.status, 200);
  const res = await get('/authorize', { ...form({ ...Object.fromEntries(q), password }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...(ip ? { 'CF-Connecting-IP': ip } : {}) } });
  return { res, verifier, q };
}
async function tokens(clientId, code, verifier, redirect = CB) {
  const r = await get('/token', form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect }));
  return { status: r.status, body: await r.json() };
}
const codeFrom = (res) => { assert.equal(res.status, 302); const loc = new URL(res.headers.get('location')); assert.equal(loc.origin + loc.pathname, CB); assert.equal(loc.searchParams.get('state'), 'st-123'); return loc.searchParams.get('code'); };

// --- discovery ---
let r = await get('/.well-known/oauth-protected-resource'); let doc = await r.json();
assert.equal(doc.resource, BASE + '/mcp'); assert.deepEqual(doc.authorization_servers, [BASE]); ok('protected resource metadata');
r = await get('/.well-known/oauth-authorization-server'); doc = await r.json();
assert.equal(doc.issuer, BASE); assert.deepEqual(doc.code_challenge_methods_supported, ['S256']); assert.ok(doc.registration_endpoint.endsWith('/register')); ok('authorization server metadata');
const un = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(un.status, 401); assert.match(un.headers.get('www-authenticate'), /resource_metadata="[^"]+oauth-protected-resource"/); ok('/mcp 401 points to OAuth metadata');
assert.equal((await get('/token', { method: 'OPTIONS' })).status, 204); ok('CORS preflight on /token');

// --- registration ---
const evil = await register('<script>alert(1)</script>');
assert.equal(evil.status, 201); assert.match(evil.body.client_id, /^vkc_/);
assert.equal((await register('x', ['javascript:alert(1)'])).status, 400);
assert.equal((await register('x', ['http://evil.example/cb'])).status, 400); ok('registration validates redirect URIs');
assert.equal((await register('x', ['http://localhost:6274/callback'])).status, 201); ok('localhost redirect allowed');

// --- authorize page ---
const { challenge: ch0 } = pkce();
const pageHtml = await (await get('/authorize?' + authQuery(evil.body.client_id, ch0))).text();
assert.match(pageHtml, /type="password"/); assert.ok(!pageHtml.includes('<script>alert(1)')); assert.match(pageHtml, /&lt;script&gt;/); ok('consent page escapes the app name');
const noreg = await get('/authorize?' + authQuery(evil.body.client_id, ch0, { redirect_uri: 'https://evil.example/cb' }));
assert.equal(noreg.status, 400); assert.equal(noreg.headers.get('location'), null); ok('unregistered redirect_uri is never redirected to');
const plain = await get('/authorize?' + authQuery(evil.body.client_id, ch0, { code_challenge_method: 'plain' }));
assert.equal(plain.status, 302); assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request'); ok('PKCE S256 is required');
let wrong = await getCode(evil.body.client_id, 'definitely-not-the-password', '9.9.7.1');
assert.equal(wrong.res.status, 401); ok('wrong password re-shows the form (401)');

// --- full flow as admin ---
const app = (await register('Claude')).body.client_id;
const a1 = await getCode(app, ADMIN);
const code1 = codeFrom(a1.res);
const bad = await tokens(app, code1, pkce().verifier);
assert.equal(bad.body.error, 'invalid_grant'); ok('wrong PKCE verifier is rejected');
const a2 = await getCode(app, ADMIN); const code2 = codeFrom(a2.res);
const t = await tokens(app, code2, a2.verifier);
assert.equal(t.status, 200); assert.match(t.body.access_token, /^vkat_/); assert.match(t.body.refresh_token, /^vkrt_/); assert.equal(t.body.token_type, 'Bearer'); ok('code + PKCE -> tokens');
assert.equal((await tokens(app, code2, a2.verifier)).body.error, 'invalid_grant'); ok('an authorization code works only once');
const a3 = await getCode(app, ADMIN); const other = (await register('Other')).body.client_id;
assert.equal((await tokens(other, codeFrom(a3.res), a3.verifier)).body.error, 'invalid_grant'); ok('code cannot be used by another app');
const a4 = await getCode(app, ADMIN);
assert.equal((await tokens(app, codeFrom(a4.res), a4.verifier, 'https://claude.ai/other')).body.error, 'invalid_grant'); ok('redirect_uri must match at the token step');
assert.equal(await toolCount(t.body.access_token), 18); ok('admin OAuth token -> 18 tools');
const init = await rpc(t.body.access_token, 'initialize', { protocolVersion: '2025-06-18' });
assert.match(init.body.result.instructions, /admin/);

// --- refresh ---
const rf = await get('/token', form({ grant_type: 'refresh_token', client_id: app, refresh_token: t.body.refresh_token }));
const t2 = await rf.json(); assert.equal(rf.status, 200); assert.notEqual(t2.access_token, t.body.access_token);
assert.equal(await toolCount(t2.access_token), 18); ok('refresh token -> new tokens');
const reuse = await get('/token', form({ grant_type: 'refresh_token', client_id: app, refresh_token: t.body.refresh_token }));
assert.equal((await reuse.json()).error, 'invalid_grant'); ok('refresh tokens rotate (old one dies)');
assert.equal((await rpc('vkat_' + 'x'.repeat(40), 'tools/list')).status, 401); ok('random access token -> 401');

// --- roles via OAuth ---
const admin = t2.access_token;
const ed = await call(admin, 'create_user', { name: 'OA Eddie', role: 'editor' });
const gu = await call(admin, 'create_user', { name: 'OA Gus', role: 'guest' });
const eFlow = await getCode(app, ed.password); const eTok = (await tokens(app, codeFrom(eFlow.res), eFlow.verifier)).body;
const gFlow = await getCode(app, gu.password); const gTok = (await tokens(app, codeFrom(gFlow.res), gFlow.verifier)).body;
assert.equal(await toolCount(eTok.access_token), 9); assert.equal(await toolCount(gTok.access_token), 5); ok('editor OAuth -> 9 tools, guest OAuth -> 5 tools');
assert.equal((await rpc(gTok.access_token, 'tools/call', { name: 'create_project', arguments: {} })).body.error.code, -32602); ok('guest OAuth cannot call admin tools');

// --- revocation ---
await call(admin, 'reset_user_password', { id: ed.user.id });
assert.equal((await rpc(eTok.access_token, 'tools/list')).status, 401); ok('password reset ends that person\'s OAuth access');
const rr = await get('/token', form({ grant_type: 'refresh_token', client_id: app, refresh_token: eTok.refresh_token }));
assert.equal((await rr.json()).error, 'invalid_grant'); ok('...and their refresh token stops working');
await call(admin, 'delete_user', { id: gu.user.id, confirm: true });
assert.equal((await rpc(gTok.access_token, 'tools/list')).status, 401); ok('deleting a person ends their OAuth access');
await call(admin, 'delete_user', { id: ed.user.id, confirm: true });

if (!process.env.SKIP_LOCKOUT) { // skip against a live site: it would lock out your own IP for 15 minutes
// --- brute force on the authorize page ---
let last;
for (let i = 0; i < 9; i++) last = (await getCode(evil.body.client_id, 'wrong-password-number-' + i, '9.9.7.2')).res;
assert.equal(last.status, 429); ok('authorize page locks out after repeated wrong passwords');
}

console.log('\nAll OAuth checks passed.');

// OAuth 2.1 for MCP clients that cannot send a static header (e.g. Claude's website connector).
// This Worker is both the authorization server and the resource. "Signing in" means typing a
// calendar password on the /authorize page; the access you get is that password's role.
// Supports: discovery (RFC 8414 / RFC 9728), dynamic client registration (RFC 7591),
// authorization code + PKCE (S256 only), refresh tokens (rotated).

import { HttpError, json, hmac, safeEqual, randomToken } from './core.js';

const CODE_SECONDS = 300;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 24 * 3600;
const MAX_CLIENTS = 1000;
const MAX_REGISTRATIONS_PER_HOUR = 100;

export const OAUTH_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/register',
  '/authorize',
  '/token',
]);

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const str = (v, max = 2048) => (typeof v === 'string' && v.length <= max ? v : '');
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status, { ...CORS, ...NO_STORE });

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export const resourceMetadataUrl = (url) => `${url.origin}/.well-known/oauth-protected-resource`;

// ---------- access tokens (used by /mcp) ----------

// A token only works while the password it was issued for is still the current one, so
// resetting a person's password or changing ADMIN_PASSWORD ends their OAuth access too.
export async function userFromAccessToken(env, token) {
  const hash = await hmac(env.SESSION_SECRET, 'oat:' + token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.pw_key, t.cred FROM oauth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?`
  )
    .bind(hash, Math.floor(Date.now() / 1000))
    .first();
  if (!row) return null;
  const current = row.role === 'admin' ? await hmac(env.SESSION_SECRET, 'pw:' + env.ADMIN_PASSWORD) : row.pw_key;
  if (!safeEqual(current, row.cred)) return null;
  return { id: row.id, name: row.name, role: row.role };
}

async function issueTokens(env, clientId, userId, cred) {
  const now = Math.floor(Date.now() / 1000);
  const access = 'vkat_' + randomToken();
  const refresh = 'vkrt_' + randomToken();
  const insert = env.DB.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, cred, expires_at) VALUES (?,?,?,?,?,?)');
  await env.DB.batch([
    insert.bind(await hmac(env.SESSION_SECRET, 'oat:' + access), 'access', clientId, userId, cred, now + ACCESS_SECONDS),
    insert.bind(await hmac(env.SESSION_SECRET, 'ort:' + refresh), 'refresh', clientId, userId, cred, now + REFRESH_SECONDS),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now),
  ]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh };
}

// ---------- metadata ----------

function metadata(url) {
  const o = url.origin;
  return {
    protectedResource: { resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'], resource_name: 'Calendar' },
    authorizationServer: {
      issuer: o,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    },
  };
}

// ---------- dynamic client registration ----------

function validRedirectUri(u) {
  if (typeof u !== 'string' || u.length > 500) return false;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:'].includes(parsed.protocol); // app schemes such as cursor://
}

async function register(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return oauthError('invalid_client_metadata', 'Send JSON');
  }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirectUri)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1-5 https URLs (or http://localhost, or an app link)');
  }
  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare('SELECT COUNT(*) n FROM oauth_clients WHERE created_at > ?').bind(now - 3600).first();
  if (recent.n >= MAX_REGISTRATIONS_PER_HOUR) return oauthError('temporarily_unavailable', 'Too many registrations. Try again later.', 429);
  // Housekeeping: forget old clients that never got a token, and keep the table bounded.
  await env.DB.prepare(
    `DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens)`
  )
    .bind(now - 30 * 24 * 3600)
    .run();
  const total = await env.DB.prepare('SELECT COUNT(*) n FROM oauth_clients').first();
  if (total.n >= MAX_CLIENTS) return oauthError('temporarily_unavailable', 'Too many registered apps.', 429);

  const clientId = 'vkc_' + randomToken().slice(0, 22);
  const name = str(body.client_name, 80).trim() || 'An app';
  await env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?,?,?,?)')
    .bind(clientId, name, JSON.stringify(uris), now)
    .run();
  return json(
    {
      client_id: clientId, client_name: name, redirect_uris: uris, client_id_issued_at: now,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    },
    201,
    { ...CORS, ...NO_STORE }
  );
}

// ---------- authorization page ----------

async function loadClient(env, clientId) {
  if (!clientId) return null;
  const row = await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) } : null;
}

const authParams = (src) => ({
  response_type: str(src.response_type, 20),
  client_id: str(src.client_id, 100),
  redirect_uri: str(src.redirect_uri, 500),
  state: str(src.state, 1000),
  code_challenge: str(src.code_challenge, 200),
  code_challenge_method: str(src.code_challenge_method, 20),
});

function paramProblem(p) {
  if (p.response_type !== 'code') return 'unsupported_response_type';
  if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) return 'invalid_request';
  return null;
}

function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

const PAGE_CSS = `
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#f4f4f4;color:#111;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:min(440px,100%);background:#fff;border:1px solid #e2e2e2;border-radius:18px;padding:28px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
h1{margin:0 0 8px;font-size:20px}p{margin:8px 0}.muted{color:#6b6b6b;font-size:13px}
input{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:10px;font:inherit;margin-top:14px}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:10px;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#d92d20;margin-top:10px}
@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#f2f2f2}main{background:#141414;border-color:#2c2c2c}input{background:#141414;color:#f2f2f2;border-color:#444}button{background:#f2f2f2;color:#0a0a0a}.muted{color:#a0a0a0}}`;

function page(title, inner, status = 200) {
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${inner}</main></body></html>`, status);
}

function consentForm(env, client, p, error = '') {
  const brand = esc((env.BRAND_NAME || 'Calendar').slice(0, 40));
  let host = '';
  try {
    host = new URL(p.redirect_uri).host || new URL(p.redirect_uri).protocol;
  } catch { /* shown blank */ }
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
    .join('');
  return page(
    `Connect to ${brand}`,
    `<h1>Connect to ${brand}</h1>
     <p><strong>${esc(client.client_name)}</strong> wants to use this calendar.</p>
     <p class="muted">Type a calendar password to allow it. It gets exactly the access that password has: admin, editor or guest. You will be sent back to ${esc(host)}.</p>
     <form method="post" action="/authorize">${hidden}
       <input type="password" name="password" placeholder="Calendar password" autocomplete="current-password" minlength="15" required autofocus>
       <button type="submit">Allow access</button>
     </form>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}`,
    error ? 401 : 200
  );
}

async function authorize(request, env, url, ops) {
  const isPost = request.method === 'POST';
  const source = isPost ? Object.fromEntries((await request.formData()).entries()) : Object.fromEntries(url.searchParams);
  const p = authParams(source);
  const client = await loadClient(env, p.client_id);
  // Never redirect to an address that was not registered.
  if (!client || !client.redirect_uris.includes(p.redirect_uri)) {
    return page('Cannot connect', '<h1>Cannot connect</h1><p>This connection request is not valid (unknown app or return address). Go back to the app and try again.</p>', 400);
  }
  const problem = paramProblem(p);
  if (problem) return redirectWith(p.redirect_uri, { error: problem, state: p.state });
  if (!isPost) return consentForm(env, client, p);

  const ip = await ops.checkLoginRate(env, request);
  const password = typeof source.password === 'string' ? source.password : '';
  let user = null;
  try {
    user = await ops.userFromPassword(env, password);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return consentForm(env, client, p, err.message);
  }
  if (!user) {
    await ops.recordLoginFail(env, ip);
    return consentForm(env, client, p, "That password isn't right.");
  }

  const code = 'vkac_' + randomToken();
  const cred = await hmac(env.SESSION_SECRET, 'pw:' + password);
  await env.DB.prepare('INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, cred, expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(await hmac(env.SESSION_SECRET, 'oac:' + code), client.client_id, user.id, p.redirect_uri, p.code_challenge, cred, Math.floor(Date.now() / 1000) + CODE_SECONDS)
    .run();
  return redirectWith(p.redirect_uri, { code, state: p.state });
}

// ---------- token endpoint ----------

async function sha256b64url(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function token(request, env) {
  let b;
  try {
    b = (request.headers.get('content-type') || '').includes('application/json') ? await request.json() : Object.fromEntries((await request.formData()).entries());
  } catch {
    return oauthError('invalid_request', 'Could not read the request body');
  }
  const grant = str(b.grant_type, 40);
  const clientId = str(b.client_id, 100);
  const client = await loadClient(env, clientId);
  if (!client) return oauthError('invalid_client', 'Unknown client_id', 401);
  const now = Math.floor(Date.now() / 1000);

  if (grant === 'authorization_code') {
    const code = str(b.code, 200);
    const verifier = str(b.code_verifier, 200);
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_request', 'code and a valid code_verifier are required');
    // Codes work once: take it out of the table first.
    const row = await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *').bind(await hmac(env.SESSION_SECRET, 'oac:' + code)).first();
    if (!row || row.expires_at < now || row.client_id !== clientId || row.redirect_uri !== str(b.redirect_uri, 500)) {
      return oauthError('invalid_grant', 'The code is invalid, expired, or does not match');
    }
    if (!safeEqual(await sha256b64url(verifier), row.code_challenge)) return oauthError('invalid_grant', 'PKCE check failed');
    return json(await issueTokens(env, clientId, row.user_id, row.cred), 200, { ...CORS, ...NO_STORE });
  }

  if (grant === 'refresh_token') {
    const refresh = str(b.refresh_token, 200);
    if (!refresh) return oauthError('invalid_request', 'refresh_token is required');
    const row = await env.DB.prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' RETURNING *")
      .bind(await hmac(env.SESSION_SECRET, 'ort:' + refresh))
      .first();
    if (!row || row.expires_at < now || row.client_id !== clientId) return oauthError('invalid_grant', 'The refresh token is invalid or expired');
    const user = await env.DB.prepare('SELECT role, pw_key FROM users WHERE id = ?').bind(row.user_id).first();
    const current = user ? (user.role === 'admin' ? await hmac(env.SESSION_SECRET, 'pw:' + env.ADMIN_PASSWORD) : user.pw_key) : null;
    if (!current || !safeEqual(current, row.cred)) return oauthError('invalid_grant', 'The password for this connection has changed. Connect again.');
    return json(await issueTokens(env, clientId, row.user_id, row.cred), 200, { ...CORS, ...NO_STORE });
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

// ---------- router ----------

export async function handleOAuth(request, env, url, ops) {
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });

  if (path.startsWith('/.well-known/')) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
    const m = metadata(url);
    const doc = path.startsWith('/.well-known/oauth-protected-resource') ? m.protectedResource : m.authorizationServer;
    return json(doc, 200, { ...CORS, 'cache-control': 'public, max-age=300' });
  }
  if (path === '/register' && request.method === 'POST') return register(request, env);
  if (path === '/authorize' && (request.method === 'GET' || request.method === 'POST')) return authorize(request, env, url, ops);
  if (path === '/token' && request.method === 'POST') return token(request, env);
  return new Response('Not found', { status: 404 });
}

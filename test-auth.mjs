import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker from './dist/server/index.js';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile('drizzle/0000_cloud.sql', 'utf8'));
sqlite.exec(await readFile('drizzle/0001_student_portal.sql', 'utf8'));
const stmt = (sql, args = []) => ({
  bind(...a) { return stmt(sql, a); },
  async first() { return sqlite.prepare(sql).get(...args) || null; },
  async all() { return {results: sqlite.prepare(sql).all(...args)}; },
  async run() { return {meta: {changes: Number(sqlite.prepare(sql).run(...args).changes)}}; },
});
const env = {
  SUPERADMIN_EMAIL: 'owner@test.local', GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
  TEACHER_SESSION_SECRET: 'test-only-teacher-session-secret-0123456789',
  DB: {prepare: sql => stmt(sql), async batch(list) { sqlite.exec('BEGIN'); try { for (const s of list) await s.run(); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }},
  BUCKET: {async put() {}, async get() { return null; }, async delete() {}},
};
const ORIGIN = 'https://yennie-cloud.yenniesense.workers.dev';
const req = (path, cookie = '') => worker.fetch(new Request(ORIGIN + path, {headers: cookie ? {cookie} : {}}), env);
const cookiesOf = res => Object.fromEntries((res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).map(c => [c.split('=')[0], c]));
const val = c => c.split(';')[0].split('=').slice(1).join('=');
const b64u = x => Buffer.from(x).toString('base64url');

let tokenClaims = null, tokenCalls = [];
globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://oauth2.googleapis.com/token') {
    tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
    if (!tokenClaims) return new Response('{"error":"invalid_grant"}', {status: 400});
    return Response.json({id_token: b64u('{"alg":"RS256"}') + '.' + b64u(JSON.stringify(tokenClaims)) + '.sig'});
  }
  throw new Error('unexpected fetch ' + url);
};

async function signIn({sub = 'g-1', email = 'teacher@test.local', returnTo = '/manager', claims = {}} = {}) {
  const start = await req('/auth/google?return_to=' + encodeURIComponent(returnTo));
  assert.equal(start.status, 302);
  const google = new URL(start.headers.get('location'));
  const oauth = cookiesOf(start).ys_oauth;
  tokenClaims = {iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, sub, email, email_verified: true, nonce: google.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 300, ...claims};
  const cb = await req('/auth/google/callback?code=abc&state=' + google.searchParams.get('state'), 'ys_oauth=' + val(oauth));
  return {start, google, oauth, cb, teacher: cookiesOf(cb).ys_teacher};
}

// Not configured -> fails closed.
const saved = env.GOOGLE_CLIENT_SECRET; delete env.GOOGLE_CLIENT_SECRET;
assert.equal((await req('/auth/google')).status, 503);
env.GOOGLE_CLIENT_SECRET = saved;

// Authorization request: PKCE S256, state, nonce, exact redirect URI, short-lived scoped cookie.
const first = await signIn();
assert.equal(first.google.origin + first.google.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
assert.equal(first.google.searchParams.get('redirect_uri'), ORIGIN + '/auth/google/callback');
assert.equal(first.google.searchParams.get('code_challenge_method'), 'S256');
assert.equal(first.google.searchParams.get('scope'), 'openid email profile');
assert.match(first.oauth, /Path=\/auth\/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax/);
assert.ok(!first.google.toString().includes(env.GOOGLE_CLIENT_SECRET));
assert.equal(tokenCalls.at(-1).redirect_uri, ORIGIN + '/auth/google/callback');
assert.ok(tokenCalls.at(-1).code_verifier.length >= 43);
// Successful callback sets the session and returns to the requested page.
assert.equal(first.cb.status, 302);
assert.equal(first.cb.headers.get('location'), '/manager');
assert.match(first.teacher, /^ys_teacher=.+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
const session = await (await req('/api/session', 'ys_teacher=' + val(first.teacher))).json();
assert.equal(session.email, 'teacher@test.local');
assert.equal(session.admin, false);
assert.equal((await req('/api/session')).status, 401, 'no cookie, no session');

// Rejections all land on the login page with an error and no session cookie.
for (const [label, opts] of [
  ['wrong audience', {claims: {aud: 'someone-else'}}], ['wrong issuer', {claims: {iss: 'https://evil.example'}}],
  ['nonce mismatch', {claims: {nonce: 'x'}}], ['unverified email', {claims: {email_verified: false}}], ['expired token', {claims: {exp: 1}}],
]) {
  const r = await signIn(opts);
  assert.equal(r.cb.status, 302, label);
  assert.match(r.cb.headers.get('location'), /^\/\?login_error=/, label);
  assert.equal(r.teacher, undefined, label);
}
{ // state mismatch / missing pending cookie / token endpoint failure
  const start = await req('/auth/google');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.match((await req('/auth/google/callback?code=a&state=wrong', 'ys_oauth=' + val(cookiesOf(start).ys_oauth))).headers.get('location'), /login_error/);
  assert.match((await req('/auth/google/callback?code=a&state=' + state)).headers.get('location'), /login_error/);
  tokenClaims = null;
  assert.match((await req('/auth/google/callback?code=a&state=' + state, 'ys_oauth=' + val(cookiesOf(start).ys_oauth))).headers.get('location'), /login_error/);
}
// No open redirect.
for (const bad of ['//evil.example/x', 'https://evil.example', '/\\evil.example']) assert.equal((await signIn({returnTo: bad})).cb.headers.get('location'), '/', bad);

// Tampered or foreign-signed session cookies are rejected.
const [data, mac] = val(first.teacher).split('.');
const forged = b64u(JSON.stringify({id: 'google:g-1', email: 'owner@test.local', exp: Math.floor(Date.now() / 1000) + 3600})) + '.' + mac;
assert.equal((await req('/api/workspace', 'ys_teacher=' + forged)).status, 401);
assert.equal((await req('/api/workspace', 'ys_teacher=' + data + '.' + mac.slice(0, -2) + 'AA')).status, 401);

// Legacy ChatGPT-keyed account is relinked once to the same verified Google email.
sqlite.exec("INSERT INTO workspaces(id,owner_id,title,data,revision) VALUES('w-legacy','user-chatgpt-1','Legacy','{\"students\":[{\"id\":\"s1\"}],\"classes\":[],\"notes\":[]}',2)");
sqlite.exec("INSERT INTO accounts(user_id,email,name,workspace_id,status) VALUES('user-chatgpt-1','Owner@Test.local','Owner','w-legacy','active')");
const owner = await signIn({sub: 'g-owner', email: 'owner@test.local'});
const ws = await (await req('/api/workspace', 'ys_teacher=' + val(owner.teacher))).json();
assert.equal(ws.id, 'w-legacy');
assert.equal(ws.data.students.length, 1);
assert.equal(sqlite.prepare("SELECT user_id FROM accounts WHERE workspace_id='w-legacy'").get().user_id, 'google:g-owner');
assert.equal(sqlite.prepare("SELECT owner_id FROM workspaces WHERE id='w-legacy'").get().owner_id, 'google:g-owner');
assert.ok(sqlite.prepare("SELECT 1 FROM audit WHERE action='account.relink.google'").get());
// A different Google account with the same email cannot take it over.
const other = await signIn({sub: 'g-other', email: 'owner@test.local'});
assert.equal((await req('/api/workspace', 'ys_teacher=' + val(other.teacher))).status, 403);
assert.equal(sqlite.prepare("SELECT user_id FROM accounts WHERE workspace_id='w-legacy'").get().user_id, 'google:g-owner');

// Old ChatGPT paths still work for bookmarks; sign-out clears the session.
assert.match((await req('/signin-with-chatgpt?return_to=%2Fsignup')).headers.get('location'), /^\/auth\/google\?return_to=%2Fsignup$/);
const out = await req('/auth/signout?return_to=%2F');
assert.match(cookiesOf(out).ys_teacher, /Max-Age=0/);
// Student portal does not need a teacher session.
assert.notEqual((await req('/student/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12))).status, 401);
console.log('PASS google sign-in: fail-closed config, PKCE/state/nonce, aud/iss/exp/email_verified checks, no open redirect, cookie integrity, legacy ChatGPT account relink (once, email-verified), old paths, sign-out.');

// Teacher codes and student-page addresses. Synthetic accounts only.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker from './dist/server/index.js';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys=ON');
sqlite.exec(await readFile('drizzle/0000_cloud.sql', 'utf8'));
sqlite.exec(await readFile('drizzle/0001_student_portal.sql', 'utf8'));
const stmt = (sql, args = []) => ({
  bind(...a) { return stmt(sql, a); },
  async first() { return sqlite.prepare(sql).get(...args) || null; },
  async all() { return {results: sqlite.prepare(sql).all(...args)}; },
  async run() { return {meta: {changes: Number(sqlite.prepare(sql).run(...args).changes)}}; },
});
const objects = new Map();
const env = {
  SUPERADMIN_EMAIL: 'owner@test.local', TEACHER_SESSION_SECRET: 'test-only-teacher-session-secret-0123456789', STUDENT_PORTAL_SECRET: 'test-only-random-secret',
  DB: {prepare: sql => stmt(sql), async batch(list) { sqlite.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }},
  BUCKET: {
    async put(k, b) { objects.set(k, b); }, async get(k) { return objects.has(k) ? {body: objects.get(k)} : null; },
    async delete(k) { for (const key of [].concat(k)) objects.delete(key); },
    async list({prefix, cursor}) { const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && (!cursor || k > cursor)).sort(), page = keys.slice(0, 2); return {objects: page.map(key => ({key})), truncated: keys.length > 2, cursor: page.at(-1)}; },
  },
};
const b64u = b => Buffer.from(b).toString('base64url');
async function cookie(id, mail = id + '@test.local') {
  const data = b64u(JSON.stringify({id, email: mail, exp: Math.floor(Date.now() / 1000) + 3600}));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TEACHER_SESSION_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return 'ys_teacher=' + data + '.' + b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('teacher-session-v1.' + data))));
}
async function call(path, {id = 'alice', mail, method = 'GET', data, bytes, extra = {}} = {}) {
  return worker.fetch(new Request('https://cloud.test' + path, {method, headers: {cookie: await cookie(id, mail), 'Content-Type': 'application/json', ...extra}, ...(data !== undefined ? {body: JSON.stringify(data)} : {}), ...(bytes ? {body: bytes} : {})}), env);
}
const admin = {id: 'owner', mail: 'owner@test.local'};
const page = (url, init = {}) => worker.fetch(new Request(url, init), env);

// Suggestion and rules.
assert.equal((await (await call('/api/teacher-code/suggest', {id: 'yennie.science', mail: 'Yennie.Science@test.local'})).json()).code, 'yennie-science');
for (const [code, ok] of [['ab', false], ['ab c', false], ['한글코드', false], ['a--b', false], ['-abc', false], ['abc-', false], ['admin', false], ['www', false], ['a'.repeat(31), false], ['abc', true], ['yennie-science-2', true], ['a'.repeat(30), true]]) {
  assert.equal((await (await call('/api/teacher-code/check?code=' + encodeURIComponent(code))).json()).ok, ok, code);
}

// Register with a code; a second teacher cannot take it.
assert.equal((await call('/api/register', {method: 'POST', data: {name: 'alice', title: 'alice room', code: 'alice-sci', adminAccessAcknowledged: true}})).status, 201);
assert.equal((await (await call('/api/teacher-code/check?code=alice-sci', {id: 'bob'})).json()).ok, false);
const dup = await call('/api/register', {id: 'bob', method: 'POST', data: {name: 'bob', title: 'bob room', code: 'alice-sci', adminAccessAcknowledged: true}});
assert.equal(dup.status, 400);
assert.equal(sqlite.prepare("SELECT count(*) n FROM accounts WHERE user_id='bob'").get().n, 0, 'nothing created on a taken code');
assert.equal((await call('/api/register', {id: 'bob', method: 'POST', data: {name: 'bob', title: 'bob room', code: 'Bad Code', adminAccessAcknowledged: true}})).status, 400);
assert.equal((await call('/api/register', {id: 'bob', method: 'POST', data: {name: 'bob', title: 'bob room', adminAccessAcknowledged: true}})).status, 201, 'code optional for older clients');
const alice = await (await call('/api/workspace')).json();
let info = await (await call('/api/teacher-code')).json();
assert.deepEqual(info, {code: 'alice-sci', canChange: true, url: 'https://cloud.test/s/alice-sci'});

// Student page by code: right workspace, student CSP and referrer, unknown code 404.
let res = await page('https://cloud.test/s/alice-sci');
assert.equal(res.status, 200);
assert.ok((await res.text()).includes('<meta name="ys-workspace" content="' + alice.id + '">'));
assert.match(res.headers.get('Content-Security-Policy'), /frame-src https:\/\/www\.youtube-nocookie\.com/);
assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
assert.equal(res.headers.get('X-Student-Page'), null);
assert.equal((await page('https://cloud.test/s/nobody-here')).status, 404);
// Old address redirects (query kept).
res = await page('https://cloud.test/student/' + alice.id + '?tab=learning');
assert.equal(res.status, 302);
assert.equal(res.headers.get('Location'), 'https://cloud.test/s/alice-sci?tab=learning');
// A teacher without a code keeps the old address.
const bob = await (await call('/api/workspace', {id: 'bob'})).json();
assert.equal((await page('https://cloud.test/student/' + bob.id)).status, 200);
assert.equal((await (await call('/api/teacher-code', {id: 'bob'})).json()).code, null);

// Student domain: student.<domain>/<code>, and redirects go there.
env.STUDENT_BASE = 'https://student.test';
res = await page('https://student.test/alice-sci');
assert.equal(res.status, 200);
assert.ok((await res.text()).includes(alice.id));
assert.equal((await page('https://cloud.test/alice-sci')).status, 404, 'bare code only on the student host');
assert.equal((await page('https://cloud.test/student/' + alice.id)).headers.get('Location'), 'https://student.test/alice-sci');
assert.equal((await (await call('/api/booking/data')).json()).portalUrl, 'https://student.test/alice-sci');
delete env.STUDENT_BASE;

// Student sign-in through the code page works as before (API by workspace id).
const aw = await (await call('/api/workspace')).json();
assert.equal((await call('/api/workspace', {method: 'PUT', data: {revision: aw.revision, data: {students: [{id: 's1', name: '가짜 학생'}], classes: [], notes: []}}})).status, 200);
const first = await (await call('/api/booking/students', {method: 'POST', data: {action: 'manager-upsert', managerId: 's1', nickname: 'fixture-one'}})).json();
assert.equal((await page('https://cloud.test/api/portal/' + alice.id + '/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(first.credentials[0])})).status, 200);

// One change: old code keeps working and is never reused; a second change is refused.
assert.equal((await call('/api/teacher-code', {method: 'POST', data: {code: 'alice-new'}})).status, 200);
info = await (await call('/api/teacher-code')).json();
assert.equal(info.code, 'alice-new');
assert.equal(info.canChange, false);
assert.equal((await page('https://cloud.test/s/alice-sci')).status, 200, 'printed QR codes keep working');
assert.equal((await call('/api/teacher-code', {method: 'POST', data: {code: 'alice-third'}})).status, 400);
assert.equal((await call('/api/teacher-code', {id: 'bob', method: 'POST', data: {code: 'alice-sci'}})).status, 400, 'old code is not given to others');
assert.equal((await call('/api/teacher-code', {id: 'bob', method: 'POST', data: {code: 'bob-math'}})).status, 200);
assert.equal((await call('/api/teacher-code?workspace=' + alice.id, {...admin, method: 'POST', data: {code: 'admin-set'}})).status, 403, 'support mode cannot change codes');

// Suspended teacher: code page closes.
for (const id of ['owner']) await call('/api/register', {id, mail: 'owner@test.local', method: 'POST', data: {name: id, title: id, adminAccessAcknowledged: true}});
assert.equal((await call('/api/admin/status', {...admin, method: 'POST', data: {userId: 'bob', status: 'suspended'}})).status, 200);
assert.equal((await page('https://cloud.test/s/bob-math')).status, 404);
console.log('PASS teacher codes: suggestion, rules and reserved words, unique at sign-up, /s/<code> and student.<domain>/<code>, old links redirect, one change with old code kept, closed when suspended.');

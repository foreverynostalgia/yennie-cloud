// Plans/usage, leaving (탈퇴), restore, the 30-day purge and rollback-blob clean-up.
// Synthetic accounts and files only.
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
for (const [id, mail] of [['alice'], ['bob'], ['owner', 'owner@test.local']]) assert.equal((await call('/api/register', {id, mail, method: 'POST', data: {name: id, title: id + ' room', adminAccessAcknowledged: true}})).status, 201);

// Usage: beta plan, student count, file bytes.
const ws = await (await call('/api/workspace')).json();
const students = Array.from({length: 12}, (_, i) => ({id: 's' + i, name: '가짜 ' + i}));
assert.equal((await call('/api/workspace', {method: 'PUT', data: {revision: ws.revision, data: {students, classes: [], notes: []}}})).status, 200);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
for (let i = 0; i < 3; i++) assert.equal((await call('/api/files', {method: 'POST', bytes: png, extra: {'Content-Type': 'image/png', 'X-File-Name': 'f' + i + '.png'}})).status, 201);
let usage = await (await call('/api/usage')).json();
assert.equal(usage.plan.id, 'beta');
assert.equal(usage.plan.students, null);
assert.equal(usage.students, 12);
assert.equal(usage.fileBytes, 24);
assert.ok(usage.records > 12 && usage.dataBytes > 0);
assert.deepEqual(usage.warn, []);
// A Free plan (15 students) shows the 80% warning at 12 students; 50-student add-ons raise the limit.
sqlite.prepare("INSERT INTO account_meta(user_id,plan) VALUES('alice','free')").run();
usage = await (await call('/api/usage')).json();
assert.equal(usage.plan.students, 15);
assert.deepEqual(usage.warn, ['students-80']);
sqlite.prepare("UPDATE account_meta SET plan='basic',extra_students=1 WHERE user_id='alice'").run();
assert.equal((await (await call('/api/usage')).json()).plan.students, 110);
sqlite.prepare("UPDATE account_meta SET plan='beta',extra_students=0 WHERE user_id='alice'").run();
assert.equal((await call('/api/usage?workspace=' + ws.id, {id: 'bob'})).status, 403);
assert.equal((await call('/api/usage?workspace=' + ws.id, admin)).status, 200);
console.log('PASS usage: plan limits (beta unlimited, Free 15, add-ons +50), student and file counts, 80% warning, isolation.');

// Student portal session for alice, to check it closes on leave.
const first = await (await call('/api/booking/students', {method: 'POST', data: {action: 'manager-upsert', managerId: 's1', nickname: 'fixture-one'}})).json();
const login = await worker.fetch(new Request('https://cloud.test/api/portal/' + ws.id + '/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(first.credentials[0])}), env);
assert.equal(login.status, 200);
const studentCookie = login.headers.get('Set-Cookie').split(';')[0];
const dashboard = () => worker.fetch(new Request('https://cloud.test/api/portal/' + ws.id + '/dashboard', {headers: {cookie: studentCookie}}), env);
assert.equal((await dashboard()).status, 200);

// Leaving: confirmation word, owner only, not the superadmin, not in support mode.
assert.equal((await call('/api/account/leave', {method: 'POST', data: {confirm: 'yes'}})).status, 400);
assert.equal((await call('/api/account/leave', {...admin, method: 'POST', data: {confirm: '탈퇴'}})).status, 400);
assert.equal((await call('/api/account/leave?workspace=' + ws.id, {...admin, method: 'POST', data: {confirm: '탈퇴'}})).status, 403);
const left = await call('/api/account/leave', {method: 'POST', data: {confirm: '탈퇴'}});
assert.equal(left.status, 200);
const deleteAfter = (await left.json()).deleteAfter;
assert.ok(Math.abs(Date.parse(deleteAfter) - Date.now() - 30 * 86400000) < 60000);
const session = await (await call('/api/session')).json();
assert.equal(session.account.status, 'leaving');
assert.equal(session.account.deleteAfter, deleteAfter);
assert.equal((await call('/api/workspace')).status, 403, 'use stops at once');
assert.equal((await dashboard()).status, 404, 'student page closes at once');
assert.equal((await call('/manager')).status, 302);
let list = (await (await call('/api/admin/accounts', admin)).json()).accounts;
assert.equal(list.find(a => a.user_id === 'alice').status, 'leaving');
assert.equal(list.find(a => a.user_id === 'alice').delete_after, deleteAfter);

// Admin can restore within 30 days.
assert.equal((await call('/api/admin/status', {...admin, method: 'POST', data: {userId: 'alice', status: 'active'}})).status, 200);
assert.equal((await call('/api/workspace')).status, 200);
assert.equal(sqlite.prepare("SELECT delete_after FROM account_meta WHERE user_id='alice'").get().delete_after, null);
assert.ok(sqlite.prepare("SELECT 1 FROM audit WHERE action='account.leave.cancel'").get());
console.log('PASS leaving: typed confirmation, owner only, stops use and student page at once, admin restore.');

// Purge: nothing happens before 30 days; after, every row and file of alice is gone and bob is untouched.
assert.equal((await call('/api/account/leave', {method: 'POST', data: {confirm: '탈퇴'}})).status, 200);
const bobWs = await (await call('/api/workspace', {id: 'bob'})).json();
assert.equal((await call('/api/workspace', {id: 'bob', method: 'PUT', data: {revision: bobWs.revision, data: {students: [{id: 'b', name: 'Bob 학생'}], classes: [], notes: []}}})).status, 200);
assert.equal((await call('/api/files', {id: 'bob', method: 'POST', bytes: png, extra: {'Content-Type': 'image/png', 'X-File-Name': 'bob.png'}})).status, 201);
const waits = [];
const run = when => worker.scheduled({scheduledTime: when}, env, {waitUntil: p => waits.push(p)}).then(() => Promise.all(waits));
await run(Date.now() + 29 * 86400000);
assert.ok(sqlite.prepare("SELECT 1 FROM accounts WHERE user_id='alice'").get(), 'kept before 30 days');
await run(Date.now() + 31 * 86400000);
for (const [table, where] of [['accounts', "user_id='alice'"], ['account_meta', "user_id='alice'"], ['workspaces', 'id=?'], ['files', 'workspace_id=?'], ['audit', 'workspace_id=?'], ['student_portals', 'workspace_id=?'], ['student_portal_sessions', 'workspace_id=?'], ['docs', "doc IN ('w:'||?, 'p:'||?)"], ['doc_records', "doc IN ('w:'||?, 'p:'||?)"]]) {
  const args = (where.match(/\?/g) || []).map(() => ws.id);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM ' + table + ' WHERE ' + where).get(...args).n, 0, table);
}
assert.equal([...objects.keys()].filter(k => k.startsWith('workspaces/' + ws.id + '/')).length, 0, 'files removed from storage (several pages)');
assert.ok(sqlite.prepare("SELECT 1 FROM audit WHERE action='account.purged' AND actor_id='system'").get());
assert.equal((await (await call('/api/workspace', {id: 'bob'})).json()).data.students[0].name, 'Bob 학생');
assert.equal([...objects.keys()].filter(k => k.startsWith('workspaces/' + bobWs.id + '/')).length, 1);
console.log('PASS purge: kept until day 30, then every row and stored file removed (other teachers untouched).');

// Rollback blobs are cleared 30 days after the copy, not before.
assert.equal((await call('/api/register', {id: 'carol', method: 'POST', data: {name: 'carol', title: 'carol room', adminAccessAcknowledged: true}})).status, 201);
const carolWs = await (await call('/api/workspace', {id: 'carol'})).json();
assert.equal((await call('/api/workspace', {id: 'carol', method: 'PUT', data: {revision: carolWs.revision, data: {students: [{id: 'c', name: 'Carol 학생'}], classes: [], notes: []}}})).status, 200);
const blob = () => sqlite.prepare('SELECT data FROM workspaces WHERE id=?').get(carolWs.id).data;
assert.notEqual(blob(), '{}');
await run(Date.now() + 10 * 86400000);
assert.notEqual(blob(), '{}');
await run(Date.now() + 31 * 86400000);
assert.equal(blob(), '{}');
assert.equal((await (await call('/api/workspace', {id: 'carol'})).json()).data.students[0].name, 'Carol 학생', 'records still read from the store');
console.log('PASS rollback blobs: kept 30 days after the copy, then cleared; records unaffected.');

// Student page now sends the origin so the YouTube player loads.
const page = await worker.fetch(new Request('https://cloud.test/student/' + bobWs.id), env);
assert.equal(page.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
assert.equal((await worker.fetch(new Request('https://cloud.test/'), env)).headers.get('Referrer-Policy'), 'no-referrer');
console.log('PASS student page referrer policy for the YouTube player.');

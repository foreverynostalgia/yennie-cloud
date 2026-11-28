// Daily backup, 30-day retention, restore drill for one teacher, server error log.
// Synthetic data only.
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

env.CLOUD_NOTICE_KEY = 'test-only-ops-key-abcdefghijklmnopqrstuvwxyz';
const ops = (method, data, key = env.CLOUD_NOTICE_KEY) => worker.fetch(new Request('https://cloud.test/api/admin/ops', {method, headers: {'Content-Type': 'application/json', ...(key ? {'X-Notice-Key': key} : {})}, ...(data ? {body: JSON.stringify(data)} : {})}), env);
const waits = [];
const cron = when => worker.scheduled({scheduledTime: when}, env, {waitUntil: p => waits.push(p)}).then(() => Promise.all(waits));
const day = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
for (const id of ['alice', 'bob']) assert.equal((await call('/api/register', {id, method: 'POST', data: {name: id, title: id + ' room', adminAccessAcknowledged: true}})).status, 201);
const put = async (id, students) => { const w = await (await call('/api/workspace', {id})).json(); assert.equal((await call('/api/workspace', {id, method: 'PUT', data: {revision: w.revision, data: {students, classes: [], notes: []}}})).status, 200); return w.id; };
const aliceId = await put('alice', Array.from({length: 3000}, (_, i) => ({id: 's' + i, name: '가짜 학생 ' + i, memo: 'x'.repeat(100)})));
const bobId = await put('bob', [{id: 'b', name: 'Bob 학생'}]);

// Day 1 backup.
const t0 = Date.parse('2026-12-01T19:00:00Z');
await cron(t0);
const d1 = day(t0);
const manifest = JSON.parse(String(objects.get('backups/' + d1 + '/manifest.json')));
assert.equal(manifest.tables.accounts.rows, 2);
assert.ok(manifest.tables.doc_records.rows > 3000);
assert.ok(manifest.tables.doc_records.parts >= 1);
assert.ok([...objects.keys()].some(k => k.startsWith('backups/' + d1 + '/doc_records.0000.jsonl.gz')));
assert.equal((await ops('GET', undefined, 'wrong')).status, 403);
assert.equal((await call('/api/admin/ops')).status, 403, 'teacher session cannot reach ops');
const status = await (await ops('GET')).json();
assert.equal(status.backup.day, d1);
console.log('PASS daily backup: every table paged into gzip parts with a manifest (' + manifest.tables.doc_records.rows + ' records), status visible to the admin site only.');

// Restore drill: alice loses data after the backup, then is restored; bob keeps his newer edit.
await put('alice', [{id: 'oops', name: '실수로 덮어씀'}]);
await put('bob', [{id: 'b', name: 'Bob 새 이름'}]);
const before = await (await call('/api/workspace', {id: 'alice'})).json();
assert.equal(before.data.students.length, 1);
const restored = await ops('POST', {action: 'restore', day: d1, workspaceId: aliceId});
assert.equal(restored.status, 200, await restored.clone().text());
const after = await (await call('/api/workspace?versions=1', {id: 'alice'})).json();
assert.equal(after.data.students.length, 3000);
assert.equal(after.data.students[2999].name, '가짜 학생 2999');
assert.ok(after.revision > before.revision, 'open pages see the restore as newer');
assert.equal((await (await call('/api/workspace', {id: 'bob'})).json()).data.students[0].name, 'Bob 새 이름', 'other teacher untouched');
// Saving after restore works with the new versions.
assert.equal((await call('/api/workspace/changes', {id: 'alice', method: 'POST', data: {changes: [{c: 'i:students', r: 's0', b: after.versions['i:students\u0001s0'], d: {id: 's0', name: '복구 후 수정'}}]}})).status, 200);
assert.ok(sqlite.prepare("SELECT 1 FROM audit WHERE workspace_id=? AND action=?").get(aliceId, 'workspace.restore:' + d1));
assert.equal((await ops('POST', {action: 'restore', day: '2020-01-01', workspaceId: aliceId})).status, 404);
assert.equal((await ops('POST', {action: 'restore', day: d1, workspaceId: 'missing'})).status, 404);
console.log('PASS restore drill: one teacher back to the day-1 backup (3,000 students), others untouched, saving works after, audited.');

// Retention: backups older than 30 days are removed.
for (let i = 1; i <= 31; i++) await cron(t0 + i * 86400000);
assert.ok(![...objects.keys()].some(k => k.startsWith('backups/' + d1 + '/')), 'day 1 removed after 30 days');
assert.ok([...objects.keys()].some(k => k.startsWith('backups/' + day(t0 + 2 * 86400000) + '/')), 'day 3 kept');
console.log('PASS backup retention: 30 days.');

// Error log: a failing upload is counted, without ids or file names.
const realPut = env.BUCKET.put;
env.BUCKET.put = async () => { throw new Error('storage down for ' + aliceId); };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
for (let i = 0; i < 2; i++) assert.equal((await call('/api/files', {method: 'POST', bytes: png, extra: {'Content-Type': 'image/png', 'X-File-Name': 'secret-name.png'}})).status, 500);
env.BUCKET.put = realPut;
const errors = (await (await ops('GET')).json()).errors;
assert.equal(errors.length, 1);
assert.equal(errors[0].count, 2);
assert.equal(errors[0].route, 'POST /api/files');
assert.ok(!JSON.stringify(errors).includes(aliceId) && !JSON.stringify(errors).includes('secret-name'));
console.log('PASS error log: server errors grouped and counted per day, no ids or file names kept.');

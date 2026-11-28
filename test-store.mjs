// Record store: codec round trip, migration from the old blob, per-record saves,
// conflicts, order merging, size, isolation and the manager page's save loop.
// Synthetic data only.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import worker from './dist/server/index.js';

// --- codec ---------------------------------------------------------------
const codec = vm.createContext({});
vm.runInContext(await readFile('src/store-codec.js', 'utf8'), codec);
const {storeEncode, storeDecode, storeSplit, storeDiff} = vm.runInContext('({storeEncode, storeDecode, storeSplit, storeDiff})', codec);
const roundTrip = x => JSON.parse(JSON.stringify(storeDecode([...storeEncode(x)].map(([k, t]) => [...storeSplit(k), t]))));
let seed = 7;
const rand = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
function randomValue(depth = 0) {
  switch (rand(depth > 3 ? 4 : 7)) {
    case 0: return rand(1000) - 500;
    case 1: return 'v' + rand(99);
    case 2: return rand(2) === 0;
    case 3: return null;
    case 4: return Array.from({length: rand(4)}, () => randomValue(depth + 1));
    case 5: return Object.fromEntries(Array.from({length: rand(4)}, (_, i) => ['k' + i + rand(9), randomValue(depth + 1)]));
    default: return Array.from({length: rand(5)}, (_, i) => ({id: rand(3) ? 'id' + i : 'dup', n: randomValue(depth + 1)}));
  }
}
for (let i = 0; i < 500; i++) {
  const x = Object.fromEntries(Array.from({length: rand(6)}, (_, j) => ['f' + j, randomValue()]));
  if (rand(5) === 0) x[''] = randomValue();
  assert.deepEqual(roundTrip(x), JSON.parse(JSON.stringify(x)));
}
const managerShape = {students: [{id: 's1', name: 'A'}, {id: 's2', name: 'B'}], classes: [], attendance: {'c1|2026-11-01': {s1: 'present'}}, tasks: [], scores: [{id: 'x', v: 1}], notes: [], settlementRules: {rate: 1}, 'yensense-weekly-history': [{id: 'h', start: '2026-11-01'}], list: [1, 2, 3], noIds: [{name: 'no id'}]};
assert.deepEqual(roundTrip(managerShape), managerShape);
assert.deepEqual(Object.keys(roundTrip(managerShape)), Object.keys(managerShape), 'field order kept');
assert.equal(Object.getPrototypeOf(roundTrip(JSON.parse('{"m":{"__proto__":{"x":1}}}')).m), Object.prototype, 'no prototype pollution through keys');
console.log('PASS codec: random round trips, manager shape, field order, prototype-safe keys.');

// --- server --------------------------------------------------------------
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
  SUPERADMIN_EMAIL: 'owner@test.local', TEACHER_SESSION_SECRET: 'test-only-teacher-session-secret-0123456789', STUDENT_PORTAL_SECRET: 'test-only-random-secret',
  DB: {prepare: sql => stmt(sql), async batch(list) { sqlite.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }},
  BUCKET: {async put() {}, async get() { return null; }, async delete() {}},
};
const b64u = b => Buffer.from(b).toString('base64url');
async function cookie(id, mail = id + '@test.local') {
  const data = b64u(JSON.stringify({id, email: mail, exp: Math.floor(Date.now() / 1000) + 3600}));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TEACHER_SESSION_SECRET), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return 'ys_teacher=' + data + '.' + b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('teacher-session-v1.' + data))));
}
async function call(path, {id = 'alice', mail, method = 'GET', data} = {}) {
  return worker.fetch(new Request('https://cloud.test' + path, {method, headers: {cookie: await cookie(id, mail), 'Content-Type': 'application/json'}, ...(data !== undefined ? {body: JSON.stringify(data)} : {})}), env);
}
const body = async res => ({status: res.status, ...(await res.json())});
for (const [id, mail] of [['alice'], ['bob'], ['carol'], ['owner', 'owner@test.local']]) {
  assert.equal((await call('/api/register', {id, mail, method: 'POST', data: {name: id, title: id + ' room', adminAccessAcknowledged: true}})).status, 201);
}

// Old blob already in place (as in production before this change) -> copied on first read, blob untouched.
const legacy = {students: [{id: 's1', name: 'Legacy one'}, {id: 's2', name: 'Legacy two'}], classes: [{id: 'c1', name: 'Science'}], notes: [], attendance: {'c1|2026-11-01': {s1: 'present'}}, settlementRules: {rate: 1}};
sqlite.prepare("UPDATE workspaces SET data=?,revision=5 WHERE owner_id='alice'").run(JSON.stringify(legacy));
const loaded = await (await call('/api/workspace?versions=1')).json();
assert.deepEqual(loaded.data, legacy);
assert.equal(loaded.revision, 5);
assert.ok(loaded.versions['i:students\u0001s1'] >= 1);
assert.equal(sqlite.prepare("SELECT data FROM workspaces WHERE owner_id='alice'").get().data, JSON.stringify(legacy), 'old blob kept as rollback copy');
const aliceDoc = 'w:' + loaded.id;
assert.equal(sqlite.prepare('SELECT count(*) n FROM doc_records WHERE doc=?').get(aliceDoc).n, 1 + 3 + 2 + 1 + 2 + 2, 'one row per record');

// Two devices editing different students both save; same student -> conflict for the second only.
const v = key => loaded.versions[key];
const change = (c, r, d, b) => ({c, r, b, d});
let res = await body(await call('/api/workspace/changes', {method: 'POST', data: {changes: [change('i:students', 's1', {id: 's1', name: 'Phone edit'}, v('i:students\u0001s1'))]}}));
assert.equal(res.status, 200);
res = await body(await call('/api/workspace/changes', {method: 'POST', data: {changes: [change('i:students', 's2', {id: 's2', name: 'Laptop edit'}, v('i:students\u0001s2'))]}}));
assert.equal(res.status, 200, 'different record from a stale device still saves');
res = await body(await call('/api/workspace/changes', {method: 'POST', data: {changes: [change('i:students', 's1', {id: 's1', name: 'Laptop edit of s1'}, v('i:students\u0001s1')), change('i:classes', 'c1', {id: 'c1', name: 'Changed'}, v('i:classes\u0001c1'))]}}));
assert.equal(res.status, 409);
assert.deepEqual(res.conflicts, [{c: 'i:students', r: 's1'}]);
let now = (await (await call('/api/workspace')).json()).data;
assert.deepEqual(now.students.map(s => s.name), ['Phone edit', 'Laptop edit']);
assert.equal(now.classes[0].name, 'Science', 'a rejected save writes nothing');

// Two devices add a student each from the same old list: both kept, order merged.
const order = ids => ({t: 'a', ids});
await call('/api/workspace/changes', {method: 'POST', data: {changes: [change('i:students', 'p', {id: 'p', name: 'From phone'}, 0), {c: '#o', r: 'students', d: order(['s1', 's2', 'p'])}]}});
await call('/api/workspace/changes', {method: 'POST', data: {changes: [change('i:students', 'l', {id: 'l', name: 'From laptop'}, 0), {c: '#o', r: 'students', d: order(['l', 's1', 's2'])}]}});
now = (await (await call('/api/workspace')).json()).data;
assert.deepEqual(now.students.map(s => s.id), ['l', 's1', 's2', 'p']);
// Creating an id that exists is a conflict; deleting with an old version is a conflict.
assert.equal((await call('/api/workspace/changes', {method: 'POST', data: {changes: [change('i:students', 'p', {id: 'p', name: 'Again'}, 0)]}})).status, 409);
assert.equal((await call('/api/workspace/changes', {method: 'POST', data: {changes: [{c: 'i:students', r: 's1', b: 1, del: true}]}})).status, 409);
const fresh = await (await call('/api/workspace?versions=1')).json();
assert.equal((await call('/api/workspace/changes', {method: 'POST', data: {changes: [{c: 'i:students', r: 's1', b: fresh.versions['i:students\u0001s1'], del: true}, {c: '#o', r: 'students', d: order(['l', 's2', 'p'])}]}})).status, 200);
assert.deepEqual((await (await call('/api/workspace')).json()).data.students.map(s => s.id), ['l', 's2', 'p']);

// Input checks.
for (const bad of [
  [{c: 'i:students', r: '__proto__', b: 0, d: {}}],
  [{c: 'x', r: 'a', b: 0, d: 1}],
  [{c: 'i:students', r: 'a', b: 0}],
  [{c: 'i:students', r: 'a', b: 0, d: {id: 'a', name: 5}}],
  [{c: '#o', r: 'students', d: {t: 'bad', ids: []}}],
  [{c: 'i:notes', r: 'n', b: 0, d: JSON.parse('{"__proto__":{"admin":true}}')}],
  [{c: 'i:a', r: 'x', b: 0, d: 1}, {c: 'i:a', r: 'x', b: 0, d: 2}],
]) assert.equal((await call('/api/workspace/changes', {method: 'POST', data: {changes: bad}})).status, 400, JSON.stringify(bad));
console.log('PASS store: blob migration (blob kept), per-record saves, conflicts only on the same record, merged order, deletes, input checks.');

// Isolation: bob's saves go to bob's doc; bob cannot target alice; admin can (audited).
assert.equal((await call('/api/workspace/changes?workspace=' + loaded.id, {id: 'bob', method: 'POST', data: {changes: [change('i:students', 'evil', {id: 'evil'}, 0)]}})).status, 403);
assert.equal((await call('/api/workspace/changes', {id: 'bob', method: 'POST', data: {changes: [change('i:students', 'b1', {id: 'b1', name: 'Bob student'}, 0)]}})).status, 200);
assert.ok(!(await (await call('/api/workspace')).json()).data.students.some(s => s.id === 'b1'));
assert.ok((await (await call('/api/workspace', {id: 'bob'})).json()).data.students.some(s => s.id === 'b1'));
const admin = {id: 'owner', mail: 'owner@test.local'};
assert.equal((await call('/api/workspace/changes?workspace=' + loaded.id, {...admin, method: 'POST', data: {changes: [change('i:notes', 'support', {id: 'support', body: 'admin note'}, 0)]}})).status, 200);
assert.ok(sqlite.prepare("SELECT 1 FROM audit WHERE workspace_id=? AND action='admin.workspace.update'").get(loaded.id));
const accounts = (await (await call('/api/admin/accounts', admin)).json()).accounts;
assert.ok(accounts.find(a => a.workspace_id === loaded.id).records > 0, 'admin list shows record counts');
console.log('PASS isolation: teachers only reach their own records, admin support writes are audited.');

// Size: 500 students, 3 classes, a year of attendance and scores -> well over the old 2MB blob limit.
const big = {students: [], classes: [], attendance: {}, scores: [], notes: [], tasks: []};
for (let i = 0; i < 500; i++) big.students.push({id: 'st' + i, name: '가짜 학생 ' + i, school: '테스트중', grade: '중' + (1 + i % 3), phone: '', memo: 'm'.repeat(200)});
for (let c = 0; c < 3; c++) big.classes.push({id: 'cl' + c, name: '가짜 수업 ' + c});
for (let d = 0; d < 365; d++) for (let c = 0; c < 3; c++) {
  const day = new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10);
  big.attendance['cl' + c + '|' + day] = Object.fromEntries(big.students.slice(c * 160, c * 160 + 160).map(s => [s.id, 'present']));
}
for (let i = 0; i < 6000; i++) big.scores.push({id: 'sc' + i, studentId: 'st' + (i % 500), score: i % 100, memo: '가짜 성적'});
const bigSize = JSON.stringify(big).length;
assert.ok(bigSize > 3 * 1024 * 1024, 'fixture is bigger than the old limit: ' + bigSize);

// The manager page's save loop (bootstrap.js) against the real worker, for carol.
const carolCookie = await cookie('carol');
const page = vm.createContext({
  console, URL, Blob, setTimeout, location: {reload() {}, replace() {}}, window: {addEventListener() {}},
  document: {querySelector: () => null},
  fetch: (path, init = {}) => worker.fetch(new Request('https://cloud.test' + path, {...init, headers: {...init.headers, cookie: carolCookie}}), env),
});
let requests = 0;
const pageFetch = page.fetch;
page.fetch = (...a) => { requests++; return pageFetch(...a); };
vm.runInContext(await readFile('src/store-codec.js', 'utf8'), page);
vm.runInContext((await readFile('src/manager/bootstrap.js', 'utf8')).replace('void cloudManagerStart();', ''), page);
async function openPage() {
  await vm.runInContext(`(async () => {
    cloudManagerWorkspace = await (await fetch('/api/workspace?versions=1')).json();
    cloudManagerData = cloudManagerWorkspace.data;
    cloudManagerSynced = storeEncode(cloudManagerData);
    cloudManagerVersions = new Map(Object.entries(cloudManagerWorkspace.versions || {}));
    cloudManagerBlocked.clear(); cloudManagerFailed = false;
  })()`, page);
}
const save = async value => { vm.runInContext('cloudManagerStorage.setItem("yensense-v1", ' + JSON.stringify(JSON.stringify(value)) + ')', page); while (vm.runInContext('cloudManagerSaving', page)) await new Promise(r => setTimeout(r, 5)); };
await openPage();
let t = Date.now();
await save(big);
const firstSave = Date.now() - t;
assert.equal(vm.runInContext('cloudManagerFailed', page), false);
assert.ok(requests > 3, 'large first save is split into several requests');
const stored = (await (await call('/api/workspace', {id: 'carol'})).json()).data;
for (const key of Object.keys(big)) assert.deepEqual(stored[key], big[key], key);
// A small edit afterwards sends one small request.
requests = 0;
big.students[10] = {...big.students[10], name: '이름 바꿈'};
t = Date.now();
await save(big);
const smallSave = Date.now() - t;
assert.equal(requests, 1);
assert.equal((await (await call('/api/workspace', {id: 'carol'})).json()).data.students[10].name, '이름 바꿈');
const carolRow = sqlite.prepare("SELECT records,bytes FROM docs WHERE doc=(SELECT 'w:'||id FROM workspaces WHERE owner_id='carol')").get();
assert.equal(carolRow.records, sqlite.prepare("SELECT count(*) n FROM doc_records WHERE doc=(SELECT 'w:'||id FROM workspaces WHERE owner_id='carol')").get().n, 'record count kept in step');

// Another device edits student 20 first: this page keeps saving other records and reports the one conflict.
const other = await (await call('/api/workspace?versions=1', {id: 'carol'})).json();
await call('/api/workspace/changes', {id: 'carol', method: 'POST', data: {changes: [change('i:students', 'st20', {...big.students[20], name: '다른 기기'}, other.versions['i:students\u0001st20'])]}});
big.students[20] = {...big.students[20], name: '이 기기'};
big.students[21] = {...big.students[21], name: '이 기기 21'};
await save(big);
assert.equal(vm.runInContext('cloudManagerBlocked.size', page), 1);
const after = (await (await call('/api/workspace', {id: 'carol'})).json()).data.students;
assert.equal(after[20].name, '다른 기기', 'the other device edit is not overwritten');
assert.equal(after[21].name, '이 기기 21', 'unrelated edit still saved');
console.log('PASS manager save loop: ' + (bigSize / 1048576).toFixed(1) + 'MB fixture (500 students, a year of attendance) saved in ' + firstSave + 'ms, small edit ' + smallSave + 'ms in one request, conflict kept to one record.');

// Student portal data: old blob copied once and saved per record from then on.
const carolWs = sqlite.prepare("SELECT id FROM workspaces WHERE owner_id='carol'").get().id;
const portalLegacy = {credentials: {}, slots: [{id: 'old-slot', courseId: 'cl0', date: '2027-01-01', start: '10:00', end: '11:00', capacity: 2}], bookings: [], exams: [], links: [], attempts: [], videos: [], courses: [], assignments: [], progress: [], notices: []};
sqlite.prepare('INSERT INTO student_portals(workspace_id,data,revision) VALUES(?,?,3)').run(carolWs, JSON.stringify(portalLegacy));
const portalData = await (await call('/api/booking/data', {id: 'carol'})).json();
assert.deepEqual(portalData.slots.map(s => s.id), ['old-slot']);
assert.ok(sqlite.prepare('SELECT 1 FROM docs WHERE doc=?').get('p:' + carolWs));
assert.equal(sqlite.prepare('SELECT data FROM student_portals WHERE workspace_id=?').get(carolWs).data, JSON.stringify(portalLegacy), 'old portal blob kept');
console.log('PASS student portal: old data copied once, old blob kept.');

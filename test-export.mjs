import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker from './dist/server/index.js';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile('drizzle/0000_cloud.sql', 'utf8'));
sqlite.exec(await readFile('drizzle/0001_student_portal.sql', 'utf8'));
sqlite.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB); INSERT INTO blobs VALUES('b1', x'00ff10')");
sqlite.exec("INSERT INTO workspaces(id,owner_id,title) VALUES('w1','u1','W')");
sqlite.exec("INSERT INTO accounts(user_id,email,name,workspace_id,status) VALUES('u1','t@test.local','T','w1','active')");
const objects = new Map([['w1/a.png', new Uint8Array([1, 2, 3])], ['w1/b.pdf', new Uint8Array([4, 5])]]);
const stmt = (sql, args = []) => ({
  bind(...a) { return stmt(sql, a); },
  async first() { return sqlite.prepare(sql).get(...args) || null; },
  async all() { return {results: sqlite.prepare(sql).all(...args)}; },
  async run() { sqlite.prepare(sql).run(...args); return {meta: {changes: 1}}; },
});
const writes = [];
const env = {
  SUPERADMIN_EMAIL: 'owner@test.local',
  DB: {prepare: sql => { if (/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i.test(sql)) writes.push(sql); return stmt(sql); }, async batch() { writes.push('batch'); }},
  BUCKET: {
    async list({cursor, limit}) {
      const keys = [...objects.keys()].sort(), start = Number(cursor || 0), page = keys.slice(start, start + Math.min(limit, 1));
      return {objects: page.map(key => ({key, size: objects.get(key).length, etag: 'e-' + key, uploaded: new Date(0)})), truncated: start + 1 < keys.length, cursor: String(start + 1)};
    },
    async get(key) { const b = objects.get(key); return b ? {key, size: b.length, etag: 'e', body: new Blob([b]).stream()} : null; },
    async put() { writes.push('put'); }, async delete() { writes.push('delete'); },
  },
};
const TOKEN = 'x'.repeat(40);
const get = (q, token) => worker.fetch(new Request('https://cloud.test/api/export?' + q, {headers: token ? {'X-Export-Token': token} : {}}), env);

// Disabled without a configured secret, even with a guessed header; short secrets also disabled.
assert.equal((await get('op=manifest', TOKEN)).status, 404);
env.EXPORT_TOKEN = 'short';
assert.equal((await get('op=manifest', 'short')).status, 404);
env.EXPORT_TOKEN = TOKEN;
assert.equal((await get('op=manifest')).status, 403);
assert.equal((await get('op=manifest', TOKEN + 'y')).status, 403);
assert.equal((await get('op=manifest', 'y'.repeat(40))).status, 403);
// Platform login headers do not substitute for the export token.
assert.equal((await worker.fetch(new Request('https://cloud.test/api/export?op=manifest', {headers: {'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@test.local'}}), env)).status, 403);
assert.equal((await worker.fetch(new Request('https://cloud.test/api/export?op=manifest', {method: 'POST', headers: {'X-Export-Token': TOKEN}}), env)).status, 405);

const manifest = await (await get('op=manifest', TOKEN)).json();
const names = manifest.tables.map(t => t.name);
assert.ok(names.includes('accounts') && names.includes('blobs'));
assert.equal(manifest.tables.find(t => t.name === 'accounts').rows, 1);
assert.ok(manifest.tables.every(t => typeof t.sql === 'string'));

assert.equal((await get('op=rows&table=' + encodeURIComponent('accounts; DROP TABLE accounts'), TOKEN)).status, 400);
const acc = await (await get('op=rows&table=accounts&limit=1', TOKEN)).json();
assert.equal(acc.rows[0].email, 't@test.local');
assert.equal(acc.done, false);
const acc2 = await (await get('op=rows&table=accounts&offset=1&limit=1', TOKEN)).json();
assert.equal(acc2.rows.length, 0);
assert.equal(acc2.done, true);
const blob = await (await get('op=rows&table=blobs', TOKEN)).json();
assert.deepEqual(blob.rows[0].data, {$b64: Buffer.from([0, 255, 16]).toString('base64')});

const keys = [];
let cursor = '';
for (let i = 0; i < 5; i++) {
  const page = await (await get('op=r2list' + (cursor ? '&cursor=' + cursor : ''), TOKEN)).json();
  keys.push(...page.objects.map(o => o.key));
  if (!page.cursor) break;
  cursor = page.cursor;
}
assert.deepEqual(keys, ['w1/a.png', 'w1/b.pdf']);
const obj = await get('op=r2get&key=' + encodeURIComponent('w1/a.png'), TOKEN);
assert.equal(obj.status, 200);
assert.deepEqual([...new Uint8Array(await obj.arrayBuffer())], [1, 2, 3]);
assert.equal((await get('op=r2get&key=missing', TOKEN)).status, 404);
assert.equal((await get('op=nope', TOKEN)).status, 400);
assert.deepEqual(writes, [], 'export must be read-only');
console.log('PASS export disabled without secret, token required, platform login not accepted, read-only, table allow-list, paging, BLOB encoding and R2 listing/download.');

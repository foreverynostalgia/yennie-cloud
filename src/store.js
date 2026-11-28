// Record store: each teacher's data (doc 'w:<workspace id>') and student-portal
// data (doc 'p:<workspace id>') live as many rows in doc_records instead of one
// JSON blob. Encoding is in store-codec.js. The old blobs (workspaces.data,
// student_portals.data) are copied once on first read and then left untouched,
// as a rollback copy.
const STORE_MAX_RECORD = 1500000;      // bytes of one record (D1 row limit is 2MB)
const STORE_MAX_DOC = 200 * 1024 * 1024;
const STORE_MAX_RECORDS = 300000;
const STORE_CHUNK = 800000;            // bytes of JSON per bulk statement
const STORE_SQL = [
  'CREATE TABLE IF NOT EXISTS docs (doc TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, records INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, migrated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS doc_records (doc TEXT NOT NULL, coll TEXT NOT NULL, rid TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (doc, coll, rid)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS doc_guard (ok INTEGER NOT NULL CHECK (ok = 1))',
];
let storeReady = null;
function ensureStoreTables(env) {
  return storeReady ??= env.DB.batch(STORE_SQL.map(sql => env.DB.prepare(sql))).catch(e => { storeReady = null; throw e; });
}
const storeBytes = text => new TextEncoder().encode(text).length;
function storeChunks(rows) {
  const out = []; let cur = [], size = 0;
  for (const row of rows) {
    const n = JSON.stringify(row).length;
    if (cur.length && size + n > STORE_CHUNK) { out.push(cur); cur = []; size = 0; }
    cur.push(row); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
const STORE_UPSERT = 'INSERT INTO doc_records(doc,coll,rid,data,version) SELECT ?, value->>0, value->>1, value->>2, value->>3 FROM json_each(?) WHERE true ON CONFLICT(doc,coll,rid) DO UPDATE SET data=excluded.data, version=excluded.version';
const STORE_DELETE = 'DELETE FROM doc_records WHERE doc=? AND (coll,rid) IN (SELECT value->>0, value->>1 FROM json_each(?))';

async function storeMigrate(env, doc, legacy) {
  const {data, revision = 0} = await legacy();
  const rows = [...storeEncode(data)].map(([key, text]) => [...storeSplit(key), text, 1]);
  for (const row of rows) if (storeBytes(row[2]) > STORE_MAX_RECORD) throw {status: 413, message: '기록 하나의 크기가 너무 큽니다.'};
  const bytes = rows.reduce((n, r) => n + storeBytes(r[2]), 0);
  const stmts = [env.DB.prepare('INSERT INTO docs(doc,revision,records,bytes,migrated_at) VALUES(?,?,?,?,?)').bind(doc, revision, rows.length, bytes, new Date().toISOString())];
  for (const chunk of storeChunks(rows)) stmts.push(env.DB.prepare(STORE_UPSERT).bind(doc, JSON.stringify(chunk)));
  try { await env.DB.batch(stmts); }
  catch (e) { if (!await env.DB.prepare('SELECT 1 FROM docs WHERE doc=?').bind(doc).first()) throw e; }
}

// Returns {doc, revision, data, text: Map key->json, ver: Map key->version}.
async function storeLoad(env, doc, legacy) {
  await ensureStoreTables(env);
  let head = await env.DB.prepare('SELECT revision FROM docs WHERE doc=?').bind(doc).first();
  if (!head) { await storeMigrate(env, doc, legacy); head = await env.DB.prepare('SELECT revision FROM docs WHERE doc=?').bind(doc).first(); }
  const rows = (await env.DB.prepare('SELECT coll,rid,data,version FROM doc_records WHERE doc=?').bind(doc).all()).results;
  const text = new Map(), ver = new Map();
  for (const r of rows) { const key = storeKey(r.coll, r.rid); text.set(key, r.data); ver.set(key, r.version); }
  return {doc, revision: head.revision, data: storeDecode(rows.map(r => [r.coll, r.rid, r.data])), text, ver};
}

function storeCheckValue(value) {
  let nodes = 0;
  const walk = (x, depth) => {
    if (++nodes > 150000 || depth > 18) throw {status: 400, message: '데이터 크기나 구조가 너무 큽니다.'};
    if (typeof x === 'string' && x.length > 100000) throw {status: 400, message: '입력 길이를 확인해 주세요.'};
    if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) throw {status: 400, message: '허용되지 않는 데이터입니다.'};
      walk(v, depth + 1);
    }
  };
  walk(value, 0);
}
const STORE_TYPED = ['students', 'classes', 'notes'];
// One change from a client: {c: coll, r: rid, d: value, b: base version} or {c, r, b, del: true}
function storeCheckChange(x) {
  if (!x || typeof x !== 'object' || typeof x.c !== 'string' || typeof x.r !== 'string') throw {status: 400, message: '저장 형식을 확인해 주세요.'};
  const {c, r} = x, del = x.del === true;
  if (!del && !Object.hasOwn(x, 'd')) throw {status: 400, message: '저장 형식을 확인해 주세요.'};
  if (c.length > 202 || r.length > 200 || c.includes(STORE_SEP) || r.includes(STORE_SEP)) throw {status: 400, message: '저장 형식을 확인해 주세요.'};
  if (['__proto__', 'prototype', 'constructor'].includes(r) || ['i:__proto__', 'i:prototype', 'i:constructor'].includes(c)) throw {status: 400, message: '허용되지 않는 데이터입니다.'};
  if (!(c === '#o' || c === '#f' || c.startsWith('i:') && c.length > 2)) throw {status: 400, message: '저장 형식을 확인해 주세요.'};
  if (!del) {
    storeCheckValue(x.d);
    if (c === '#o') {
      const o = x.d;
      if (!storePlain(o) || !['top', 'a', 'o'].includes(o.t) || (o.t === 'top') !== (r === '') || !Array.isArray(o.ids) || o.ids.some(id => typeof id !== 'string')) throw {status: 400, message: '저장 형식을 확인해 주세요.'};
    }
    const field = c.slice(2);
    if (c.startsWith('i:') && STORE_TYPED.includes(field)) {
      const item = x.d;
      if (!storePlain(item)) throw {status: 400, message: '목록의 항목 형식을 확인해 주세요.'};
      for (const f of ['id', 'name', 'title', 'school', 'grade', 'phone', 'day', 'time', 'memo', 'body']) if (item[f] !== undefined && typeof item[f] !== 'string') throw {status: 400, message: '항목의 입력 형식을 확인해 주세요.'};
    }
  }
  if (c !== '#o' && x.b !== undefined && (!Number.isSafeInteger(x.b) || x.b < 0)) throw {status: 400, message: '저장 버전을 확인하세요.'};
  return {key: storeKey(c, r), coll: c, rid: r, text: del ? null : JSON.stringify(x.d), base: c === '#o' ? null : (x.b ?? 0)};
}

// Applies changes ([{key, coll, rid, text|null, base|null}]; base null = no check, used
// for order records, which are merged). opts.revision: also require the whole doc to be
// at that revision. opts.extra: statements to run in the same transaction.
// Returns {revision, versions: {key: version}}; throws {status:409, conflicts:[{c,r}]}.
async function storeApply(env, doc, changes, opts = {}) {
  await ensureStoreTables(env);
  for (let attempt = 0; ; attempt++) {
    const head = await env.DB.prepare('SELECT revision,records,bytes FROM docs WHERE doc=?').bind(doc).first();
    if (!head) throw {status: 404, message: '저장 공간을 찾을 수 없습니다.'};
    if (opts.revision !== undefined && head.revision !== opts.revision) throw {status: 409, conflicts: [], message: '다른 탭이나 기기에서 먼저 변경했습니다. 새로 불러온 뒤 다시 수정해 주세요.'};
    // Read only what this save touches: the changed records, the order records, and
    // the ids of collections whose order changes (for merging).
    const touched = JSON.stringify(changes.map(x => [x.coll, x.rid]));
    const orderOf = changes.filter(x => x.coll === '#o' && x.text !== null);
    const memberColls = [...new Set(orderOf.flatMap(x => x.rid === '' ? ['#o', '#f'] : ['i:' + x.rid]))];
    const [touchedRows, orderRows, memberRows] = await Promise.all([
      env.DB.prepare('SELECT coll,rid,version,length(CAST(data AS BLOB)) AS size FROM doc_records WHERE doc=? AND (coll,rid) IN (SELECT value->>0, value->>1 FROM json_each(?))').bind(doc, touched).all(),
      orderOf.length ? env.DB.prepare("SELECT rid,data FROM doc_records WHERE doc=? AND coll='#o'").bind(doc).all() : {results: []},
      memberColls.length ? env.DB.prepare('SELECT coll,rid FROM doc_records WHERE doc=? AND coll IN (SELECT value FROM json_each(?))').bind(doc, JSON.stringify(memberColls)).all() : {results: []},
    ]);
    const cur = new Map(), orders = new Map();
    let records = head.records, bytes = head.bytes;
    for (const r of touchedRows.results) cur.set(storeKey(r.coll, r.rid), r);
    for (const r of orderRows.results) orders.set(r.rid, JSON.parse(r.data));
    const conflicts = changes.filter(x => x.base !== null && (cur.get(x.key)?.version ?? 0) !== x.base);
    if (conflicts.length) throw {status: 409, conflicts: conflicts.map(x => ({c: x.coll, r: x.rid})), message: '다른 기기에서 먼저 고친 기록이 있습니다.'};
    // Membership after this save, for merging order records.
    const present = new Set(memberRows.results.map(r => storeKey(r.coll, r.rid)));
    for (const x of changes) if (x.text === null) present.delete(x.key); else if (memberColls.includes(x.coll)) present.add(x.key);
    const members = new Map();  // coll -> [rid]
    for (const key of present) { const [c, r] = storeSplit(key); if (!members.has(c)) members.set(c, []); members.get(c).push(r); }
    const final = [];
    for (const x of changes) {
      if (x.coll !== '#o' || x.text === null) { final.push(x); continue; }
      const mine = JSON.parse(x.text), theirs = orders.get(x.rid);
      const pool = x.rid === ''
        ? new Set([...(members.get('#o') || []).filter(n => n !== ''), ...(members.get('#f') || [])])
        : new Set(members.get('i:' + x.rid) || []);
      const ids = [], seen = new Set();
      for (const id of [...mine.ids, ...(theirs?.ids || []), ...pool]) if (pool.has(id) && !seen.has(id)) { seen.add(id); ids.push(id); }
      final.push({...x, text: JSON.stringify({t: mine.t, ids})});
    }
    const puts = [], dels = [], versions = {};
    for (const x of final) {
      const old = cur.get(x.key);
      if (x.text === null) { if (old) { dels.push([x.coll, x.rid]); records--; bytes -= old.size; } continue; }
      const size = storeBytes(x.text);
      if (size > STORE_MAX_RECORD) throw {status: 413, message: '기록 하나의 크기가 너무 큽니다. 내용을 나눠 저장해 주세요.'};
      const version = (old?.version ?? 0) + 1;
      puts.push([x.coll, x.rid, x.text, version]); versions[x.key] = version;
      if (old) bytes -= old.size; else records++;
      bytes += size;
    }
    if (bytes > STORE_MAX_DOC || records > STORE_MAX_RECORDS) throw {status: 413, message: '저장 공간 한도를 초과했습니다.'};
    const stmts = [
      env.DB.prepare('UPDATE docs SET revision=revision+1,records=?,bytes=? WHERE doc=? AND revision=?').bind(records, bytes, doc, head.revision),
      env.DB.prepare('INSERT INTO doc_guard(ok) SELECT 0 WHERE changes()=0'),
    ];
    for (const chunk of storeChunks(dels)) stmts.push(env.DB.prepare(STORE_DELETE).bind(doc, JSON.stringify(chunk)));
    for (const chunk of storeChunks(puts)) stmts.push(env.DB.prepare(STORE_UPSERT).bind(doc, JSON.stringify(chunk)));
    stmts.push(...(opts.extra || []));
    try {
      await env.DB.batch(stmts);
      return {revision: head.revision + 1, versions};
    } catch (e) {
      // Another save landed between our read and write: read again and retry.
      if (/CHECK constraint/i.test(String(e?.message || e)) && attempt < 4 && !opts.extra?.length) continue;
      if (/CHECK constraint/i.test(String(e?.message || e))) throw {status: 409, conflicts: [], message: '다른 탭이나 기기에서 먼저 변경했습니다. 새로 불러온 뒤 다시 수정해 주세요.'};
      throw e;
    }
  }
}

// Saves a whole new data object against what was loaded (server-side diff).
function storeChangesFor(loaded, nextData) {
  return storeDiff(loaded.text, storeEncode(nextData)).map(([key, text]) => {
    const [coll, rid] = storeSplit(key);
    return {key, coll, rid, text, base: coll === '#o' ? null : (loaded.ver.get(key) ?? 0)};
  });
}
async function storeSaveData(env, loaded, nextData, opts = {}) {
  const changes = storeChangesFor(loaded, nextData);
  if (!changes.length && !opts.extra?.length && opts.revision === undefined) return {revision: loaded.revision, versions: {}};
  return storeApply(env, loaded.doc, changes, opts);
}
const storeVersions = loaded => Object.fromEntries(loaded.ver);

// Workspace and portal docs with their legacy blobs.
const workspaceDoc = id => 'w:' + id;
const portalDoc = id => 'p:' + id;
async function loadWorkspaceData(env, w) {
  return storeLoad(env, workspaceDoc(w.id), async () => {
    const row = await env.DB.prepare('SELECT data,revision FROM workspaces WHERE id=?').bind(w.id).first();
    return {data: JSON.parse(row?.data || '{}'), revision: row?.revision ?? 0};
  });
}
async function loadPortalData(env, workspaceId) {
  return storeLoad(env, portalDoc(workspaceId), async () => {
    const row = await env.DB.prepare('SELECT data,revision FROM student_portals WHERE workspace_id=?').bind(workspaceId).first();
    return {data: row ? JSON.parse(row.data) : portalEmpty(), revision: row?.revision ?? 0};
  });
}

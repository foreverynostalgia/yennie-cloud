// Daily backup to R2, per-teacher restore, and a server error log.
// Backups: backups/<YYYY-MM-DD>/<table>.<part>.jsonl.gz + manifest.json, kept 30 days.
// Uploaded files already live in R2 and are not copied again; D1 Time Travel
// (point-in-time restore of the whole database) is the first line of recovery.
const BACKUP_KEEP_DAYS = 30;
const BACKUP_PART_BYTES = 8 * 1024 * 1024;
const BACKUP_PAGE = 2000;
const BACKUP_TABLES = [
  ['accounts', ['user_id']], ['account_meta', ['user_id']], ['workspaces', ['id']], ['files', ['id']],
  ['audit', ['id']], ['student_portals', ['workspace_id']], ['teacher_notices', ['id']],
  ['docs', ['doc']], ['doc_records', ['doc', 'coll', 'rid']],
];
const OPS_SQL = [
  'CREATE TABLE IF NOT EXISTS ops_status (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS error_log (day TEXT NOT NULL, route TEXT NOT NULL, message TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_at TEXT NOT NULL, PRIMARY KEY (day, route, message))',
];
let opsReady = null;
function ensureOpsTables(env) {
  return opsReady ??= env.DB.batch(OPS_SQL.map(sql => env.DB.prepare(sql))).catch(e => { opsReady = null; throw e; });
}
const kstDay = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function dailyBackup(env, now = Date.now()) {
  if (!env.BUCKET) return null;
  for (const ensure of [ensureOpsTables, ensureStoreTables, ensureAccountTables, ensureNoticeTable]) await ensure(env);
  const day = kstDay(now), prefix = 'backups/' + day + '/', manifest = {day, startedAt: new Date(now).toISOString(), tables: {}};
  for (const [table, keys] of BACKUP_TABLES) {
    let after = null, part = 0, lines = [], size = 0, rows = 0;
    const flush = async () => {
      if (!lines.length) return;
      await env.BUCKET.put(prefix + table + '.' + String(part++).padStart(4, '0') + '.jsonl.gz', await gzip(lines.join('\n') + '\n'), {httpMetadata: {contentType: 'application/gzip'}});
      lines = []; size = 0;
    };
    for (;;) {
      const cols = keys.join(','), where = after ? ' WHERE (' + cols + ') > (' + keys.map(() => '?').join(',') + ')' : '';
      const page = (await env.DB.prepare('SELECT * FROM ' + table + where + ' ORDER BY ' + cols + ' LIMIT ' + BACKUP_PAGE).bind(...(after || [])).all()).results;
      for (const row of page) {
        const line = JSON.stringify(row);
        lines.push(line); size += line.length; rows++;
        if (size >= BACKUP_PART_BYTES) await flush();
      }
      if (page.length < BACKUP_PAGE) break;
      after = keys.map(k => page[page.length - 1][k]);
    }
    await flush();
    manifest.tables[table] = {rows, parts: part};
  }
  manifest.finishedAt = new Date().toISOString();
  await env.BUCKET.put(prefix + 'manifest.json', JSON.stringify(manifest), {httpMetadata: {contentType: 'application/json'}});
  // Keep 30 days.
  const oldest = kstDay(now - BACKUP_KEEP_DAYS * 86400000);
  let cursor;
  do {
    const list = await env.BUCKET.list({prefix: 'backups/', cursor});
    const stale = list.objects.map(o => o.key).filter(k => k.slice(8, 18) < oldest);
    if (stale.length) await env.BUCKET.delete(stale);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.DB.prepare('INSERT INTO ops_status(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').bind('backup.last', JSON.stringify(manifest), new Date().toISOString()).run();
  return manifest;
}

// Restore one teacher's records (workspace + student portal) from a day's backup.
// Accounts, files and other teachers are not touched. Audited.
async function restoreWorkspace(env, day, workspaceId, actor = 'admin-site') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || typeof workspaceId !== 'string' || !workspaceId) throw {status: 400, message: '날짜와 공간을 확인해 주세요.'};
  if (!await env.DB.prepare('SELECT 1 FROM workspaces WHERE id=?').bind(workspaceId).first()) throw {status: 404, message: '공간을 찾을 수 없습니다.'};
  const manifest = await env.BUCKET.get('backups/' + day + '/manifest.json');
  if (!manifest) throw {status: 404, message: '그날의 백업이 없습니다.'};
  const {tables} = JSON.parse(await new Response(manifest.body).text());
  const wanted = new Set([workspaceDoc(workspaceId), portalDoc(workspaceId)]);
  const read = async table => {
    const out = [];
    for (let i = 0; i < (tables[table]?.parts || 0); i++) {
      const obj = await env.BUCKET.get('backups/' + day + '/' + table + '.' + String(i).padStart(4, '0') + '.jsonl.gz');
      const text = await gunzip(new Uint8Array(await new Response(obj.body).arrayBuffer()));
      for (const line of text.split('\n')) if (line) { const row = JSON.parse(line); if (wanted.has(row.doc)) out.push(row); }
    }
    return out;
  };
  const [heads, records] = [await read('docs'), await read('doc_records')];
  if (!heads.some(h => h.doc === workspaceDoc(workspaceId))) throw {status: 404, message: '그날 백업에 이 공간의 기록이 없습니다.'};
  const current = await env.DB.prepare('SELECT doc,revision FROM docs WHERE doc IN (?,?)').bind(...wanted).all();
  const revision = new Map(current.results.map(r => [r.doc, r.revision]));
  const stmts = [env.DB.prepare('DELETE FROM doc_records WHERE doc IN (?,?)').bind(...wanted), env.DB.prepare('DELETE FROM docs WHERE doc IN (?,?)').bind(...wanted)];
  // Revisions move forward so open pages see the restore as a newer version.
  for (const h of heads) stmts.push(env.DB.prepare('INSERT INTO docs(doc,revision,records,bytes,migrated_at) VALUES(?,?,?,?,?)').bind(h.doc, Math.max(h.revision, revision.get(h.doc) ?? 0) + 1, h.records, h.bytes, h.migrated_at));
  const byDoc = new Map();
  for (const r of records) { if (!byDoc.has(r.doc)) byDoc.set(r.doc, []); byDoc.get(r.doc).push([r.coll, r.rid, r.data, r.version + 1]); }
  for (const [doc, rows] of byDoc) for (const chunk of storeChunks(rows)) stmts.push(env.DB.prepare(STORE_UPSERT).bind(doc, JSON.stringify(chunk)));
  stmts.push(env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(), actor, workspaceId, 'workspace.restore:' + day));
  await env.DB.batch(stmts);
  return {day, records: records.length};
}

// Server errors (status 500), grouped per KST day, route shape and message.
// No request bodies, ids or personal data are stored.
const routeShape = path => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').slice(0, 120);
async function recordError(env, request, error) {
  try {
    const message = String(error?.name || 'Error') + ': ' + String(error?.message || error).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').slice(0, 200);
    console.error('server error', request.method, routeShape(new URL(request.url).pathname), message);
    if (!env.DB) return;
    await ensureOpsTables(env);
    const now = new Date();
    await env.DB.prepare('INSERT INTO error_log(day,route,message,count,last_at) VALUES(?,?,?,1,?) ON CONFLICT(day,route,message) DO UPDATE SET count=count+1, last_at=excluded.last_at').bind(kstDay(now.getTime()), request.method + ' ' + routeShape(new URL(request.url).pathname), message, now.toISOString()).run();
  } catch {}
}

// Admin-site channel (same key as teacher notices): backup status, errors, restore.
async function opsAdmin(r, env) {
  if (!env.DB) return json({error: '클라우드 저장소를 준비 중입니다.'}, 503);
  if (!env.CLOUD_NOTICE_KEY || !await sameKey(r.headers.get('x-notice-key'), env.CLOUD_NOTICE_KEY)) return json({error: '운영 권한이 없습니다.'}, 403);
  await ensureOpsTables(env);
  if (r.method === 'GET') {
    const last = await env.DB.prepare("SELECT value,updated_at FROM ops_status WHERE key='backup.last'").first();
    const errors = await env.DB.prepare('SELECT day,route,message,count,last_at FROM error_log WHERE day>=? ORDER BY day DESC,count DESC LIMIT 200').bind(kstDay(Date.now() - 7 * 86400000)).all();
    return json({backup: last ? JSON.parse(last.value) : null, errors: errors.results});
  }
  if (r.method === 'POST') {
    const x = await readJson(r, 4096);
    if (x?.action === 'restore') return json(await restoreWorkspace(env, x.day, x.workspaceId));
    if (x?.action === 'backup') return json(await dailyBackup(env));
    return json({error: '알 수 없는 요청입니다.'}, 400);
  }
  return json({error: 'Method Not Allowed'}, 405);
}

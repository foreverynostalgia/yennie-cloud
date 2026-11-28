// Plans, usage, leaving (탈퇴) and the daily clean-up run.
// Plan limits from plan.md 6-5 ⑥ (approved 2026-11-28). During the beta every
// account is on 'beta': limits are shown, not enforced (billing comes in step 6).
const PLANS = {
  beta:   {name: '베타',    students: null, fileBytes: 100 * 1024 * 1024},
  free:   {name: 'Free',   students: 15,   fileBytes: 100 * 1024 * 1024},
  basic:  {name: 'Basic',  students: 60,   fileBytes: 100 * 1024 * 1024},
  expert: {name: 'Expert', students: 150,  fileBytes: 100 * 1024 * 1024},
};
const LEAVE_DAYS = 30;
const LEGACY_KEEP_DAYS = 30;
const ACCOUNT_SQL = [
  "CREATE TABLE IF NOT EXISTS account_meta (user_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'beta', extra_students INTEGER NOT NULL DEFAULT 0, leave_requested_at TEXT, delete_after TEXT)",
  'CREATE INDEX IF NOT EXISTS account_meta_delete ON account_meta(delete_after)',
];
let accountReady = null;
function ensureAccountTables(env) {
  return accountReady ??= env.DB.batch(ACCOUNT_SQL.map(sql => env.DB.prepare(sql))).catch(e => { accountReady = null; throw e; });
}
async function accountMeta(env, userId) {
  await ensureAccountTables(env);
  return await env.DB.prepare('SELECT * FROM account_meta WHERE user_id=?').bind(userId).first() || {user_id: userId, plan: 'beta', extra_students: 0, leave_requested_at: null, delete_after: null};
}
function planLimits(meta) {
  const plan = PLANS[meta.plan] || PLANS.beta;
  return {id: PLANS[meta.plan] ? meta.plan : 'beta', name: plan.name, students: plan.students === null ? null : plan.students + 50 * (meta.extra_students || 0), fileBytes: plan.fileBytes};
}
async function workspaceUsage(env, w, ownerId) {
  await ensureStoreTables(env);
  let head = await env.DB.prepare('SELECT records,bytes FROM docs WHERE doc=?').bind(workspaceDoc(w.id)).first();
  if (!head) { await loadWorkspaceData(env, w); head = await env.DB.prepare('SELECT records,bytes FROM docs WHERE doc=?').bind(workspaceDoc(w.id)).first(); }
  const students = (await env.DB.prepare("SELECT count(*) AS n FROM doc_records WHERE doc=? AND coll='i:students'").bind(workspaceDoc(w.id)).first()).n;
  const files = await env.DB.prepare('SELECT file_bytes FROM workspaces WHERE id=?').bind(w.id).first();
  const limits = planLimits(await accountMeta(env, ownerId));
  const warn = [];
  if (limits.students !== null && students >= limits.students * 0.8) warn.push(students >= limits.students ? 'students-full' : 'students-80');
  if (files.file_bytes >= limits.fileBytes * 0.8) warn.push(files.file_bytes >= limits.fileBytes ? 'files-full' : 'files-80');
  return {plan: limits, students, fileBytes: files.file_bytes, dataBytes: head.bytes, records: head.records, warn};
}

// Owner asks to leave: stop use now, delete everything after LEAVE_DAYS.
async function requestLeave(env, u, a, x) {
  if (u.admin) throw {status: 400, message: '전체 관리자 계정은 탈퇴할 수 없습니다.'};
  if (!x || x.confirm !== '탈퇴') throw {status: 400, message: '확인 칸에 “탈퇴”를 입력해 주세요.'};
  await ensureAccountTables(env);
  const now = new Date(), after = new Date(now.getTime() + LEAVE_DAYS * 86400000);
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET status='leaving' WHERE user_id=? AND status='active'").bind(u.id),
    env.DB.prepare('INSERT INTO account_meta(user_id,leave_requested_at,delete_after) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET leave_requested_at=excluded.leave_requested_at, delete_after=excluded.delete_after').bind(u.id, now.toISOString(), after.toISOString()),
    env.DB.prepare('DELETE FROM student_portal_sessions WHERE workspace_id=?').bind(a.workspace_id),
    env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(), u.id, a.workspace_id, 'account.leave'),
  ]);
  return {deleteAfter: after.toISOString()};
}

async function purgeAccount(env, a) {
  const wid = a.workspace_id;
  if (env.BUCKET?.list) {
    let cursor;
    do {
      const page = await env.BUCKET.list({prefix: 'workspaces/' + wid + '/', cursor});
      const keys = page.objects.map(o => o.key);
      if (keys.length) await env.BUCKET.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM doc_records WHERE doc IN (?,?)').bind(workspaceDoc(wid), portalDoc(wid)),
    env.DB.prepare('DELETE FROM docs WHERE doc IN (?,?)').bind(workspaceDoc(wid), portalDoc(wid)),
    env.DB.prepare('DELETE FROM files WHERE workspace_id=?').bind(wid),
    env.DB.prepare('DELETE FROM student_portal_sessions WHERE workspace_id=?').bind(wid),
    env.DB.prepare('DELETE FROM student_portals WHERE workspace_id=?').bind(wid),
    env.DB.prepare('DELETE FROM audit WHERE workspace_id=?').bind(wid),
    env.DB.prepare('DELETE FROM account_meta WHERE user_id=?').bind(a.user_id),
    env.DB.prepare('DELETE FROM accounts WHERE user_id=?').bind(a.user_id),
    env.DB.prepare('DELETE FROM workspaces WHERE id=?').bind(wid),
    env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(), 'system', null, 'account.purged'),
  ]);
}

// Daily (cron): delete accounts whose 30 days have passed; drop old rollback blobs.
async function dailyCleanup(env, now = Date.now()) {
  await Promise.all([ensureAccountTables(env), ensureStoreTables(env)]);
  const due = (await env.DB.prepare("SELECT a.user_id,a.workspace_id FROM accounts a JOIN account_meta m ON m.user_id=a.user_id WHERE a.status='leaving' AND m.delete_after IS NOT NULL AND m.delete_after<=? LIMIT 50").bind(new Date(now).toISOString()).all()).results;
  for (const a of due) await purgeAccount(env, a);
  const cutoff = new Date(now - LEGACY_KEEP_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE workspaces SET data='{}' WHERE data<>'{}' AND id IN (SELECT substr(doc,3) FROM docs WHERE doc LIKE 'w:%' AND migrated_at<=?)").bind(cutoff),
    env.DB.prepare("UPDATE student_portals SET data='{}' WHERE data<>'{}' AND workspace_id IN (SELECT substr(doc,3) FROM docs WHERE doc LIKE 'p:%' AND migrated_at<=?)").bind(cutoff),
  ]);
  return {purged: due.length};
}

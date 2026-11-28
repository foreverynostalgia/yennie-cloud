// Teacher codes: short student-page addresses (plan.md 6-8 1-d).
//   https://student.yenniesense.com/<code>  (STUDENT_BASE secret, once the domain exists)
//   <this site>/s/<code>                    (works on every host, used until then)
// Old /student/<workspace id> links redirect to the code address once a code is set.
// A code can be changed once; the old code keeps pointing to the same teacher so
// printed QR codes keep working, and it is never given to anyone else.
const CODE_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,28}[a-z0-9]$/;
const CODE_RESERVED = new Set(['admin', 'www', 'api', 'app', 'student', 'students', 'teacher', 'help', 'signup', 'login', 'logout', 'signin', 'signout', 'auth', 'privacy', 'terms', 'manager', 'cloud', 'support', 'mail', 'email', 'static', 'assets', 'yennie', 'yenniesense', 'yennie-sense', 'booking', 'about', 'pricing', 'blog', 'status', 'dashboard', 'root', 'test', 'demo', 'official', 'notice', 'notices', 'billing', 'pay', 'payment', 'icon', 'favicon', 'robots', 'sitemap', 'manifest']);
const CODE_SQL = [
  'CREATE TABLE IF NOT EXISTS teacher_codes (code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS teacher_codes_workspace ON teacher_codes(workspace_id, current)',
];
let codeReady = null;
function ensureCodeTables(env) {
  return codeReady ??= env.DB.batch(CODE_SQL.map(sql => env.DB.prepare(sql))).catch(e => { codeReady = null; throw e; });
}
function codeProblem(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return '영문 소문자 · 숫자 · 하이픈(-)으로 3~30자, 처음과 끝은 영문이나 숫자로 써 주세요.';
  if (CODE_RESERVED.has(code)) return '이 코드는 쓸 수 없어요. 다른 코드를 골라 주세요.';
  return '';
}
function codeSuggestion(email, title) {
  const base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return codeProblem(base) ? 'teacher-' + Math.random().toString(36).slice(2, 7) : base;
}
async function currentCode(env, workspaceId) {
  await ensureCodeTables(env);
  return (await env.DB.prepare('SELECT code FROM teacher_codes WHERE workspace_id=? AND current=1').bind(workspaceId).first())?.code || null;
}
async function codeChanges(env, workspaceId) {
  return (await env.DB.prepare('SELECT count(*) AS n FROM teacher_codes WHERE workspace_id=?').bind(workspaceId).first()).n;
}
async function codeAvailable(env, code) {
  const problem = codeProblem(code);
  if (problem) return {ok: false, reason: problem};
  await ensureCodeTables(env);
  if (await env.DB.prepare('SELECT 1 FROM teacher_codes WHERE code=?').bind(code).first()) return {ok: false, reason: '이미 쓰고 있는 코드예요. 다른 코드를 골라 주세요.'};
  return {ok: true};
}
// First set, or one change. Returns statements so register can run them in its batch.
async function codeStatements(env, workspaceId, code) {
  const free = await codeAvailable(env, code);
  if (!free.ok) throw {status: 400, message: free.reason};
  const used = await codeChanges(env, workspaceId);
  if (used >= 2) throw {status: 400, message: '강사 코드는 한 번만 바꿀 수 있어요. 더 바꾸려면 운영자에게 문의해 주세요.'};
  return [
    env.DB.prepare('UPDATE teacher_codes SET current=0 WHERE workspace_id=?').bind(workspaceId),
    env.DB.prepare('INSERT INTO teacher_codes(code,workspace_id,current,created_at) VALUES(?,?,1,?)').bind(code, workspaceId, new Date().toISOString()),
  ];
}
async function setTeacherCode(env, u, w, code) {
  const before = await currentCode(env, w.id);
  try {
    await env.DB.batch([...await codeStatements(env, w.id, code), env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(), u.id, w.id, before ? 'code.change' : 'code.set')]);
  } catch (e) {
    if (e?.status) throw e;
    if (/UNIQUE|PRIMARY/i.test(String(e?.message))) throw {status: 400, message: '이미 쓰고 있는 코드예요. 다른 코드를 골라 주세요.'};
    throw e;
  }
  return codeInfo(env, w.id, null);
}
function studentBase(env, origin) {
  const base = String(env.STUDENT_BASE || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/.test(base) ? base : origin + '/s';
}
async function codeInfo(env, workspaceId, origin) {
  const code = await currentCode(env, workspaceId), used = await codeChanges(env, workspaceId);
  return {code, canChange: used < 2, url: code && origin ? studentBase(env, origin) + '/' + code : null};
}
// Which workspace a student address belongs to (current or old code), active accounts only.
async function workspaceForCode(env, code) {
  if (codeProblem(code)) return null;
  await ensureCodeTables(env);
  return env.DB.prepare("SELECT w.* FROM teacher_codes c JOIN workspaces w ON w.id=c.workspace_id JOIN accounts a ON a.workspace_id=w.id WHERE c.code=? AND a.status='active'").bind(code).first();
}
function studentHtml(workspaceId) {
  return STUDENT['index.html'].replace('<head>', '<head><meta name="ys-workspace" content="' + workspaceId + '">');
}

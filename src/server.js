const json=(data,status=200)=>Response.json(data,{status});
const uid=()=>crypto.randomUUID();
const emptyData=()=>({students:[],classes:[],notes:[]});
const foreign=r=>{const s=r.headers.get('sec-fetch-site'),o=r.headers.get('origin');return ['cross-site','same-site'].includes(s)||!!o&&o!==new URL(r.url).origin};
async function readBody(r,max){if(Number(r.headers.get('content-length')||0)>max)throw {status:413,message:'요청 크기를 초과했습니다.'};const reader=r.body?.getReader(),chunks=[];let n=0;if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();throw {status:413,message:'요청 크기를 초과했습니다.'}}chunks.push(value)}}finally{reader.releaseLock()}const b=new Uint8Array(n);let i=0;for(const p of chunks){b.set(p,i);i+=p.length}return b}
async function readJson(r,max=3*1024*1024){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBody(r,max)))}catch(e){if(e.status)throw e;throw {status:400,message:'올바른 JSON이 아닙니다.'}}}
function checkData(d){if(!d||typeof d!=='object'||Array.isArray(d))throw {status:400,message:'데이터 형식을 확인해 주세요.'};let nodes=0;const walk=(x,depth)=>{if(++nodes>150000||depth>18)throw {status:400,message:'데이터 크기나 구조가 너무 큽니다.'};if(typeof x==='string'&&x.length>100000)throw {status:400,message:'입력 길이를 확인해 주세요.'};if(x&&typeof x==='object')for(const [k,v] of Object.entries(x)){if(['__proto__','prototype','constructor'].includes(k))throw {status:400,message:'허용되지 않는 데이터입니다.'};walk(v,depth+1)}};walk(d,0);for(const key of ['students','classes','notes'])if(d[key]!==undefined&&(!Array.isArray(d[key])||d[key].length>10000))throw {status:400,message:'목록 형식이나 개수를 확인해 주세요.'};for(const key of ['students','classes','notes'])for(const item of d[key]||[]){if(!item||typeof item!=='object'||Array.isArray(item))throw {status:400,message:'목록의 항목 형식을 확인해 주세요.'};for(const field of ['id','name','title','school','grade','phone','day','time','memo','body'])if(item[field]!==undefined&&typeof item[field]!=='string')throw {status:400,message:'항목의 입력 형식을 확인해 주세요.'}}return d}
async function log(env,u,w,action){await env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(),u.id,w||null,action).run()}
async function identity(r,env){const who=await teacherIdentity(r,env);if(!who)throw {status:401,message:'로그인이 필요합니다.'};const id=who.id,email=who.email;await relinkLegacyAccount(env,id,email);return {id,email,admin:!!env.SUPERADMIN_EMAIL&&email.toLowerCase()===env.SUPERADMIN_EMAIL.toLowerCase()}}
// Accounts created under ChatGPT Sites are keyed by a ChatGPT user id. On the first
// Google sign-in with the same verified email, move that account (and its
// workspace ownership) to the Google identity. Google ids are never relinked.
async function relinkLegacyAccount(env,id,email){if(await env.DB.prepare('SELECT 1 FROM accounts WHERE user_id=?').bind(id).first())return;const legacy=await env.DB.prepare("SELECT user_id,workspace_id FROM accounts WHERE lower(email)=? AND user_id NOT LIKE 'google:%' ORDER BY created_at LIMIT 1").bind(email.toLowerCase()).first();if(!legacy)return;await env.DB.batch([env.DB.prepare('UPDATE accounts SET user_id=? WHERE user_id=?').bind(id,legacy.user_id),env.DB.prepare('UPDATE workspaces SET owner_id=? WHERE owner_id=?').bind(id,legacy.user_id),env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(),id,legacy.workspace_id,'account.relink.google')])}
async function account(env,u){const a=await env.DB.prepare('SELECT * FROM accounts WHERE user_id=?').bind(u.id).first();if(!a)throw {status:403,message:'먼저 회원 정보를 등록해 주세요.'};if(a.status!=='active')throw {status:403,message:'이용이 정지된 계정입니다.'};return a}
async function workspace(env,u,url){const a=await account(env,u),wanted=url.searchParams.get('workspace');if(wanted&&!u.admin&&wanted!==a.workspace_id)throw {status:403,message:'다른 계정의 공간에 접근할 수 없습니다.'};const id=u.admin&&wanted?wanted:a.workspace_id;const w=await env.DB.prepare('SELECT * FROM workspaces WHERE id=?').bind(id).first();if(!w)throw {status:404,message:'공간을 찾을 수 없습니다.'};return {a,w}}
// Notices from the admin site (yennie-manager) to every teacher. The admin site
// calls these routes server-to-server with X-Notice-Key; teachers only read.
async function sameKey(a,b){if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;const enc=new TextEncoder(),[x,y]=await Promise.all([a,b].map(v=>crypto.subtle.digest('SHA-256',enc.encode(v))));const u=new Uint8Array(x),w=new Uint8Array(y);let d=a.length===b.length?0:1;for(let i=0;i<u.length;i++)d|=u[i]^w[i];return d===0}
// Same SQL as drizzle/0002_teacher_notices.sql, run once per isolate so the table
// exists even where the migration could not be applied by hand. Idempotent.
let noticeTableReady=null;
function ensureNoticeTable(env){return noticeTableReady??=env.DB.batch([env.DB.prepare('CREATE TABLE IF NOT EXISTS teacher_notices (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'),env.DB.prepare('CREATE INDEX IF NOT EXISTS teacher_notices_order ON teacher_notices(published,pinned,created_at)')]).catch(e=>{noticeTableReady=null;throw e})}
const noticeRow=n=>({id:n.id,title:n.title,body:n.body,pinned:!!n.pinned,published:!!n.published,createdAt:n.created_at,updatedAt:n.updated_at});
function noticeInput(x){if(!x||typeof x!=='object')throw {status:400,message:'공지 내용을 확인해 주세요.'};const title=typeof x.title==='string'?x.title.trim():'',body=typeof x.body==='string'?x.body.trim():'';if(!title||title.length>120)throw {status:400,message:'제목은 1~120자로 써 주세요.'};if(!body||body.length>5000)throw {status:400,message:'내용은 1~5000자로 써 주세요.'};return {title,body,pinned:x.pinned?1:0,published:x.published===false?0:1}}
async function noticeAdmin(r,env,p){
 if(!env.DB)return json({error:'클라우드 저장소를 준비 중입니다.'},503);
 if(!env.CLOUD_NOTICE_KEY||!await sameKey(r.headers.get('x-notice-key'),env.CLOUD_NOTICE_KEY))return json({error:'공지 관리 권한이 없습니다.'},403);
 const actor={id:'admin-site'};await ensureNoticeTable(env);
 if(p==='/api/admin/teacher-notices'&&r.method==='GET'){const rows=await env.DB.prepare('SELECT * FROM teacher_notices ORDER BY pinned DESC,created_at DESC LIMIT 200').all();return json({notices:rows.results.map(noticeRow)})}
 if(p==='/api/admin/teacher-notices'&&r.method==='POST'){const x=await readJson(r,16384);
  if(x?.action==='create'){const n=noticeInput(x),id=uid(),now=new Date().toISOString();await env.DB.prepare('INSERT INTO teacher_notices(id,title,body,pinned,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id,n.title,n.body,n.pinned,n.published,now,now).run();await log(env,actor,null,'notice.create:'+id);return json({notice:noticeRow(await env.DB.prepare('SELECT * FROM teacher_notices WHERE id=?').bind(id).first())},201)}
  if(typeof x?.id!=='string'||!x.id||x.id.length>64)return json({error:'공지를 찾을 수 없습니다.'},404);
  if(x.action==='update'){const n=noticeInput(x),now=new Date().toISOString();const res=await env.DB.prepare('UPDATE teacher_notices SET title=?,body=?,pinned=?,published=?,updated_at=? WHERE id=?').bind(n.title,n.body,n.pinned,n.published,now,x.id).run();if(!res.meta.changes)return json({error:'공지를 찾을 수 없습니다.'},404);await log(env,actor,null,'notice.update:'+x.id);return json({notice:noticeRow(await env.DB.prepare('SELECT * FROM teacher_notices WHERE id=?').bind(x.id).first())})}
  if(x.action==='delete'){const res=await env.DB.prepare('DELETE FROM teacher_notices WHERE id=?').bind(x.id).run();if(!res.meta.changes)return json({error:'공지를 찾을 수 없습니다.'},404);await log(env,actor,null,'notice.delete:'+x.id);return json({ok:true})}
  return json({error:'알 수 없는 요청입니다.'},400)}
 return json({error:'Method Not Allowed'},405)}
const backupMarker = 'owner-backup-2026-11-19';

function hasOwnerBackup(env, user) {
  const parts = Number(env.OWNER_BACKUP_PARTS);
  return user.admin && user.email.toLowerCase() === env.OWNER_BACKUP_EMAIL?.toLowerCase()
    && Number.isInteger(parts) && parts >= 1 && parts <= 20;
}

function ownerBackup(env) {
  const parts = Number(env.OWNER_BACKUP_PARTS);
  return checkData(JSON.parse(Array.from({length: parts}, (_, i) => env['OWNER_BACKUP_' + i]).join('')));
}

function mergeBackup(backup, current) {
  const merged = {...backup, ...current};
  for (const [key, entries] of Object.entries(backup)) {
    if (!Array.isArray(entries) || !Array.isArray(current[key])) continue;
    const existingIds = new Set(current[key].map(entry => entry?.id).filter(Boolean));
    const existingValues = new Set(current[key].map(entry => JSON.stringify(entry)));
    merged[key] = [...current[key], ...entries.filter(entry =>
      !existingIds.has(entry?.id) && !existingValues.has(JSON.stringify(entry))
    )];
  }
  return checkData(merged);
}

async function claimOwnerBackup(env, user) {
  const marker = backupMarker;
  const alreadyImported = () => env.DB.prepare('SELECT id FROM audit WHERE id=?').bind(marker).first();
  if (await alreadyImported()) return true;

  const backup = ownerBackup(env);
  const current = await env.DB.prepare(
    'SELECT a.status,w.id FROM accounts a JOIN workspaces w ON w.id=a.workspace_id WHERE a.user_id=? AND w.owner_id=a.user_id'
  ).bind(user.id).first();

  if (current) {
    if (current.status !== 'active') return false;
    const doc = await loadWorkspaceData(env, current);
    try {
      // The audit marker id is unique, so a second import fails and rolls back.
      await storeSaveData(env, doc, mergeBackup(backup, doc.data), {revision: doc.revision, extra: [
        env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(marker,user.id,current.id,'workspace.backup.import'),
      ]});
    } catch (error) {
      if (!(await alreadyImported())) throw error;
    }
    return Boolean(await alreadyImported());
  }

  const data = JSON.stringify(backup);
  const id = uid();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO workspaces(id,owner_id,title,data,revision) VALUES(?,?,?,?,1)')
        .bind(id,user.id,'예니센스',data),
      env.DB.prepare('INSERT INTO accounts(user_id,email,name,workspace_id) VALUES(?,?,?,?)')
        .bind(user.id,user.email,'예니센스 관리자',id),
      env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)')
        .bind(marker,user.id,id,'workspace.backup.import'),
    ]);
  } catch (error) {
    if (!(await alreadyImported())) throw error;
  }
  return true;
}
export async function handle(r,env){const url=new URL(r.url),p=url.pathname;const signin=await handleTeacherAuth(r,env);if(signin)return signin;
 if(p==='/icon.png')return new Response(Uint8Array.from(atob(ICON),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
 if(p==='/style.css')return new Response(CSS,{headers:{'Content-Type':'text/css; charset=utf-8'}});
 if(p==='/client.js')return new Response(CLIENT,{headers:{'Content-Type':'text/javascript; charset=utf-8'}});
 if(p==='/manifest.webmanifest')return json({name:'YENNIE SENSE Cloud',short_name:'YENNIE SENSE',start_url:'/',display:'standalone',icons:[{src:'/manager/yennie-app-192.png',sizes:'192x192',type:'image/png'},{src:'/manager/yennie-app-512.png',sizes:'512x512',type:'image/png'}],theme_color:'#eaf4fc',background_color:'#eaf4fc'});
 if(p==='/privacy'){const c=String(env.PRIVACY_CONTACT_EMAIL||env.SUPERADMIN_EMAIL||'').trim();const safe=/^[^\s@<>"'&]+@[^\s@<>"'&]+$/.test(c)?c:'';return new Response(PRIVACY.replaceAll('__CONTACT__',safe||'서비스 운영자에게 문의'),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300'}})}
 if(p==='/'||p==='/signup'||p==='/cloud')return new Response(HTML,{headers:{'Content-Type':'text/html; charset=utf-8'}});
 if(p==='/manager'||p.startsWith('/manager/')){
  const name = p==='/manager' ? 'index.html' : p.slice('/manager/'.length);
  if(!Object.hasOwn(MANAGER,name))return json({error:'Not Found'},404);
  const png = name.endsWith('.png');
  if(p==='/manager'){
   try {
    await account(env,await identity(r,env));
   } catch (error) {
    if([401,403].includes(error.status))return Response.redirect(new URL('/',url),302);
    throw error;
   }
  }
  if(name==='index.html'&&p!=='/manager')return json({error:'Not Found'},404);
  return new Response(png?Uint8Array.from(atob(MANAGER[name]),c=>c.charCodeAt(0)):MANAGER[name],{headers:{
   'Content-Type':png?'image/png':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8',
  }});
 }
 const studentPage = /^\/student\/[a-f0-9-]{36}$/.test(p);
 if(studentPage || p==='/student/client.js'){
  return new Response(STUDENT[studentPage?'index.html':'client.js'],{headers:{'Content-Type':studentPage?'text/html; charset=utf-8':'text/javascript; charset=utf-8'}});
 }
 const studentApi = /^\/api\/portal\/([a-f0-9-]{36})\/([a-z]+)$/.exec(p);
 if(studentApi && ['GET','POST'].includes(r.method)){
  if(!env.DB)return json({error:'학생 포털 저장소가 준비되지 않았습니다.'},503);
  return portalPublic(r,env,url,studentApi);
 }
 if(!p.startsWith('/api/'))return json({error:'Not Found'},404);
 if(!['GET','POST','PUT'].includes(r.method))return json({error:'Method Not Allowed'},405);
 if(p==='/api/admin/teacher-notices')return noticeAdmin(r,env,p);
 if(foreign(r))return json({error:'다른 사이트의 요청은 허용하지 않습니다.'},403);
 const u=await identity(r,env);
 if(p==='/api/teacher-notices'&&r.method==='GET'){if(!env.DB)return json({error:'클라우드 저장소를 준비 중입니다.'},503);await account(env,u);await ensureNoticeTable(env);const rows=await env.DB.prepare('SELECT * FROM teacher_notices WHERE published=1 ORDER BY pinned DESC,created_at DESC LIMIT 100').all();return json({notices:rows.results.map(noticeRow).map(({published,...n})=>n)})}
 if(!env.DB)return json({error:'클라우드 저장소를 준비 중입니다.'},503);
 if(p==='/api/session'&&r.method==='GET'){
  let backup = null;
  if (hasOwnerBackup(env,u)) {
    try {
      backup = await claimOwnerBackup(env,u) ? 'imported' : 'pending';
    } catch {
      backup = 'pending';
    }
  }
  const accountRow = await env.DB.prepare('SELECT name,workspace_id,status FROM accounts WHERE user_id=?').bind(u.id).first();
  return json({email:u.email,admin:u.admin,account:accountRow,backup});
 }
 if(p==='/api/owner-backup'&&r.method==='GET'){
  if(!hasOwnerBackup(env,u)) return json({error:'백업을 찾을 수 없습니다.'},404);
  const a = await account(env,u);
  await log(env,u,a.workspace_id,'workspace.backup.download');
  return new Response(JSON.stringify(ownerBackup(env)),{headers:{
    'Content-Type':'application/json',
    'Content-Disposition':'attachment; filename="yensense-backup-2026-11-19.json"',
  }});
 }
 if(p==='/api/register'&&r.method==='POST'){
 const x=await readJson(r,4096);if(!x||typeof x.name!=='string'||!x.name.trim()||x.name.length>60||typeof x.title!=='string'||!x.title.trim()||x.title.length>80||x.adminAccessAcknowledged!==true||Object.keys(x).some(k=>!['name','title','adminAccessAcknowledged'].includes(k)))return json({error:'이름·공간 이름과 관리자 접근 안내 확인이 필요합니다.'},400);
 const exists=await env.DB.prepare('SELECT user_id FROM accounts WHERE user_id=?').bind(u.id).first();if(exists)return json({error:'이미 등록된 계정입니다.'},409);
 const id=uid();await env.DB.batch([env.DB.prepare('INSERT INTO workspaces(id,owner_id,title,data) VALUES(?,?,?,?)').bind(id,u.id,x.title.trim(),JSON.stringify(emptyData())),env.DB.prepare('INSERT INTO accounts(user_id,email,name,workspace_id) VALUES(?,?,?,?)').bind(u.id,u.email,x.name.trim(),id),env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(),u.id,id,'account.register')]);return json({ok:true},201);
 }
 if(p==='/api/admin/accounts'&&r.method==='GET'){await account(env,u);if(!u.admin)return json({error:'전체 관리자 권한이 필요합니다.'},403);await ensureStoreTables(env);const rows=await env.DB.prepare("SELECT a.user_id,a.email,a.name,a.status,a.created_at,a.workspace_id,w.title,COALESCE(d.revision,w.revision) AS revision,w.file_bytes,d.records,d.bytes AS data_bytes FROM accounts a JOIN workspaces w ON w.id=a.workspace_id LEFT JOIN docs d ON d.doc='w:'||w.id ORDER BY a.created_at DESC LIMIT 1000").all();await log(env,u,null,'admin.accounts.list');return json({accounts:rows.results})}
 if(p==='/api/admin/status'&&r.method==='POST'){await account(env,u);if(!u.admin)return json({error:'전체 관리자 권한이 필요합니다.'},403);const x=await readJson(r,4096);if(!x||typeof x.userId!=='string'||!['active','suspended'].includes(x.status))return json({error:'계정을 선택하세요.'},400);const target=await env.DB.prepare('SELECT * FROM accounts WHERE user_id=?').bind(x.userId).first();if(!target)return json({error:'계정을 찾을 수 없습니다.'},404);if(target.email.toLowerCase()===env.SUPERADMIN_EMAIL.toLowerCase())return json({error:'전체 관리자 계정은 정지할 수 없습니다.'},400);await env.DB.batch([env.DB.prepare('UPDATE accounts SET status=? WHERE user_id=?').bind(x.status,x.userId),env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(),u.id,target.workspace_id,'account.'+x.status)]);return json({ok:true})}
 const {w}=await workspace(env,u,url);
 if(p.startsWith('/api/booking/')) {
  if(w.owner_id!==u.id)return json({error:'본인 작업 공간에서만 학생 포털을 운영할 수 있습니다.'},403);
  return portalAdmin(r,env,url,w);
 }
 if(p==='/api/workspace'&&r.method==='GET'){const doc=await loadWorkspaceData(env,w);if(w.owner_id!==u.id)await log(env,u,w.id,'admin.workspace.read');return json({id:w.id,title:w.title,data:doc.data,revision:doc.revision,...(url.searchParams.get('versions')==='1'?{versions:storeVersions(doc)}:{})})}
 if(p==='/api/workspace/changes'&&r.method==='POST'){
  const x=await readJson(r);if(!x||!Array.isArray(x.changes)||!x.changes.length||x.changes.length>20000)return json({error:'저장 형식을 확인해 주세요.'},400);
  const changes=x.changes.map(storeCheckChange);if(new Set(changes.map(c=>c.key)).size!==changes.length)return json({error:'저장 형식을 확인해 주세요.'},400);
  let result;
  try{result=await storeApply(env,workspaceDoc(w.id),changes)}
  catch(e){
   if(e?.status===404){await loadWorkspaceData(env,w);try{result=await storeApply(env,workspaceDoc(w.id),changes)}catch(e2){if(e2?.status===409)return json({error:e2.message,conflicts:e2.conflicts},409);throw e2}}
   else if(e?.status===409)return json({error:e.message,conflicts:e.conflicts},409);
   else throw e;
  }
  await log(env,u,w.id,u.admin&&w.owner_id!==u.id?'admin.workspace.update':'workspace.update');
  return json(result);
 }
 if(p==='/api/workspace'&&r.method==='PUT'){const x=await readJson(r);if(!x||!Number.isSafeInteger(x.revision)||x.revision<0)return json({error:'저장 버전을 확인하세요.'},400);const data=checkData(x.data);const doc=await loadWorkspaceData(env,w);if(doc.revision!==x.revision)return json({error:'다른 탭이나 기기에서 먼저 변경했습니다. 새로 불러온 뒤 다시 수정해 주세요.'},409);let result;try{result=await storeSaveData(env,doc,data,{revision:x.revision,extra:[env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(),u.id,w.id,u.admin&&w.owner_id!==u.id?'admin.workspace.update':'workspace.update')]})}catch(e){if(e?.status===409)return json({error:'다른 탭이나 기기에서 먼저 변경했습니다. 새로 불러온 뒤 다시 수정해 주세요.'},409);throw e}return json({revision:result.revision})}
 if(p==='/api/files'&&r.method==='GET'){const rows=await env.DB.prepare('SELECT id,name,mime,size,created_at FROM files WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1000').bind(w.id).all();if(w.owner_id!==u.id)await log(env,u,w.id,'admin.files.list');return json({files:rows.results})}
 if(p==='/api/files'&&r.method==='POST'){
 if(!env.BUCKET)return json({error:'파일 저장소 연결이 필요합니다.'},503);const bytes=await readBody(r,10*1024*1024),mime=r.headers.get('content-type')?.split(';')[0]||'';let name;try{name=decodeURIComponent(r.headers.get('x-file-name')||'')}catch{return json({error:'파일 이름을 확인하세요.'},400)}
 if(!name||name.length>160||/[\x00-\x1f\/\\]/.test(name)||!bytes.length)return json({error:'파일 이름과 내용을 확인하세요.'},400);
 const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71,jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,pdf=new TextDecoder().decode(bytes.subarray(0,5))==='%PDF-';
 if(!(mime==='image/png'&&png||mime==='image/jpeg'&&jpeg||mime==='application/pdf'&&pdf))return json({error:'PNG·JPG·PDF 파일만 업로드할 수 있습니다.'},400);
 const reserve=await env.DB.prepare('UPDATE workspaces SET file_bytes=file_bytes+? WHERE id=? AND file_bytes+?<=104857600').bind(bytes.length,w.id,bytes.length).run();if(!reserve.meta.changes)return json({error:'계정의 파일 저장 한도 100MB를 초과합니다.'},413);
 const id=uid(),key='workspaces/'+w.id+'/'+id;try{await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:mime}});await env.DB.batch([env.DB.prepare('INSERT INTO files(id,workspace_id,object_key,name,mime,size) VALUES(?,?,?,?,?,?)').bind(id,w.id,key,name,mime,bytes.length),env.DB.prepare('INSERT INTO audit(id,actor_id,workspace_id,action) VALUES(?,?,?,?)').bind(uid(),u.id,w.id,'file.upload')])}catch(e){await env.BUCKET.delete(key);await env.DB.prepare('UPDATE workspaces SET file_bytes=file_bytes-? WHERE id=?').bind(bytes.length,w.id).run();throw e}return json({id},201);
 }
 if(p==='/api/file'&&r.method==='GET'){const f=await env.DB.prepare('SELECT * FROM files WHERE id=? AND workspace_id=?').bind(url.searchParams.get('id')||'',w.id).first();if(!f)return json({error:'파일을 찾을 수 없습니다.'},404);const obj=await env.BUCKET.get(f.object_key);if(!obj)return json({error:'파일을 찾을 수 없습니다.'},404);await log(env,u,w.id,w.owner_id===u.id?'file.download':'admin.file.download');return new Response(obj.body,{headers:{'Content-Type':f.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(f.name)}})}
 if(p==='/api/audit'&&r.method==='GET'){const a=await env.DB.prepare('SELECT actor_id,action,created_at FROM audit WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100').bind(w.id).all();return json({events:a.results})}
 return json({error:'Not Found'},404);
}
export default {async fetch(r,env){let res;try{if(!['GET','HEAD'].includes(r.method)&&!new URL(r.url).pathname.startsWith('/api/'))res=json({error:'Method Not Allowed'},405);else res=await handle(r,env)}catch(e){res=json({error:e.status?e.message:'요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'},e.status||500)}const h=new Headers(res.headers);for(const [k,v] of Object.entries({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Strict-Transport-Security':'max-age=31536000','Cross-Origin-Resource-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"}))h.set(k,v);if(/^\/student\/[a-f0-9-]{36}$/.test(new URL(r.url).pathname)){
 h.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
}if(new URL(r.url).pathname==='/manager') {
 h.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
}return new Response(r.method==='HEAD'?null:res.body,{status:res.status,headers:h})}};

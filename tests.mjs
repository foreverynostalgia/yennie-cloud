import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import worker from './dist/server/index.js';
const sqlite=new DatabaseSync(':memory:');sqlite.exec(await readFile('drizzle/0000_cloud.sql','utf8'));sqlite.exec(await readFile('drizzle/0001_student_portal.sql','utf8'));
const objects=new Map(),env={SUPERADMIN_EMAIL:'owner@test.local',BUCKET:{async put(k,b){objects.set(k,b)},async get(k){return objects.has(k)?{body:objects.get(k)}:null},async delete(k){objects.delete(k)}},DB:{prepare(sql){return {bind(...args){this.args=args;return this},async first(){return sqlite.prepare(sql).get(...(this.args||[]))||null},async all(){return {results:sqlite.prepare(sql).all(...(this.args||[]))}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...(this.args||[])).changes)}}}}},async batch(stmts){sqlite.exec('BEGIN');try{const result=[];for(const q of stmts)result.push(await q.run());sqlite.exec('COMMIT');return result}catch(e){sqlite.exec('ROLLBACK');throw e}}}};
env.TEACHER_SESSION_SECRET='test-only-teacher-session-secret-0123456789';
const b64u=b=>Buffer.from(b).toString('base64url');
async function headers(id,mail=id+'@test.local'){const data=b64u(JSON.stringify({id,email:mail.toLowerCase(),exp:Math.floor(Date.now()/1000)+3600}));const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TEACHER_SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);const mac=b64u(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('teacher-session-v1.'+data))));return {cookie:'ys_teacher='+data+'.'+mac}}
async function call(path,{id='alice',mail,method='GET',data,extra={},bytes}={}){return worker.fetch(new Request('https://cloud.test'+path,{method,headers:{...await headers(id,mail),'Content-Type':'application/json',...extra},...(data!==undefined?{body:JSON.stringify(data)}:{}),...(bytes?{body:bytes}:{})}),env)}
assert.equal((await worker.fetch(new Request('https://cloud.test/api/session'),env)).status,401);
for(const [id,mail] of [['alice',undefined],['bob',undefined],['owner','owner@test.local']]){assert.equal((await call('/api/register',{id,mail,method:'POST',data:{name:id,title:id+' classroom',adminAccessAcknowledged:true}})).status,201)}
const alice=await (await call('/api/workspace')).json(),bob=await (await call('/api/workspace',{id:'bob'})).json();assert.notEqual(alice.id,bob.id);
assert.equal((await call('/api/workspace?workspace='+bob.id)).status,403);
assert.equal((await call('/api/workspace?workspace='+bob.id,{method:'PUT',data:{revision:0,data:{students:[]}}})).status,403);
assert.equal((await call('/api/admin/accounts')).status,403);
assert.equal((await call('/api/register',{id:'malicious',method:'POST',data:{name:'x',title:'x',adminAccessAcknowledged:true,role:'admin'}})).status,400);
assert.equal((await call('/api/workspace',{method:'PUT',data:{revision:0,data:{students:[{name:'Alice private'}],classes:[],notes:[]}}})).status,200);
assert.equal((await call('/api/workspace',{method:'PUT',data:{revision:0,data:{students:[]}}})).status,409);
assert.equal((await (await call('/api/workspace',{id:'bob'})).json()).data.students.length,0);
assert.equal((await call('/api/workspace',{method:'PUT',extra:{Origin:'https://evil.test'},data:{}})).status,403);
assert.equal((await call('/api/workspace',{method:'PUT',data:{revision:1,data:JSON.parse('{"__proto__":{"admin":true}}')}})).status,400);
const admin={id:'owner',mail:'owner@test.local'};assert.equal((await call('/api/admin/accounts',admin)).status,200);
assert.equal((await call('/api/workspace?workspace='+alice.id,admin)).status,200);
const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);const file=await call('/api/files',{method:'POST',bytes,extra:{'Content-Type':'image/png','X-File-Name':'private.png'}});assert.equal(file.status,201);const fid=(await file.json()).id;
assert.equal((await call('/api/file?id='+fid,{id:'bob'})).status,404);
const own=await call('/api/file?id='+fid);assert.equal(own.status,200);assert.match(own.headers.get('Content-Disposition'),/^attachment/);
assert.equal((await call('/api/file?workspace='+alice.id+'&id='+fid,admin)).status,200);
assert.equal((await call('/api/files',{method:'POST',bytes:new TextEncoder().encode('<svg onload=alert(1)>'),extra:{'Content-Type':'image/svg+xml','X-File-Name':'bad.svg'}})).status,400);
assert.equal((await call('/api/admin/status',{...admin,method:'POST',data:{userId:'bob',status:'suspended'}})).status,200);
assert.equal((await call('/api/workspace',{id:'bob'})).status,403);
assert.equal((await call('/api/admin/status',{...admin,method:'POST',data:{userId:'owner',status:'suspended'}})).status,400);
const audit=await (await call('/api/audit')).json();assert.ok(audit.events.some(x=>x.action==='admin.workspace.read'));assert.ok(audit.events.some(x=>x.action==='admin.file.download'));
const html=await (await worker.fetch(new Request('https://cloud.test/'),env)).text();assert.ok(!html.includes('Alice private'));assert.ok(!html.includes('owner@test.local'));
assert.equal((await worker.fetch(new Request('https://cloud.test/api/booking/data'),env)).status,401);
console.log('PASS anonymous denial, isolated signup/workspaces/files, privilege tampering, admin access/audit, optimistic concurrency, CSRF, unsafe files, suspension and no legacy relay.');
const backup = {students:[{id:'backup-student',name:'Migration fixture'}], classes:[], notes:[], scores:[{id:'backup-score'}]};
Object.assign(env,{OWNER_BACKUP_EMAIL:'owner@test.local',OWNER_BACKUP_PARTS:'1',OWNER_BACKUP_0:JSON.stringify(backup)});
assert.equal((await call('/api/session',{id:'alice'})).status,200);
assert.equal((await call('/api/session',admin)).status,200);
assert.deepEqual((await (await call('/api/workspace',admin)).json()).data,backup);
assert.equal((await (await call('/api/workspace',admin)).json()).revision,1);
assert.equal((await call('/api/session',admin)).status,200);
assert.equal((await (await call('/api/workspace',admin)).json()).revision,1);
assert.equal((await call('/api/workspace?workspace='+(await (await call('/api/workspace',admin)).json()).id)).status,403);
sqlite.exec("DELETE FROM audit WHERE id='owner-backup-2026-11-19'; DELETE FROM accounts WHERE user_id='owner'; DELETE FROM workspaces WHERE owner_id='owner'");
assert.equal((await call('/api/session',admin)).status,200);
assert.deepEqual((await (await call('/api/workspace',admin)).json()).data,backup);
console.log('PASS owner-only backup claim for existing empty and new accounts, idempotency and isolation.');

const existingStudent = {id:'backup-student',name:'Existing edit'};
const extraStudent = {id:'another-student',name:'Existing entry'};
const existing = {students:[existingStudent,extraStudent],classes:[],notes:[]};
sqlite.prepare("DELETE FROM audit WHERE id='owner-backup-2026-11-19'").run();
sqlite.prepare("UPDATE workspaces SET data=?,revision=3,file_bytes=10 WHERE owner_id='owner'").run(JSON.stringify(existing));
const restoredSession = await (await call('/api/session',admin)).json();
assert.equal(restoredSession.backup,'imported');
const restored = await (await call('/api/workspace',admin)).json();
assert.deepEqual(restored.data.students,existing.students);
assert.deepEqual(restored.data.scores,backup.scores);
assert.equal(restored.revision,4);
assert.equal(sqlite.prepare("SELECT file_bytes FROM workspaces WHERE owner_id='owner'").get().file_bytes,10);
assert.deepEqual(await (await call('/api/owner-backup',admin)).json(),backup);
assert.equal((await call('/api/owner-backup')).status,404);
assert.equal((await worker.fetch(new Request('https://cloud.test/api/owner-backup'),env)).status,401);
sqlite.prepare("DELETE FROM audit WHERE id='owner-backup-2026-11-19'").run();
env.OWNER_BACKUP_0 = '{';
const pending = await (await call('/api/session',admin)).json();
assert.equal(pending.backup,'pending');
assert.equal(pending.account.status,'active');
assert.equal((await call('/api/workspace',admin)).status,200);

assert.equal((await worker.fetch(new Request('https://cloud.test/signup'),env)).status,200);
const newcomer = {id:'newcomer'};
assert.equal((await (await call('/api/session',newcomer)).json()).account,null);
assert.equal((await call('/api/register',{...newcomer,method:'POST',data:{name:'New teacher',title:'New classroom',adminAccessAcknowledged:true}})).status,201);
assert.deepEqual((await (await call('/api/workspace',newcomer)).json()).data,{students:[],classes:[],notes:[]});
console.log('PASS populated owner workspace recovery, backup download isolation, login during recovery errors, and new member signup.');

const manager = await call('/manager');
assert.equal(manager.status,200);
assert.match(await manager.text(), /<nav id="nav"><\/nav>.*\/manager\/bootstrap\.js/s);
assert.match(manager.headers.get('Content-Security-Policy'), /script-src 'self'; style-src 'unsafe-inline'/);
assert.equal((await worker.fetch(new Request('https://cloud.test/manager'),env)).status,302);
assert.equal((await call('/manager',{id:'bob'})).status,302);
const managerCode = await (await call('/manager/app.js')).text();
assert.ok(managerCode.includes('cloudManagerStorage'));
assert.ok(!managerCode.includes('localStorage'));
const adapter = await (await call('/manager/bootstrap.js')).text();
assert.ok(adapter.includes("fetch('/api/workspace'"));
assert.equal((await call('/manager/index.html')).status,404);
assert.equal((await call('/manager/yennie-app-512.png')).headers.get('Content-Type'),'image/png');
console.log('PASS original manager shell, cloud adapter and authenticated manager routing.');

env.STUDENT_PORTAL_SECRET='test-only-random-secret';
const ownId=alice.id;
const tenantData={students:[
  {id:'one',name:'Portal student',class:'Science',school:'School',grade:'중3'},
  {id:'two',name:'Other class',class:'Math',school:'School',grade:'중3'},
],classes:[{id:'science',name:'Science'},{id:'math',name:'Math'}],notes:[]};
const tenant=(await (await call('/api/workspace')).json());
assert.equal((await call('/api/workspace',{method:'PUT',data:{data:tenantData,revision:tenant.revision}})).status,200);
const teacher=(path,data,method='POST')=>call('/api/booking/'+path,{method,data});
const first=await (await teacher('students',{action:'manager-upsert',managerId:'one',nickname:'fixture-one'})).json();
const second=await (await teacher('students',{action:'manager-upsert',managerId:'two',nickname:'fixture-two'})).json();
assert.match(first.credentials[0].pin,/^YE\d{4}$/);
const requestStudent=(path,data,cookie='',workspace=ownId)=>worker.fetch(new Request('https://cloud.test/api/portal/'+workspace+'/'+path,{
  method:data===undefined?'GET':'POST',
  headers:{cookie,'Content-Type':'application/json'},
  ...(data===undefined?{}:{body:JSON.stringify(data)}),
}),env);
async function studentCookie(credential){
  const response=await requestStudent('login',credential);
  assert.equal(response.status,200);
  assert.match(response.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict/);
  return response.headers.get('Set-Cookie').split(';')[0];
}
const studentOne=await studentCookie(first.credentials[0]), studentTwo=await studentCookie(second.credentials[0]);
assert.equal((await requestStudent('dashboard',undefined,studentOne,bob.id)).status,404);
assert.equal((await requestStudent('dashboard')).status,401);
assert.equal((await call('/api/booking/data?workspace='+ownId,admin)).status,403);
const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const slot=await (await teacher('reservations',{action:'slot',courseId:'science',date,start:'14:00',end:'15:00',capacity:1})).json();
assert.equal((await requestStudent('book',{slotId:slot.id},studentTwo)).status,409);
assert.equal((await requestStudent('book',{slotId:slot.id},studentOne)).status,200);
assert.equal((await requestStudent('book',{slotId:slot.id},studentOne)).status,409);
const booking=(await (await requestStudent('dashboard',undefined,studentOne)).json()).bookings[0];
assert.equal((await requestStudent('cancel',{id:booking.id},studentTwo)).status,409);
assert.equal((await requestStudent('cancel',{id:booking.id},studentOne)).status,200);
assert.equal((await teacher('reservations',{action:'booking-status',id:booking.id,status:'cancelled'})).status,200);
const quiz=[{id:'q1',type:'ox',prompt:'True?',points:10,answers:['O']}];
const exam=await (await teacher('learning',{action:'exam',title:'Test exam',links:[{courseId:'science',lessonNo:1}],questions:quiz})).json();
assert.equal((await call('/api/booking/paper?exam='+exam.id,{method:'PUT',bytes:new TextEncoder().encode('%PDF-1.7\n')})).status,200);
assert.equal((await teacher('learning',{action:'publish',examId:exam.id,published:true})).status,200);
const {links}=await (await call('/api/booking/learning')).json(),assignment=links[0].id;
assert.equal((await requestStudent('exam?assignment='+assignment,undefined,studentTwo)).status,404);
assert.equal((await requestStudent('paper?assignment='+assignment,undefined,studentOne)).status,200);
const publicExam=await (await requestStudent('exam?assignment='+assignment,undefined,studentOne)).json();
assert.ok(!Object.hasOwn(publicExam.questions[0],'answers'));
assert.equal((await requestStudent('submit',{assignment,answers:{q1:'O'}},studentOne)).status,200);
assert.equal((await requestStudent('submit',{assignment,answers:{q1:'X'}},studentOne)).status,409);
assert.equal((await (await call('/api/booking/learning')).json()).attempts[0].score,100);
const video=await (await teacher('review-videos',{action:'save',url:'https://youtu.be/dQw4w9WgXcQ',title:'Science video',courseIds:['science'],studentIds:[],quiz,published:true})).json();
assert.equal((await requestStudent('review',{id:video.id,complete:true},studentTwo)).status,404);
assert.equal((await requestStudent('review',{id:video.id,complete:true,answers:{q1:'O'}},studentOne)).status,200);
const progress=await (await teacher('review-videos',{action:'report',id:video.id})).json();
assert.equal(progress.rows[0].quiz.bestScore,100);
const revoked=await requestStudent('dashboard',undefined,studentOne);
assert.equal(revoked.status,200);
assert.equal((await teacher('students',{action:'manager-upsert',managerId:'one',nickname:'fixture-one',resetPin:true})).status,200);
assert.equal((await requestStudent('dashboard',undefined,studentOne)).status,401);
console.log('PASS scoped portal PIN, student sessions, eligibility, reservations, private PDF, grading, video progress and session revocation.');

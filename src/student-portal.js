const portalId = /^[A-Za-z0-9_-]{1,80}$/;
const portalFail = (message, status=400) => { throw {message,status}; };
const portalList = value => Array.isArray(value) ? value : [];
const portalActive = student => student && !student.archived && student.enrollmentStatus !== 'withdrawn';
const portalString = (value,max,optional=false) => {
  if (typeof value !== 'string' || value.length>max || (!optional&&!value.trim())) portalFail('입력 내용을 확인해 주세요.');
  return value.trim();
};
const portalNumber = (value,min,max) => {
  const n=Number(value);
  if(!Number.isInteger(n)||n<min||n>max) portalFail('숫자 범위를 확인해 주세요.');
  return n;
};
const portalNow = () => new Date().toISOString();
const portalEmpty = () => ({credentials:{},slots:[],bookings:[],exams:[],links:[],attempts:[],videos:[],courses:[],assignments:[],progress:[],notices:[]});
const portalDigest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const portalEncode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const portalDecode = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0));
async function portalKey(env) {
  if(!env.STUDENT_PORTAL_SECRET) portalFail('학생 포털 보안 설정이 필요합니다.',503);
  const key=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('portal-pin:'+env.STUDENT_PORTAL_SECRET));
  return crypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt','decrypt']);
}
async function portalPin(env,workspaceId,studentId,credential,pin) {
  const key=await portalKey(env), encoder=new TextEncoder();
  const additionalData=encoder.encode(workspaceId+':'+studentId+':'+credential.version);
  if(!pin) {
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:portalDecode(credential.iv),additionalData},key,portalDecode(credential.pin));
    return new TextDecoder().decode(clear);
  }
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},key,encoder.encode(pin));
  return {...credential,iv:portalEncode(iv),pin:portalEncode(encrypted)};
}
function portalNewPin() {
  const draw=new Uint32Array(1);
  do crypto.getRandomValues(draw); while(draw[0]>=4294960000);
  return 'YE'+String(draw[0]%10000).padStart(4,'0');
}
function portalCourses(ctx) {
  return portalList(ctx.records.classes).filter(c=>!c.inactive && c.kind!=='scheduling')
    .map(c=>({id:c.id,title:c.name,active:1}));
}
function portalRoster(ctx, courseId, student) {
  const course=portalCourses(ctx).find(c=>c.id===courseId);
  return Boolean(course && student.class===course.title);
}
function portalStudents(ctx) {
  return portalList(ctx.records.students).map(s=>({
    id:s.id,name:s.name,school:s.school,academy:s.academy||'',grade:s.grade,phone:s.phone,
    parentPhone:s.parentPhone||'',portalLinked:Object.hasOwn(ctx.data.credentials,s.id),nickname:ctx.data.credentials[s.id]?.nickname||s.nickname||'',active:portalActive(s),
  }));
}
function portalFind(list,id,error) {
  const row=list.find(x=>x.id===id);
  if(!row) portalFail(error,404);
  return row;
}
function portalIds(input, allowed) {
  if(!Array.isArray(input)||input.length>1000||input.some(id=>!allowed.has(id))) portalFail('이 작업 공간에 등록된 항목을 선택해 주세요.');
  return [...new Set(input)];
}
async function portalContext(env,workspaceRow) {
  const row=await env.DB.prepare('SELECT data,revision FROM student_portals WHERE workspace_id=?').bind(workspaceRow.id).first();
  return {env,id:workspaceRow.id,records:JSON.parse(workspaceRow.data),revision:row?.revision??null,data:row?JSON.parse(row.data):portalEmpty()};
}
async function portalWrite(ctx) {
  const data=JSON.stringify(ctx.data);
  if(new TextEncoder().encode(data).length>1024*1024) portalFail('학생 포털 저장 한도를 초과했습니다.',413);
  const {DB}=ctx.env;
  const result=ctx.revision===null
    ? await DB.prepare('INSERT OR IGNORE INTO student_portals(workspace_id,data,revision) VALUES(?,?,0)').bind(ctx.id,data).run()
    : await DB.prepare('UPDATE student_portals SET data=?,revision=revision+1 WHERE workspace_id=? AND revision=?').bind(data,ctx.id,ctx.revision).run();
  if(!result.meta.changes) portalFail('다른 기기에서 먼저 변경했습니다. 다시 확인한 뒤 저장해 주세요.',409);
}
function portalExamLinks(ctx,exam,links) {
  if(!Array.isArray(links)||!links.length||links.length>100) portalFail('수업과 회차를 선택해 주세요.');
  const courses=new Set(portalCourses(ctx).map(c=>c.id));
  for(const link of links) {
    if(!courses.has(link.courseId)) portalFail('등록된 정식 수업을 선택해 주세요.');
    const lesson=portalNumber(link.lessonNo,1,9999);
    if(!ctx.data.links.some(x=>x.exam_id===exam.id&&x.course_id===link.courseId&&x.lesson_no===lesson)) {
      ctx.data.links.push({id:uid(),exam_id:exam.id,course_id:link.courseId,lesson_no:lesson});
    }
  }
}
function portalValidateQuestions(questions) {
  try {return validQuestions(questions);} catch(error) {portalFail(error.message);}
}
function portalAdminLearning(ctx, x) {
  const d=ctx.data;
  if(x.action==='exam'){
    const exam={id:uid(),title:portalString(x.title,200),questions:JSON.stringify(portalValidateQuestions(x.questions)),student_ids:'[]',published:0,created_at:portalNow(),paper_key:null};
    portalExamLinks(ctx,exam,x.links);
    exam.course_id=x.links[0].courseId;
    d.exams.push(exam);
    return {id:exam.id};
  }
  if(x.action==='link-exam'){
    const exam=portalFind(d.exams,x.examId,'시험을 찾을 수 없습니다.');
    portalExamLinks(ctx,exam,x.links);
  } else if(x.action==='publish'){
    const exam=portalFind(d.exams,x.examId,'시험을 찾을 수 없습니다.');
    if(typeof x.published!=='boolean') portalFail('배포 상태를 확인해 주세요.');
    if(x.published&&!exam.paper_key) portalFail('시험지를 업로드한 뒤 배포해 주세요.');
    exam.published=Number(x.published);
  } else if(x.action==='grade'){
    const attempt=portalFind(d.attempts,x.attemptId,'답안을 찾을 수 없습니다.');
    const grading=JSON.parse(attempt.grading);
    for(const item of grading.filter(item=>item.pending)){
      const value=Number(x.points?.[item.id]);
      if(!Number.isFinite(value)||value<0||value>item.max) portalFail('서술형 배점을 확인해 주세요.');
      item.points=value;
      item.pending=false;
    }
    attempt.score=Math.round(grading.reduce((n,item)=>n+item.points,0)/grading.reduce((n,item)=>n+item.max,0)*100);
    attempt.grading=JSON.stringify(grading);
    attempt.pending=0;
  } else if(x.action==='notice'){
    if(!portalCourses(ctx).some(c=>c.id===x.courseId)) portalFail('수업을 선택해 주세요.');
    d.notices.push({id:uid(),course_id:x.courseId,title:portalString(x.title,200),body:portalString(x.body,6000),created_at:portalNow()});
  } else portalFail('이 작업 공간에서 지원되지 않는 기능입니다.',501);
  return {ok:true};
}
function portalYoutube(value) {
  let url;
  try {url=new URL(portalString(value,2000));} catch {portalFail('YouTube 주소를 확인해 주세요.');}
  if(url.protocol!=='https:'||url.port||url.username||url.password) portalFail('HTTPS YouTube 주소를 입력해 주세요.');
  const id=url.hostname==='youtu.be'?url.pathname.slice(1):
    ['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'].includes(url.hostname)
      ? url.searchParams.get('v')||/^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1] : '';
  if(!/^[\w-]{11}$/.test(id||'')) portalFail('개별 YouTube 영상 주소를 입력해 주세요.');
  return id;
}
function portalVideoAccess(ctx,student,video) {
  if(!video.published) return false;
  return JSON.parse(video.student_ids).includes(student.id)||JSON.parse(video.course_ids).some(id=>portalRoster(ctx,id,student))
    ||ctx.data.assignments.some(a=>portalRoster(ctx,a.class_id,student)&&JSON.parse(a.review_course_ids).includes(video.review_course_id));
}
function portalProgress(ctx,video,studentId) {
  return ctx.data.progress.find(p=>p.videoId===video.id&&p.studentId===studentId&&p.version===video.version);
}
function portalAdminVideo(ctx,x) {
  const d=ctx.data;
  if(x.action==='course-create'){
    const title=portalString(x.title,100);
    const course=d.courses.find(c=>c.title===title)||{id:uid(),title};
    if(!d.courses.includes(course))d.courses.push(course);
    return {course};
  }
  if(['class-assign','class-roster','class-unassign'].includes(x.action)){
    const course=portalFind(portalCourses(ctx),x.classId,'수업을 찾을 수 없습니다.');
    const old=d.assignments.find(a=>a.class_id===course.id);
    if(old)d.assignments=d.assignments.filter(a=>a!==old);
    const ids=x.action==='class-assign'?portalIds(x.reviewCourseIds,new Set(d.courses.map(c=>c.id))):JSON.parse(old?.review_course_ids||'[]');
    if(x.action!=='class-unassign'&&ids.length)d.assignments.push({
      class_id:course.id,class_name:course.title,review_course_ids:JSON.stringify(ids),
      student_ids:JSON.stringify(portalStudents(ctx).filter(s=>s.active&&portalRoster(ctx,course.id,ctx.records.students.find(r=>r.id===s.id))).map(s=>s.id)),
    });
    return {ok:true};
  }
  if(x.action==='publish'){
    portalFind(d.videos,x.id,'영상을 찾을 수 없습니다.').published=Number(x.published===true);
    return {ok:true};
  }
  if(x.action==='save'){
    const old=x.id?portalFind(d.videos,x.id,'영상을 찾을 수 없습니다.'):null;
    const courseIds=portalIds(x.courseIds,new Set(portalCourses(ctx).map(c=>c.id)));
    const studentIds=portalIds(x.studentIds,new Set(portalStudents(ctx).filter(s=>s.active).map(s=>s.id)));
    if(x.reviewCourseId)portalFind(d.courses,x.reviewCourseId,'복습 강좌를 선택해 주세요.');
    const quiz=x.quiz?.length?portalValidateQuestions(x.quiz):[];
    if(quiz.length>20||quiz.some(q=>q.type==='essay'))portalFail('복습 퀴즈는 자동 채점 문항 20개까지 등록할 수 있습니다.');
    const videoId=portalYoutube(x.url), serialized=JSON.stringify(quiz);
    const video={id:old?.id||uid(),video_id:videoId,title:portalString(x.title,200),description:portalString(x.description||'',2000,true),
      course_ids:JSON.stringify(courseIds),student_ids:JSON.stringify(studentIds),lesson_no:portalNumber(x.lessonNo||1,1,9999),
      published:Number(x.published===true),curriculum_title:portalString(x.curriculumTitle||'',100,true),sort_order:portalNumber(x.sortOrder||0,0,99999),
      quiz:serialized,version:old?old.version+Number(old.video_id!==videoId||old.quiz!==serialized):1,review_course_id:x.reviewCourseId||null};
    if(old)Object.assign(old,video);else d.videos.push(video);
    return {id:video.id,version:video.version,newVersion:Boolean(old&&video.version!==old.version)};
  }
  portalFail('이 작업 공간에서 지원되지 않는 기능입니다.',501);
}

async function portalAdminStudent(ctx,x){
  const id=x.managerId||x.bookingStudentId||x.id;
  if(typeof id!=='string'||!portalId.test(id)||['__proto__','constructor','prototype'].includes(id))portalFail('학생 정보를 확인해 주세요.');
  const credentials=ctx.data.credentials;
  const old=Object.hasOwn(credentials,id)?credentials[id]:null;
  const student=portalList(ctx.records.students).find(s=>s.id===id);
  if(x.action==='credentials'){
    if(!portalActive(student)||!old||old.disabled)portalFail('학생 정보의 닉네임을 저장한 후 PIN을 확인할 수 있습니다.',404);
    return {credentials:[{nickname:old.nickname,pin:await portalPin(ctx.env,ctx.id,id,old)}]};
  }
  if(x.action!=='manager-upsert')portalFail('학생 요청을 확인해 주세요.');
  const nickname=portalString(x.nickname??old?.nickname??student?.nickname,24).normalize('NFKC').toLowerCase();
  if(!/^[가-힣a-z0-9_-]{2,24}$/.test(nickname))portalFail('닉네임은 한글·영문·숫자·_·- 2~24자로 입력해 주세요.');
  if(Object.entries(credentials).some(([otherId,c])=>otherId!==id&&c.nickname===nickname))portalFail('이미 사용 중인 닉네임입니다.',409);
  const disabled=x.active===false;
  const rotate=!old||x.resetPin===true;
  const pin=rotate?portalNewPin():null;
  const credential=rotate?await portalPin(ctx.env,ctx.id,id,{nickname,version:uid(),disabled},pin):
    {...old,nickname,disabled};
  if(!old||rotate||old.nickname!==nickname||old.disabled!==disabled){
    credentials[id]=credential;
    await portalWrite(ctx);
    if(old&&(rotate||disabled||old.nickname!==nickname))await ctx.env.DB.prepare(
      'DELETE FROM student_portal_sessions WHERE workspace_id=? AND student_id=? AND credential_version=?'
    ).bind(ctx.id,id,old.version).run();
  }
  return {students:[{id,nickname,name:x.name||student?.name,school:x.school||student?.school,phone:x.phone||student?.phone,parentPhone:x.parentPhone||student?.parentPhone,active:!disabled}],credentials:pin&&!disabled?[{nickname,pin}]:[]};
}
function portalReservation(ctx,x){
  const d=ctx.data;
  if(x.action==='slot'){
    if(!portalCourses(ctx).some(c=>c.id===x.courseId))portalFail('수업을 선택해 주세요.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(x.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.end)||x.start>=x.end)
      portalFail('예약 날짜와 시간을 확인해 주세요.');
    const start=new Date(x.date+'T'+x.start+':00+09:00');
    if(!Number.isFinite(+start)||start<=Date.now()||new Date(x.date+'T00:00:00Z').toISOString().slice(0,10)!==x.date)portalFail('미래 날짜와 시간을 선택해 주세요.');
    if(d.slots.some(s=>s.courseId===x.courseId&&s.date===x.date&&s.open&&s.start<x.end&&x.start<s.end))portalFail('이 수업에 겹치는 예약 시간이 있습니다.',409);
    const slot={id:uid(),courseId:x.courseId,date:x.date,start:x.start,end:x.end,capacity:portalNumber(x.capacity,1,999),open:true};
    d.slots.push(slot);
    return {id:slot.id};
  }
  if(x.action==='close'){
    portalFind(d.slots,x.id,'예약 시간을 찾을 수 없습니다.').open=false;
    return {ok:true};
  }
  if(x.action==='booking-status'){
    const booking=portalFind(d.bookings,x.id,'예약을 찾을 수 없습니다.');
    if(x.status==='confirmed'&&booking.status==='cancel_requested')booking.status='confirmed';
    else if(x.status==='cancelled'&&booking.status!=='cancelled')booking.status='cancelled';
    else portalFail('예약 상태가 이미 변경되었습니다.',409);
    return {ok:true};
  }
  portalFail('예약 요청을 확인해 주세요.');
}
async function portalAdmin(request,env,url,w){
  const ctx=await portalContext(env,w), d=ctx.data;
  const endpoint=url.pathname.slice('/api/booking/'.length);
  if(request.method==='GET'){
    if(endpoint==='student-pin')return json((await portalAdminStudent(ctx,{action:'credentials',id:url.searchParams.get('id')})).credentials[0]);
    if(endpoint==='data')return json({role:'owner',workspaceId:ctx.id,courses:portalCourses(ctx),bookings:d.bookings,slots:d.slots});
    if(endpoint==='students')return json({students:portalStudents(ctx)});
    if(endpoint==='learning')return json({exams:d.exams,attempts:d.attempts,links:d.links,notices:d.notices,contacts:[],deliveries:[],reportAlimtalkConfigured:false});
    if(endpoint==='review-videos')return json({videos:d.videos,courses:d.courses,classAssignments:d.assignments});
    if(endpoint==='learning/ocr')return json({enabled:false,jobs:[]});
  }
  if(endpoint==='paper'&&request.method==='PUT'){
    if(!env.BUCKET)portalFail('파일 저장소가 연결되어 있지 않습니다.',503);
    const exam=portalFind(d.exams,url.searchParams.get('exam'),'시험을 찾을 수 없습니다.');
    if(exam.published)portalFail('시험 배포를 중지한 뒤 PDF를 교체해 주세요.',409);
    const bytes=await readBody(request,8*1024*1024);
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')portalFail('PDF 시험지를 선택해 주세요.');
    const old=exam.paper_key;
    const key='workspaces/'+ctx.id+'/exam-papers/'+uid();
    exam.paper_key=key;
    await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:'application/pdf'}});
    try {await portalWrite(ctx);} catch(error){await env.BUCKET.delete(key);throw error;}
    if(old)await env.BUCKET.delete(old).catch(()=>{});
    return json({ok:true});
  }
  if(request.method!=='POST')portalFail('지원하지 않는 요청입니다.',405);
  const x=await readJson(request,512*1024);
  if(!x||typeof x!=='object'||Array.isArray(x))portalFail('요청 내용을 확인해 주세요.');
  if(endpoint==='students'||endpoint==='student-pin')return json(await portalAdminStudent(ctx,endpoint==='student-pin'?{...x,action:'credentials'}:x));
  if(endpoint==='review-videos'&&x.action==='metadata'){
    const id=portalYoutube(x.url);
    const response=await fetch('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent('https://www.youtube.com/watch?v='+id),{redirect:'manual',signal:AbortSignal.timeout(5000)});
    if(!response.ok)portalFail('영상 제목을 가져오지 못했습니다. 직접 입력해 주세요.');
    const meta=await response.json();
    return json({title:String(meta.title||'').slice(0,200),author:String(meta.author_name||'').slice(0,200),videoId:id});
  }
  if(endpoint==='review-videos'&&x.action==='report'){
    const video=portalFind(d.videos,x.id,'영상을 찾을 수 없습니다.');
    const rows=portalList(ctx.records.students).filter(s=>portalActive(s)&&portalVideoAccess(ctx,s,video)).map(s=>{
      const p=portalProgress(ctx,video,s.id);
      return {id:s.id,name:s.name,school:s.school,academy:s.academy||'',progress:{complete:!!p?.complete,percent:p?.complete?100:0,watchedSeconds:0,durationSeconds:0},quiz:{attempts:p?.tries||0,bestScore:p?.bestScore??null}};
    });
    return json({title:video.title,version:video.version,quizCount:JSON.parse(video.quiz).length,rows});
  }
  let result;
  if(endpoint==='learning')result=portalAdminLearning(ctx,x);
  else if(endpoint==='review-videos')result=portalAdminVideo(ctx,x);
  else if(endpoint==='reservations')result=portalReservation(ctx,x);
  else portalFail('이 작업 공간에서 지원되지 않는 기능입니다.',501);
  await portalWrite(ctx);
  return json(result);
}
async function portalLimit(env,scope,limit,period){
  const window=Math.floor(Date.now()/period);
  const row=await env.DB.prepare(`INSERT INTO student_portal_attempts(scope,window,count) VALUES(?,?,1)
    ON CONFLICT(scope) DO UPDATE SET count=CASE WHEN window=excluded.window THEN min(count+1,?) ELSE 1 END,window=excluded.window
    RETURNING count`).bind(scope,window,limit+1).first();
  if(row.count>limit)portalFail('시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.',429);
}
function portalCookie(ctx,token,maxAge){
  return 'ys_student='+token+'; Path=/api/portal/'+ctx.id+'; Secure; HttpOnly; SameSite=Strict; Max-Age='+maxAge;
}
async function portalLogin(request,ctx){
  const body=await readJson(request,4096);
  const nickname=portalString(body?.nickname,24).normalize('NFKC').toLowerCase();
  const pin=portalString(body?.pin,6).toUpperCase();
  const now=Date.now();
  await portalLimit(ctx.env,ctx.id+':all',120,60000);
  const entry=Object.entries(ctx.data.credentials).find(([,c])=>c.nickname===nickname&&!c.disabled);
  const [id,credential]=entry||[];
  await portalLimit(ctx.env,ctx.id+':'+(id||'unknown'),5,900000);
  const student=portalList(ctx.records.students).find(s=>s.id===id);
  if(!/^YE\d{4}$/.test(pin)||!portalActive(student)||!credential)
    portalFail('닉네임 또는 PIN을 확인해 주세요.',401);
  const clear=await portalPin(ctx.env,ctx.id,id,credential);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(ctx.env.STUDENT_PORTAL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(clear));
  if(!await crypto.subtle.verify('HMAC',key,signature,new TextEncoder().encode(pin)))
    portalFail('닉네임 또는 PIN을 확인해 주세요.',401);
  const token=uid()+uid(), lifetime=8*3600;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM student_portal_sessions WHERE expires_at<=?').bind(now),
    ctx.env.DB.prepare('INSERT INTO student_portal_sessions(token_hash,workspace_id,student_id,credential_version,expires_at) VALUES(?,?,?,?,?)')
      .bind(await portalDigest(token),ctx.id,id,credential.version,now+lifetime*1000),
  ]);
  return Response.json({ok:true},{headers:{'Set-Cookie':portalCookie(ctx,token,lifetime)}});
}
async function portalSession(request,ctx) {
  const token=/(?:^|;\s*)ys_student=([a-f0-9-]{72})(?:;|$)/.exec(request.headers.get('Cookie')||'')?.[1];
  if(!token)portalFail('닉네임과 PIN으로 로그인해 주세요.',401);
  const hash=await portalDigest(token);
  const session=await ctx.env.DB.prepare(
    'SELECT student_id,credential_version FROM student_portal_sessions WHERE token_hash=? AND workspace_id=? AND expires_at>?'
  ).bind(hash,ctx.id,Date.now()).first();
  const student=portalList(ctx.records.students).find(s=>s.id===session?.student_id);
  const credential=student&&ctx.data.credentials[student.id];
  if(!portalActive(student)||!credential||credential.disabled||credential.version!==session?.credential_version)
    portalFail('닉네임과 PIN으로 다시 로그인해 주세요.',401);
  return {student,hash};
}
function portalQuestionsForStudent(serialized){
  return JSON.parse(serialized).map(({id,type,prompt,points,choices})=>({id,type,prompt,points,choices}));
}
function portalStudentExam(ctx,student,id){
  const link=portalFind(ctx.data.links,id,'시험을 찾을 수 없습니다.');
  const exam=portalFind(ctx.data.exams,link.exam_id,'시험을 찾을 수 없습니다.');
  if(!exam.published||!portalRoster(ctx,link.course_id,student))portalFail('이 시험에 접근할 수 없습니다.',404);
  return {link,exam};
}
function portalAnswerMap(input,questions){
  if(!input||typeof input!=='object'||Array.isArray(input))portalFail('답안을 확인해 주세요.');
  return Object.fromEntries(questions.map(q=>[q.id,portalString(input[q.id]??'',2000,true)]));
}
function portalAvailableSlots(ctx,student){
  return ctx.data.slots.filter(s=>s.open&&Date.parse(s.date+'T'+s.start+':00+09:00')>Date.now()&&portalRoster(ctx,s.courseId,student))
    .map(s=>({...s,remaining:s.capacity-ctx.data.bookings.filter(b=>b.slotId===s.id&&b.status!=='cancelled').length}));
}
async function portalPublic(request,env,url,match){
  const [,workspaceId,action]=match;
  if(foreign(request))portalFail('다른 사이트의 요청은 허용하지 않습니다.',403);
  const w=await env.DB.prepare("SELECT w.* FROM workspaces w JOIN accounts a ON a.workspace_id=w.id WHERE w.id=? AND a.status='active'").bind(workspaceId).first();
  if(!w)portalFail('학생 포털을 찾을 수 없습니다.',404);
  const ctx=await portalContext(env,w);
  if(action==='login'&&request.method==='POST')return portalLogin(request,ctx);
  const {student,hash}=await portalSession(request,ctx);
  const d=ctx.data;
  if(action==='logout'&&request.method==='POST'){
    await env.DB.prepare('DELETE FROM student_portal_sessions WHERE token_hash=? AND workspace_id=?').bind(hash,ctx.id).run();
    return Response.json({ok:true},{headers:{'Set-Cookie':portalCookie(ctx,'',0)}});
  }
  if(action==='dashboard'&&request.method==='GET'){
    const courses=portalCourses(ctx).filter(c=>portalRoster(ctx,c.id,student));
    const exams=d.links.filter(l=>courses.some(c=>c.id===l.course_id)&&d.exams.some(e=>e.id===l.exam_id&&e.published)).map(l=>{
      const exam=d.exams.find(e=>e.id===l.exam_id), attempt=d.attempts.find(a=>a.link_id===l.id&&a.student_id===student.id);
      return {id:l.id,title:exam.title,lesson:l.lesson_no,courseId:l.course_id,submitted:!!attempt,score:attempt&&!attempt.pending?attempt.score:null,pending:!!attempt?.pending};
    });
    const videos=d.videos.filter(v=>portalVideoAccess(ctx,student,v)).sort((a,b)=>a.sort_order-b.sort_order||a.lesson_no-b.lesson_no).map(v=>{
      const p=portalProgress(ctx,v,student.id);
      return {id:v.id,videoId:v.video_id,title:v.title,description:v.description,lesson:v.lesson_no,complete:!!p?.complete,quiz:portalQuestionsForStudent(v.quiz),tries:p?.tries||0,bestScore:p?.bestScore??null};
    });
    return json({name:student.name,title:w.title,courses,exams,videos,slots:portalAvailableSlots(ctx,student),
      bookings:d.bookings.filter(b=>b.studentId===student.id),notices:d.notices.filter(n=>courses.some(c=>c.id===n.course_id))});
  }
  if(action==='exam'&&request.method==='GET'){
    const {link,exam}=portalStudentExam(ctx,student,url.searchParams.get('assignment'));
    return json({id:link.id,title:exam.title,questions:portalQuestionsForStudent(exam.questions),paper:!!exam.paper_key,submitted:d.attempts.some(a=>a.link_id===link.id&&a.student_id===student.id)});
  }
  if(action==='paper'&&request.method==='GET'){
    const {exam}=portalStudentExam(ctx,student,url.searchParams.get('assignment'));
    const file=exam.paper_key&&await env.BUCKET?.get(exam.paper_key);
    if(!file)portalFail('시험지 파일을 찾을 수 없습니다.',404);
    return new Response(file.body,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="exam.pdf"'}});
  }
  if(request.method!=='POST')portalFail('지원하지 않는 요청입니다.',405);
  const x=await readJson(request,240*1024);
  if(!x||typeof x!=='object'||Array.isArray(x))portalFail('요청을 확인해 주세요.');
  if(action==='submit'){
    const {link,exam}=portalStudentExam(ctx,student,x.assignment);
    if(d.attempts.some(a=>a.link_id===link.id&&a.student_id===student.id))portalFail('이미 제출한 시험입니다.',409);
    const questions=JSON.parse(exam.questions),answers=portalAnswerMap(x.answers,questions),result=gradeAnswers(questions,answers);
    d.attempts.push({id:uid(),exam_id:exam.id,link_id:link.id,student_id:student.id,answers:JSON.stringify(answers),grading:JSON.stringify(result.grading),score:result.score,pending:result.pending,created_at:portalNow()});
  }else if(action==='book'){
    const slot=portalAvailableSlots(ctx,student).find(s=>s.id===x.slotId);
    if(!slot||slot.remaining<1)portalFail('이 시간은 예약할 수 없습니다.',409);
    if(d.bookings.some(b=>b.studentId===student.id&&b.date===slot.date&&b.status!=='cancelled'&&b.start<slot.end&&slot.start<b.end))
      portalFail('같은 시간대에 이미 예약이 있습니다.',409);
    d.bookings.push({id:uid(),slotId:slot.id,courseId:slot.courseId,studentId:student.id,date:slot.date,start:slot.start,end:slot.end,status:'confirmed'});
  }else if(action==='cancel'){
    const booking=d.bookings.find(b=>b.id===x.id&&b.studentId===student.id);
    if(!booking||booking.status!=='confirmed'||Date.parse(booking.date+'T'+booking.start+':00+09:00')<=Date.now())portalFail('취소를 요청할 수 없는 예약입니다.',409);
    booking.status='cancel_requested';
  }else if(action==='review'){
    const video=d.videos.find(v=>v.id===x.id&&portalVideoAccess(ctx,student,v));
    if(!video)portalFail('영상을 찾을 수 없습니다.',404);
    let p=portalProgress(ctx,video,student.id);
    if(!p){p={videoId:video.id,studentId:student.id,version:video.version,complete:false,tries:0,bestScore:null};d.progress.push(p);}
    if(x.complete===true)p.complete=true;
    if(x.answers){
      const qs=JSON.parse(video.quiz);
      if(!p.complete||!qs.length||p.tries>=3)portalFail('퀴즈 응시 횟수를 확인해 주세요.',409);
      const result=gradeAnswers(qs,portalAnswerMap(x.answers,qs));
      p.tries++;
      p.bestScore=Math.max(p.bestScore??0,result.score);
    }
  }else portalFail('지원하지 않는 요청입니다.',404);
  await portalWrite(ctx);
  return json({ok:true});
}

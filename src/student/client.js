'use strict';

const app=document.querySelector('#student-app');
const prefix='/api/portal/'+(document.querySelector('meta[name="ys-workspace"]')?.content||location.pathname.split('/').pop())+'/';
const params=new URLSearchParams(location.search);
const assignment=params.get('assignment');
let currentTab=['booking','learning','videos'].includes(params.get('tab'))?params.get('tab'):'booking';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabels={confirmed:'예약 확정',cancel_requested:'취소 요청',cancelled:'취소 완료'};
const notice=message=>{document.querySelector('#notice').textContent=message;};
async function request(path,data){
  const response=await fetch(prefix+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const body=await response.json();
  if(!response.ok)throw Object.assign(Error(body.error||'요청을 완료하지 못했습니다.'),{status:response.status});
  return body;
}
function login(){
  app.innerHTML='<section class="hero"><h1>학생 포털</h1><p>선생님이 알려준 닉네임과 PIN으로 접속하세요.</p>'
    +'<form class="form" id="student-login"><label>닉네임<input name="nickname" maxlength="24" autocomplete="username" required></label>'
    +'<label>PIN<input name="pin" type="password" maxlength="6" placeholder="YE0000" autocomplete="current-password" required></label>'
    +'<div><button>접속하기</button></div><p role="alert" class="error" id="login-error"></p></form></section>';
  document.querySelector('#student-login').onsubmit=async event=>{
    event.preventDefault();
    const button=event.currentTarget.querySelector('button');
    button.disabled=true;
    try{await request('login',Object.fromEntries(new FormData(event.currentTarget)));await start();}
    catch(error){document.querySelector('#login-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
}
function fields(questions){
  return questions.map((q,i)=>{
    const title=escape((i+1)+'. '+q.prompt);
    const options=q.type==='choice'?q.choices.map((choice,index)=>[index+1,choice]):q.type==='ox'?[['O','O'],['X','X']]:null;
    if(options)return '<label>'+title+'<select name="'+escape(q.id)+'"><option value="">선택</option>'
      +options.map(([key,value])=>'<option value="'+key+'">'+escape(value)+'</option>').join('')+'</select></label>';
    if(q.type==='essay')return '<label>'+title+'<textarea name="'+escape(q.id)+'" maxlength="2000"></textarea></label>';
    return '<label>'+title+'<input name="'+escape(q.id)+'" maxlength="2000"></label>';
  }).join('');
}
async function exam(id){
  const info=await request('exam?assignment='+encodeURIComponent(id));
  const back=location.pathname+'?tab=learning';
  app.innerHTML='<section class="panel stack"><a href="'+escape(back)+'">← 시험 목록</a><h1>'+escape(info.title)+'</h1>'
    +(info.paper?'<a href="'+prefix+'paper?assignment='+encodeURIComponent(id)+'">시험지 PDF 다운로드</a>':'')
    +(info.submitted?'<p>이미 제출한 시험입니다.</p>':'<form class="form" id="student-submit">'+fields(info.questions)+'<div><button>답안 제출</button></div></form>')+'</section>';
  const form=document.querySelector('#student-submit');
  if(form)form.onsubmit=async event=>{
    event.preventDefault();
    if(!confirm('답안을 제출할까요? 제출 후 답안을 수정할 수 없습니다.'))return;
    const button=form.querySelector('button');
    button.disabled=true;
    try{await request('submit',{assignment:id,answers:Object.fromEntries(new FormData(form))});await exam(id);}
    catch(error){notice(error.message);button.disabled=false;}
  };
}
function renderBooking(data){
  const course=id=>data.courses.find(c=>c.id===id)?.title||'수업';
  const slots=data.slots.slice().sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start));
  const days=[...new Set(slots.map(slot=>slot.date))];
  const format=b=>escape(course(b.courseId)+' · '+b.date+' '+b.start+'–'+b.end);
  return '<div class="student-booking-grid"><section class="panel"><h2>예약 날짜</h2><div class="stack" id="student-days">'
    +(days.map(date=>'<button class="light" data-day="'+escape(date)+'">'+escape(date)+'</button>').join('')||'<p>열린 예약 시간이 없습니다.</p>')
    +'</div></section><section class="panel"><h2>시간 선택</h2><div class="stack" id="student-times"></div></section></div>'
    +'<section class="panel stack"><h2>내 예약</h2>'+ (data.bookings.map(b=>'<div class="row"><div>'+format(b)+'<br><small>'+escape(statusLabels[b.status])+'</small></div>'
    +(b.status==='confirmed'&&Date.parse(b.date+'T'+b.start+':00+09:00')>Date.now()?'<button class="light" data-cancel="'+escape(b.id)+'">취소 요청</button>':'')+'</div>').join('')||'<p>예약 내역이 없습니다.</p>')+'</section>';
}
function renderVideos(data){
  return '<section class="panel stack"><h2>복습 영상</h2>'+(data.videos.map(v=>'<details class="student-video" data-video="'+escape(v.id)+'"><summary>'+escape(v.lesson+'차시 · '+v.title)+'</summary>'
    +'<p>'+escape(v.description)+'</p><div class="student-player"></div>'
    +(v.complete?'<p>시청 완료</p>':'<button class="light" data-complete="'+escape(v.id)+'">시청 완료 표시</button>')
    +(v.quiz.length?'<p>퀴즈 '+v.tries+'/3회 · 최고 점수 '+(v.bestScore??'미응시')+'</p>':'')
    +(v.complete&&v.quiz.length&&v.tries<3?'<form class="form" data-quiz="'+escape(v.id)+'">'+fields(v.quiz)+'<div><button>퀴즈 제출</button></div></form>':'')+'</details>').join('')||'<p>배정된 영상이 없습니다.</p>')+'</section>';
}
function dashboard(data){
  const labels={booking:'예약',learning:'시험 · 답안 입력',videos:'복습 영상'};
  const exams='<section class="panel stack"><h2>시험 · 답안 입력</h2>'+ (data.exams.map(e=>'<div class="row"><div>'+escape(e.title)+' · '+e.lesson+'회차</div>'
    +(e.submitted?'<span>'+(e.pending?'채점 검토 중':e.score+'점')+'</span>':'<button class="light" data-exam="'+escape(e.id)+'">답안 입력</button>')+'</div>').join('')||'<p>배정된 시험이 없습니다.</p>')+'</section>';
  app.innerHTML='<div class="row"><div><h1>'+escape(data.title)+'</h1><p>'+escape(data.name)+' 학생</p></div><button id="student-logout" class="light">로그아웃</button></div>'
    +'<nav aria-label="학생 메뉴">'+Object.entries(labels).map(([key,label])=>'<button class="'+(key===currentTab?'active':'')+'" aria-pressed="'+(key===currentTab)+'" data-tab="'+key+'">'+label+'</button>').join('')+'</nav>'
    +'<div class="stack">'+(currentTab==='booking'?renderBooking(data):currentTab==='videos'?renderVideos(data):exams)+'</div>';
  async function update(button,path,body,message){
    button.disabled=true;
    try{await request(path,body);await start();notice(message);}
    catch(error){notice(error.message);button.disabled=false;}
  }
  const showDay=date=>{
    const times=document.querySelector('#student-times');
    times.innerHTML=data.slots.filter(s=>s.date===date).sort((a,b)=>a.start.localeCompare(b.start)).map(s=>
      '<div class="row"><div>'+escape(s.start+'–'+s.end)+'<br><small>'+escape(data.courses.find(c=>c.id===s.courseId)?.title)+' · 남은 자리 '+s.remaining+'</small></div>'
      +'<button data-book="'+escape(s.id)+'" '+(s.remaining<1?'disabled':'')+'>예약</button></div>').join('')||'<p>예약 가능한 시간이 없습니다.</p>';
    for(const button of document.querySelectorAll('[data-day]'))button.setAttribute('aria-pressed',String(button.dataset.day===date));
    for(const button of times.querySelectorAll('[data-book]'))button.onclick=()=>{if(confirm('이 시간으로 예약할까요?'))update(button,'book',{slotId:button.dataset.book},'예약했습니다.');};
  };
  const days=Array.from(document.querySelectorAll('[data-day]'));
  for(const button of days)button.onclick=()=>showDay(button.dataset.day);
  if(currentTab==='booking')showDay(days[0]?.dataset.day);
  for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>{currentTab=button.dataset.tab;dashboard(data);};
  for(const button of document.querySelectorAll('[data-cancel]'))button.onclick=()=>{if(confirm('예약 취소를 요청할까요?'))update(button,'cancel',{id:button.dataset.cancel},'취소를 요청했습니다.');};
  for(const button of document.querySelectorAll('[data-exam]'))button.onclick=()=>exam(button.dataset.exam).catch(error=>notice(error.message));
  for(const detail of document.querySelectorAll('[data-video]'))detail.ontoggle=()=>{
    const player=detail.querySelector('.student-player');
    if(!detail.open){player.replaceChildren();return;}
    const video=data.videos.find(v=>v.id===detail.dataset.video);
    if(!video||!/^[\w-]{11}$/.test(video.videoId))return;
    const frame=document.createElement('iframe');
    frame.src='https://www.youtube-nocookie.com/embed/'+video.videoId;
    frame.title=video.title;
    frame.allowFullscreen=true;
    frame.referrerPolicy='strict-origin-when-cross-origin';
    player.replaceChildren(frame);
  };
  for(const button of document.querySelectorAll('[data-complete]'))button.onclick=()=>update(button,'review',{id:button.dataset.complete,complete:true},'시청 완료를 저장했습니다.');
  for(const form of document.querySelectorAll('[data-quiz]'))form.onsubmit=event=>{
    event.preventDefault();
    update(form.querySelector('button'),'review',{id:form.dataset.quiz,answers:Object.fromEntries(new FormData(form))},'퀴즈를 채점했습니다.');
  };
  document.querySelector('#student-logout').onclick=async()=>{try{await request('logout',{});login();}catch(error){notice(error.message);}};
}
async function start(){
  try{const data=await request('dashboard');if(assignment)await exam(assignment);else dashboard(data);}
  catch(error){if(error.status===401)login();else{app.replaceChildren();const p=document.createElement('p');p.textContent=error.message;app.append(p);}}
}
void start();

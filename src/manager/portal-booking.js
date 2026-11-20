function renderPortalBookings(node){
  const statuses={confirmed:'예약 확정',cancel_requested:'취소 요청',cancelled:'취소 완료'};
  node.innerHTML='<section class="card bottom"><div class="row"><div><h3>예약 가능 시간</h3><p>수강생이 예약할 날짜와 정원을 설정합니다.</p></div>'
    +'<a class="btn light" href="'+esc(studentPortalUrl('booking'))+'" target="_blank" rel="noopener">학생 예약 페이지 열기</a></div>'
    +'<div class="toolbar"><button class="btn" id="portal-new-slot">＋ 예약 시간 등록</button></div>'
    +table(['날짜','수업','시간','정원','상태'],(remote.slots||[]).slice().sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start)).map(s=>[
      esc(s.date),esc(courseName(s.courseId)),esc(s.start+'–'+s.end),s.capacity,s.open?'<button class="btn light small" data-close-slot="'+esc(s.id)+'">예약 닫기</button>':'닫힘']))
    +'</section><section class="card bottom"><h3>예약 목록</h3>'
    +table(['날짜','시간','학생','수업','상태','관리'],remote.bookings.map(b=>[
      esc(b.date),esc(b.start+'–'+b.end),esc(remoteName(b.studentId)),esc(courseName(b.courseId)),badge(statuses[b.status]),
      b.status==='cancel_requested'?'<button class="btn small" data-booking="'+esc(b.id)+'" data-status="cancelled">취소 승인</button> <button class="btn light small" data-booking="'+esc(b.id)+'" data-status="confirmed">요청 반려</button>':
      b.status==='confirmed'?'<button class="btn light small" data-booking="'+esc(b.id)+'" data-status="cancelled">예약 취소</button>':'']))
    +'</section>';
  const update=async (button,body)=>{
    button.disabled=true;
    try{await bookingApi('reservations',body);await syncRemote();toast('저장했습니다.');}
    catch(error){toast(error.message);button.disabled=false;}
  };
  node.querySelector('#portal-new-slot').onclick=()=>{
    const modal=$('#modal');
    modal.innerHTML='<h2>예약 시간 등록</h2><form class="feature-form" id="portal-slot"><div class="fields"><label>수업<select name="courseId" required>'
      +remote.courses.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.title)+'</option>').join('')
      +'</select></label><label>날짜<input type="date" name="date" min="'+today()+'" required></label>'
      +'<label>시작<input type="time" name="start" required></label><label>종료<input type="time" name="end" required></label>'
      +'<label>정원<input type="number" name="capacity" min="1" max="999" value="5" required></label></div>'
      +'<div class="actions"><button class="btn light" type="button" id="portal-slot-dismiss">닫기</button><button class="btn" type="submit">등록</button></div></form>';
    modal.querySelector('#portal-slot-dismiss').onclick=()=>modal.close();
    modal.querySelector('#portal-slot').onsubmit=async event=>{
      event.preventDefault();
      const form=event.currentTarget,button=form.querySelector('[type=submit]');
      button.disabled=true;
      try{
        await bookingApi('reservations',{action:'slot',...Object.fromEntries(new FormData(form))});
        modal.close();
        await syncRemote();
        toast('예약 시간을 등록했습니다.');
      }catch(error){toast(error.message);button.disabled=false;}
    };
    modal.showModal();
  };
  for(const button of node.querySelectorAll('[data-close-slot]'))button.onclick=()=>{
    if(confirm('이 시간의 새 예약을 닫을까요?'))update(button,{action:'close',id:button.dataset.closeSlot});
  };
  for(const button of node.querySelectorAll('[data-booking]'))button.onclick=()=>{
    if(confirm('이 예약의 상태를 변경할까요?'))update(button,{action:'booking-status',id:button.dataset.booking,status:button.dataset.status});
  };
}

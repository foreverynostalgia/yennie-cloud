'use strict';

const cloudManagerEmpty = () => ({
  students: [], classes: [], attendance: {}, tasks: [], scores: [],
  bookings: [], notes: [], payments: [], notices: [],
});
const cloudManagerOptionalFields = ['settlementRules', 'attendanceAssignments'];
const cloudManagerHistoryKey = 'yensense-weekly-history';
let cloudManagerWorkspace;
let cloudManagerData;
let cloudManagerPending = null;
let cloudManagerSaving = false;
let cloudManagerFailed = false;

function cloudManagerStatus(message, recover = false) {
  const node = document.querySelector('#cloud-save-status');
  if (!node) return;
  node.replaceChildren(document.createTextNode(message));
  if (!recover) return;

  const download = document.createElement('button');
  download.className = 'btn light small';
  download.textContent = '저장되지 않은 기록 다운로드';
  download.onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(cloudManagerData, null, 2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'yensense-unsaved.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  node.append(' ', download);
}

const cloudManagerStorage = {
  getItem(key) {
    if (key === cloudManagerHistoryKey) return JSON.stringify(cloudManagerData[key] || []);
    const value = cloudManagerEmpty();
    for (const field of [...Object.keys(value), ...cloudManagerOptionalFields]) {
      if (Object.hasOwn(cloudManagerData, field)) value[field] = cloudManagerData[field];
    }
    return JSON.stringify(value);
  },
  setItem(key, value) {
    if (key === cloudManagerHistoryKey) {
      cloudManagerData[key] = JSON.parse(value);
    } else {
      for (const field of cloudManagerOptionalFields) delete cloudManagerData[field];
      Object.assign(cloudManagerData, JSON.parse(value));
    }
    cloudManagerPending = JSON.stringify(cloudManagerData);
    void cloudManagerFlush();
  },
};

async function cloudManagerFlush() {
  if (cloudManagerSaving || cloudManagerFailed) return;
  cloudManagerSaving = true;
  try {
    while (cloudManagerPending !== null) {
      const snapshot = cloudManagerPending;
      cloudManagerStatus('클라우드에 저장 중…');
      const response = await fetch('/api/workspace', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({data:JSON.parse(snapshot), revision:cloudManagerWorkspace.revision}),
      });
      if (!response.ok) {
        if (response.status === 409) throw new Error('다른 탭이나 기기에서 먼저 저장했습니다. 아래에서 작업 내용을 내려받을 수 있습니다.');
        throw new Error('클라우드에 저장하지 못했습니다. 아래에서 작업 내용을 내려받을 수 있습니다.');
      }
      cloudManagerWorkspace.revision = (await response.json()).revision;
      if (cloudManagerPending === snapshot) cloudManagerPending = null;
    }
    cloudManagerStatus('');
  } catch (error) {
    cloudManagerFailed = true;
    cloudManagerStatus(error.message, true);
  } finally {
    cloudManagerSaving = false;
  }
}

function cloudManagerScript(name) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/manager/' + name;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

async function cloudManagerStart() {
  const app = document.querySelector('#app');
  try {
    const response = await fetch('/api/workspace');
    if (response.status === 401 || response.status === 403) {
      location.replace('/');
      return;
    }
    if (!response.ok) throw new Error();
    cloudManagerWorkspace = await response.json();
    cloudManagerData = cloudManagerWorkspace.data;
    for (const name of ['homework.js','app.js','qrcode.js','integration.js','weekly.js','videos.js','ocr.js']) {
      await cloudManagerScript(name);
    }
    if (invalidStoredData) {
      throw new Error('저장된 데이터 형식이 관리자 화면과 일치하지 않습니다. 계정 · 자료실에서 원본 기록을 확인할 수 있습니다.');
    }
    const status = document.createElement('div');
    status.id = 'cloud-save-status';
    status.setAttribute('role','status');
    app.before(status);
    initReport();
  } catch (error) {
    const message = document.createElement('p');
    message.textContent = error.message || '관리자 화면을 불러오지 못했습니다. 새로고침해 주세요.';
    const link = document.createElement('a');
    link.href = '/cloud';
    link.textContent = '계정 · 자료실 열기';
    app.replaceChildren(message, link);
  }
}

window.addEventListener('beforeunload', event => {
  if (!cloudManagerPending) return;
  event.preventDefault();
  event.returnValue = '';
});
void cloudManagerStart();

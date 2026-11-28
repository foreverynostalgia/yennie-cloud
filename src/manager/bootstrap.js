'use strict';

const cloudManagerEmpty = () => ({
  students: [], classes: [], attendance: {}, tasks: [], scores: [],
  bookings: [], notes: [], payments: [], notices: [],
});
const cloudManagerOptionalFields = ['settlementRules', 'attendanceAssignments'];
const cloudManagerHistoryKey = 'yensense-weekly-history';
let cloudManagerWorkspace;
let cloudManagerData;
let cloudManagerPending = null;   // true while there are unsaved edits
let cloudManagerSaving = false;
let cloudManagerFailed = false;
// What the server has, record by record (see store-codec.js), and each record's version.
let cloudManagerSynced = new Map();
let cloudManagerVersions = new Map();
// Records another device changed first: left as they are on the server until reload.
const cloudManagerBlocked = new Set();
const cloudManagerChunk = 700000;

function cloudManagerStatus(message, recover = false, reload = false) {
  const node = document.querySelector('#cloud-save-status');
  if (!node) return;
  node.replaceChildren(document.createTextNode(message));
  if (reload) {
    const again = document.createElement('button');
    again.className = 'btn light small';
    again.textContent = '새로고침';
    again.onclick = () => location.reload();
    node.append(' ', again);
  }
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
    cloudManagerPending = true;
    void cloudManagerFlush();
  },
};

// Changed records since the last save, split into requests of a safe size.
// Order records go last so new items are saved before the lists that name them.
function cloudManagerBatches() {
  const changes = [];
  for (const [key, text] of storeDiff(cloudManagerSynced, storeEncode(cloudManagerData))) {
    if (cloudManagerBlocked.has(key)) continue;
    const [c, r] = storeSplit(key);
    const change = text === null ? {c, r, b: cloudManagerVersions.get(key) || 0, del: true} : {c, r, b: cloudManagerVersions.get(key) || 0, d: JSON.parse(text)};
    changes.push({key, text, change, size: (text || '').length + c.length + r.length + 40});
  }
  changes.sort((a, b) => (a.change.c === '#o') - (b.change.c === '#o'));
  const batches = [];
  let current = [], size = 0;
  for (const item of changes) {
    if (current.length && (size + item.size > cloudManagerChunk || current.length >= 5000)) { batches.push(current); current = []; size = 0; }
    current.push(item);
    size += item.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function cloudManagerFlush() {
  if (cloudManagerSaving || cloudManagerFailed) return;
  cloudManagerSaving = true;
  try {
    while (cloudManagerPending) {
      cloudManagerPending = false;
      for (const batch of cloudManagerBatches()) {
        cloudManagerStatus('클라우드에 저장 중…');
        const response = await fetch('/api/workspace/changes', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({changes: batch.map(item => item.change)}),
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 409 && Array.isArray(result.conflicts) && result.conflicts.length) {
          for (const {c, r} of result.conflicts) cloudManagerBlocked.add(storeKey(c, r));
          cloudManagerPending = true;   // save the rest without the conflicting records
          break;
        }
        if (!response.ok) throw new Error('클라우드에 저장하지 못했습니다. 아래에서 작업 내용을 내려받을 수 있습니다.');
        for (const item of batch) {
          if (item.text === null) { cloudManagerSynced.delete(item.key); cloudManagerVersions.delete(item.key); }
          else { cloudManagerSynced.set(item.key, item.text); cloudManagerVersions.set(item.key, result.versions?.[item.key] ?? 0); }
        }
        cloudManagerWorkspace.revision = result.revision;
      }
    }
    if (cloudManagerBlocked.size) {
      cloudManagerStatus('다른 기기에서 먼저 고친 기록 ' + cloudManagerBlocked.size + '개는 저장하지 않았어요. 새로고침하면 최신 내용이 보여요.', true, true);
    } else {
      cloudManagerStatus('');
    }
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
    await cloudManagerScript('store-codec.js');
    const response = await fetch('/api/workspace?versions=1');
    if (response.status === 401 || response.status === 403) {
      location.replace('/');
      return;
    }
    if (!response.ok) throw new Error();
    cloudManagerWorkspace = await response.json();
    cloudManagerData = cloudManagerWorkspace.data;
    cloudManagerSynced = storeEncode(cloudManagerData);
    cloudManagerVersions = new Map(Object.entries(cloudManagerWorkspace.versions || {}));
    for (const name of ['homework.js','app.js','qrcode.js','integration.js','portal-booking.js','weekly.js','videos.js','ocr.js']) {
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
    await syncRemote();
    try {
      const usage = await (await fetch('/api/usage')).json();
      const words = {'students-80': '학생 수가 요금제 한도의 80%를 넘었어요.', 'students-full': '학생 수가 요금제 한도에 닿았어요.', 'files-80': '파일 보관 용량의 80%를 넘었어요.', 'files-full': '파일 보관 용량이 가득 찼어요.'};
      if (usage.warn?.length && !cloudManagerPending) cloudManagerStatus(usage.warn.map(w => words[w]).join(' ') + ' 계정 · 자료실 → 설정에서 확인할 수 있어요.');
    } catch {}
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

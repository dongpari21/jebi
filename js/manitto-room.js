// 마니또 온라인 방: 진행자가 방을 만들고 → 참가자가 초대 링크로 입장 → 진행자가 구성 완료하면
// 각 참가자는 자기 마니또만 확인할 수 있다.
import { shuffle } from './random.js?v=6';
import { $, escapeHtml, pageUrl, shareOrCopy, toast } from './utils.js?v=6';
import * as api from './room-api.js?v=6';

const ADMIN_KEY = 'jebi:room';
const MIN_MEMBERS = 3;
const MAX_MEMBERS = 50;

let deps;

const roomName = (room) => room?.title?.trim() || '마니또';
const inviteUrl = (roomId) => `${pageUrl()}?room=${roomId}`;
const duplicateNames = (members) =>
  [...new Set(members.map((m) => m.name).filter((n, i, a) => a.indexOf(n) !== i))];

function errorMessage(err) {
  if (err?.message === 'not-configured') return '온라인 방 기능이 아직 설정되지 않았어요.';
  if (err?.code === 'permission-denied') return '권한이 없어요. 방이 이미 닫혔을 수 있어요.';
  if (err?.code === 'unavailable' || !navigator.onLine) return '인터넷 연결을 확인해 주세요.';
  return '문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
}

function memberChips(members, myUid, { removable = false } = {}) {
  return members.map((m, i) => `
    <article class="m-card${m.uid === myUid ? ' is-me' : ''}" style="--i:${i}">
      <span class="m-avatar" aria-hidden="true">${escapeHtml([...m.name][0])}</span>
      <span class="m-info"><span class="m-name">${escapeHtml(m.name)}</span>
        <span class="m-state">${m.uid === myUid ? '나' : `${i + 1}번째 입장`}</span></span>
      ${removable ? `<span class="m-actions"><button class="btn btn-sm btn-icon btn-ghost" type="button" data-remove="${m.uid}" aria-label="${escapeHtml(m.name)} 내보내기" title="내보내기">✕</button></span>` : ''}
    </article>`).join('');
}

async function revealMine(roomId, name) {
  try {
    const secret = await api.getMySecret(roomId);
    if (!secret) {
      toast('내 마니또 정보를 찾지 못했어요. 진행자에게 문의해 주세요');
      return;
    }
    deps.openManittoDialog(name, secret.target, null, secret.title);
  } catch (err) {
    toast(errorMessage(err));
  }
}

/* ==========================================================================
   진행자 (마니또 탭 → 온라인 방)
   ========================================================================== */
const admin = {
  started: false,
  roomId: null,
  room: null,
  members: [],
  uid: null,
  unsub: [],
  busy: false,
};

function loadAdminRoom() {
  try { return JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null')?.roomId ?? null; } catch { return null; }
}
function saveAdminRoom(roomId) {
  try {
    if (roomId) localStorage.setItem(ADMIN_KEY, JSON.stringify({ roomId }));
    else localStorage.removeItem(ADMIN_KEY);
  } catch {}
}

function adminError(msg) {
  const el = $('#room-error');
  el.hidden = !msg;
  el.textContent = msg || '';
}

function renderAdmin() {
  const { roomId, room, members, uid, busy } = admin;
  const hasRoom = Boolean(roomId && room);
  $('#room-create-form').hidden = hasRoom;
  $('#room-manage').hidden = !hasRoom;
  $('#room-create-btn').disabled = busy || !api.isConfigured();

  const grid = $('#room-members');
  if (!hasRoom) {
    $('#room-status').innerHTML = '';
    grid.innerHTML = `<div class="empty"><span class="empty-emoji" aria-hidden="true">💌</span>
      <p>방을 만들고 초대 링크를 보내면<br>입장한 사람이 여기에 실시간으로 보여요.</p></div>`;
    return;
  }

  const open = room.status === 'open';
  const dups = duplicateNames(members);
  const me = members.find((m) => m.uid === uid);

  $('#room-name').textContent = roomName(room);
  $('#room-badge').textContent = open ? '입장 받는 중' : '구성 완료';
  $('#room-badge').classList.toggle('is-done', !open);
  $('#room-open-actions').hidden = !open;
  $('#room-done-actions').hidden = open;

  $('#room-self').hidden = !open;
  $('#room-self-form').hidden = Boolean(me);
  $('#room-self-joined').hidden = !me;
  $('#room-self-joined-name').textContent = me?.name ?? '';
  $('#room-my-manitto').hidden = open || !me;

  const canComplete = members.length >= MIN_MEMBERS && !dups.length && members.length <= MAX_MEMBERS;
  $('#room-complete').disabled = busy || !canComplete;
  $('#room-complete-hint').textContent = dups.length
    ? `같은 이름이 있어요: ${dups.join(', ')} — 한 명을 내보내거나 이름을 바꿔 달라고 해주세요.`
    : members.length < MIN_MEMBERS ? `${MIN_MEMBERS}명 이상 입장하면 구성을 완료할 수 있어요.` : '';
  $('#room-complete-hint').classList.toggle('is-error', dups.length > 0);

  $('#room-status').innerHTML = open
    ? `<span>입장 <b>${members.length}</b>명</span><span class="live-dot">실시간</span>`
    : `<span>참가 <b>${members.length}</b>명</span><span class="done">구성 완료 🎁 각자 자기 마니또만 볼 수 있어요</span>`;

  grid.innerHTML = members.length
    ? memberChips(members, uid, { removable: open })
    : '<div class="empty"><span class="empty-emoji" aria-hidden="true">📨</span><p>아직 입장한 사람이 없어요.<br><b>초대 링크 보내기</b>로 링크를 공유해 보세요.</p></div>';
}

function stopWatching() {
  admin.unsub.forEach((off) => off());
  admin.unsub = [];
}

async function watchAdminRoom(roomId) {
  stopWatching();
  admin.roomId = roomId;
  admin.room = null;
  admin.members = [];
  try {
    admin.uid = await api.myUid();
    admin.unsub.push(await api.watchRoom(roomId, (room) => {
      if (!room || room.ownerUid !== admin.uid) {
        // 방이 없어졌거나 내 방이 아니면 초기화
        saveAdminRoom(null);
        stopWatching();
        admin.roomId = null;
      }
      admin.room = room;
      renderAdmin();
    }, (err) => adminError(errorMessage(err))));
    admin.unsub.push(await api.watchMembers(roomId, (members) => {
      admin.members = members;
      renderAdmin();
    }, (err) => adminError(errorMessage(err))));
  } catch (err) {
    adminError(errorMessage(err));
  }
}

async function withBusy(fn) {
  if (admin.busy) return;
  admin.busy = true;
  renderAdmin();
  try {
    await fn();
    adminError('');
  } catch (err) {
    console.error(err);
    toast(errorMessage(err));
  } finally {
    admin.busy = false;
    renderAdmin();
  }
}

async function sendInvite() {
  const text = `🎁 ${roomName(admin.room)}에 초대할게요!\n링크를 열고 이름을 입력해서 입장해 주세요.\n${inviteUrl(admin.roomId)}`;
  const r = await shareOrCopy(text);
  if (r === 'copied') toast('초대 링크를 복사했어요. 참가자들에게 보내주세요');
  else if (r === 'shared') toast('초대 링크를 공유했어요');
  else if (r === 'failed') toast('복사에 실패했어요');
}

function completeRoom() {
  const { members, room, roomId } = admin;
  if (members.length < MIN_MEMBERS || duplicateNames(members).length) return;
  if (!confirm(`${members.length}명으로 방 구성을 완료할까요?\n완료하면 더 이상 입장할 수 없고, 각자 자기 마니또만 확인할 수 있어요.`)) return;
  withBusy(async () => {
    // 섞은 순서대로 원형 배정 → 자기 자신·서로 챙기기 없음. 배정은 저장 직후 버려진다.
    const order = shuffle(members);
    const pairs = order.map((m, i) => ({ giverUid: m.uid, targetName: order[(i + 1) % order.length].name }));
    await api.completeRoom(roomId, roomName(room), pairs);
    toast('방 구성을 완료했어요! 이제 각자 마니또를 확인할 수 있어요');
  });
}

function initAdmin() {
  if (admin.started) return;
  admin.started = true;

  if (!api.isConfigured()) {
    adminError('온라인 방을 쓰려면 Firebase 설정이 필요해요. (README 참고)');
    renderAdmin();
    return;
  }

  $('#room-create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(async () => {
      const roomId = await api.createRoom($('#room-title').value.trim().slice(0, 30));
      saveAdminRoom(roomId);
      $('#room-title').value = '';
      await watchAdminRoom(roomId);
      toast('방을 만들었어요. 초대 링크를 보내주세요');
    });
  });
  $('#room-invite').addEventListener('click', sendInvite);
  $('#room-complete').addEventListener('click', completeRoom);
  $('#room-self-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#room-self-name').value.trim().slice(0, 20);
    if (!name) return;
    withBusy(() => api.joinRoom(admin.roomId, name));
  });
  $('#room-self-leave').addEventListener('click', () => withBusy(() => api.removeMember(admin.roomId)));
  $('#room-my-manitto').addEventListener('click', () => {
    const me = admin.members.find((m) => m.uid === admin.uid);
    if (me) revealMine(admin.roomId, me.name);
  });
  $('#room-new').addEventListener('click', () => {
    if (admin.room?.status === 'open' && admin.members.length
      && !confirm('지금 방을 두고 새 방을 만들까요?\n기존 방의 초대 링크로는 계속 입장할 수 있지만, 이 화면에서는 관리할 수 없게 돼요.')) return;
    stopWatching();
    saveAdminRoom(null);
    Object.assign(admin, { roomId: null, room: null, members: [] });
    renderAdmin();
  });
  $('#room-members').addEventListener('click', (e) => {
    const uid = e.target.closest('[data-remove]')?.dataset.remove;
    const member = admin.members.find((m) => m.uid === uid);
    if (member && confirm(`${member.name}님을 방에서 내보낼까요?`)) {
      withBusy(() => api.removeMember(admin.roomId, uid));
    }
  });

  renderAdmin();
  const saved = loadAdminRoom();
  if (saved) watchAdminRoom(saved);
}

/* ==========================================================================
   참가자 (초대 링크 ?room=ID 로 열었을 때)
   ========================================================================== */
const guest = { roomId: null, room: undefined, members: [], uid: null };

function renderGuest() {
  const { room, members, uid } = guest;
  const body = $('#rv-body');
  const me = members.find((m) => m.uid === uid);

  $('#rv-title').textContent = room ? roomName(room) : '마니또 방';
  $('#rv-members-wrap').hidden = !room;
  $('#rv-count').textContent = `${members.length}명`;
  $('#rv-members').innerHTML = members.map((m) =>
    `<li class="${m.uid === uid ? 'is-me' : ''}">${escapeHtml(m.name)}${m.uid === uid ? ' (나)' : ''}</li>`).join('');

  if (room === undefined) {
    body.innerHTML = '<p class="rv-text">방 정보를 불러오는 중…</p>';
  } else if (room === null) {
    body.innerHTML = '<p class="rv-text">방을 찾을 수 없어요.<br>진행자에게 초대 링크를 다시 받아주세요.</p>';
  } else if (room.status === 'open' && !me) {
    if (!$('#rv-join-form')) {
      body.innerHTML = `
        <p class="rv-text">이름을 입력하고 입장하세요.<br>진행자가 방 구성을 마치면 여기서 내 마니또를 확인할 수 있어요.</p>
        <form class="join-form" id="rv-join-form">
          <label class="sr-only" for="rv-name">이름</label>
          <input id="rv-name" type="text" maxlength="20" placeholder="이름" autocomplete="name" required>
          <button class="btn btn-primary btn-xl" type="submit">입장하기</button>
        </form>`;
    }
  } else if (room.status === 'open') {
    body.innerHTML = `
      <div class="rv-state"><span class="rv-check" aria-hidden="true">✓</span>
        <p><b>${escapeHtml(me.name)}</b>님, 입장 완료!</p></div>
      <p class="rv-text">진행자가 방 구성을 마치면 이 화면에서 바로 확인할 수 있어요.<br>이 창을 닫았다면 <b>같은 기기·브라우저</b>로 초대 링크를 다시 열어주세요.</p>
      <div class="rv-waiting" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="m-row">
        <button class="btn btn-ghost" type="button" data-act="rename">이름 바꾸기</button>
        <button class="btn btn-ghost" type="button" data-act="leave">나가기</button>
      </div>`;
  } else if (me) {
    body.innerHTML = `
      <p class="rv-text"><b>${escapeHtml(me.name)}</b>님, 방 구성이 끝났어요!<br>주변에 보는 사람이 없을 때 눌러주세요 🤫</p>
      <button class="btn btn-primary btn-xl" type="button" data-act="reveal">내 마니또 확인하기</button>`;
  } else {
    body.innerHTML = `<p class="rv-text">이미 구성이 끝난 방이에요.<br>입장했었다면 <b>입장할 때 쓴 기기·브라우저</b>로 이 링크를 열어주세요.</p>`;
  }
}

async function startGuest(roomId) {
  document.body.classList.add('is-room');
  $('#room-view').hidden = false;
  guest.roomId = roomId;
  renderGuest();

  if (!api.isConfigured()) {
    guest.room = null;
    $('#rv-body').innerHTML = '<p class="rv-text">온라인 방 기능이 아직 설정되지 않았어요.</p>';
    return;
  }
  const fail = (err) => {
    console.error(err);
    $('#rv-body').innerHTML = `<p class="rv-text">${escapeHtml(errorMessage(err))}</p>`;
  };
  try {
    guest.uid = await api.myUid();
    await api.watchRoom(roomId, (room) => { guest.room = room; renderGuest(); }, fail);
    await api.watchMembers(roomId, (members) => { guest.members = members; renderGuest(); }, fail);
  } catch (err) {
    fail(err);
  }

  $('#rv-body').addEventListener('submit', async (e) => {
    if (e.target.id !== 'rv-join-form') return;
    e.preventDefault();
    const name = $('#rv-name').value.trim().slice(0, 20);
    if (!name) return;
    if (guest.members.some((m) => m.name === name)) {
      toast('같은 이름이 이미 있어요. 성까지 쓰거나 다르게 적어주세요');
      return;
    }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api.joinRoom(roomId, name);
    } catch (err) {
      toast(errorMessage(err));
      btn.disabled = false;
    }
  });

  $('#rv-body').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const me = guest.members.find((m) => m.uid === guest.uid);
    try {
      if (act === 'reveal' && me) await revealMine(roomId, me.name);
      if (act === 'leave' && confirm('방에서 나갈까요?')) await api.removeMember(roomId);
      if (act === 'rename' && me) {
        const name = prompt('바꿀 이름을 입력해 주세요', me.name)?.trim().slice(0, 20);
        if (!name || name === me.name) return;
        if (guest.members.some((m) => m.name === name)) {
          toast('같은 이름이 이미 있어요');
          return;
        }
        await api.renameMember(roomId, name);
      }
    } catch (err) {
      toast(errorMessage(err));
    }
  });
}

/* ==========================================================================
   진입점
   ========================================================================== */
/** 초대 링크(?room=ID)로 열었으면 참가자 화면을 띄우고 true를 돌려준다 */
export function initRoomManitto(options) {
  deps = options;
  const roomId = new URLSearchParams(location.search).get('room');
  if (roomId && /^[a-z0-9]{6,20}$/.test(roomId)) {
    startGuest(roomId);
    return true;
  }
  return false;
}

/** 진행자 화면. 온라인 방 탭을 처음 열 때 Firebase를 불러온다. */
export const activateRoomAdmin = () => initAdmin();

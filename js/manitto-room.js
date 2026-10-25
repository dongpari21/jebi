// 마니또 온라인 방: 진행자가 방을 만들고 → 참가자가 초대 링크로 입장 → 진행자가 구성 완료하면
// 각 참가자는 자기 마니또만 확인할 수 있다.
import { shuffle } from './random.js?v=8';
import { burst } from './confetti.js?v=8';
import { $, escapeHtml, pageUrl, shareOrCopy, toast } from './utils.js?v=8';
import * as api from './room-api.js?v=8';

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

function memberChips(members, myUid, { removable = false, votes = null, room = null, canGrant = false } = {}) {
  const admins = room?.admins ?? [];
  return members.map((m, i) => {
    const voted = votes?.includes(m.uid);
    const state = votes ? (voted ? '공개 동의' : '동의 대기') : (m.uid === myUid ? '나' : `${i + 1}번째 입장`);
    const role = m.uid === room?.ownerUid ? '방장' : admins.includes(m.uid) ? '공동 방장' : '';
    const grant = canGrant && m.uid !== room?.ownerUid
      ? `<button class="btn btn-sm btn-ghost" type="button" data-admin="${m.uid}">${admins.includes(m.uid) ? '방장 해제' : '공동 방장'}</button>`
      : '';
    const remove = removable
      ? `<button class="btn btn-sm btn-icon btn-ghost" type="button" data-remove="${m.uid}" aria-label="${escapeHtml(m.name)} 내보내기" title="내보내기">✕</button>`
      : '';
    return `
    <article class="m-card${m.uid === myUid ? ' is-me' : ''}${voted ? ' is-checked' : ''}" style="--i:${i}">
      <span class="m-avatar" aria-hidden="true">${voted ? '✓' : escapeHtml([...m.name][0])}</span>
      <span class="m-info"><span class="m-name">${escapeHtml(m.name)}${m.uid === myUid && votes ? ' (나)' : ''}${role ? ` <span class="role-tag">${role}</span>` : ''}</span>
        <span class="m-state">${state}</span></span>
      ${grant || remove ? `<span class="m-actions">${grant}${remove}</span>` : ''}
    </article>`;
  }).join('');
}

/* ==========================================================================
   마니또 전체 공개 (전원 동의 시)
   ========================================================================== */
const revealed = new Map(); // roomId → 공개된 명단 | 'loading'

function revealInfo(room) {
  const total = room?.memberCount ?? 0;
  const votes = room?.revealVotes ?? [];
  // memberCount가 없는 예전 방은 공개 기능을 쓰지 않는다
  return { supported: room?.status === 'done' && total > 0, votes, total, all: total > 0 && votes.length >= total };
}

function ensureRevealed(roomId, info, rerender) {
  if (!info.all || revealed.has(roomId)) return;
  revealed.set(roomId, 'loading');
  api.getReveals(roomId)
    .then((list) => { revealed.set(roomId, list); rerender(); })
    .catch((err) => { console.error(err); revealed.delete(roomId); });
}

/** 공개된 명단을 원 순서(A → B → C …)대로 */
function chainHtml(list, members) {
  if (!Array.isArray(list)) return '<p class="hint">명단을 불러오는 중…</p>';
  const targetOf = new Map(list.map((r) => [r.name, r.target]));
  const order = [];
  let cur = members.find((m) => targetOf.has(m.name))?.name ?? list[0]?.name;
  while (cur != null && targetOf.has(cur) && !order.includes(cur)) {
    order.push(cur);
    cur = targetOf.get(cur);
  }
  for (const r of list) if (!order.includes(r.name)) order.push(r.name);
  return `<ol class="m-chain reveal-chain">${order.map((n, i) => `
    <li style="--i:${i}"><b>${escapeHtml(n)}</b><span class="arrow" aria-label="이(가) 챙긴 사람">→</span><span>${escapeHtml(targetOf.get(n))}</span></li>`).join('')}
  </ol>`;
}

function voteProgressHtml(info, members) {
  const voted = new Set(info.votes);
  const pct = Math.round((info.votes.length / info.total) * 100);
  return `<div class="vote-progress">
      <span class="vote-count"><b>${info.votes.length}</b> / ${info.total}명 동의</span>
      <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
    </div>
    <ul class="rv-chips vote-chips">${members.map((m) =>
      `<li class="${voted.has(m.uid) ? 'is-voted' : ''}">${voted.has(m.uid) ? '✓ ' : ''}${escapeHtml(m.name)}</li>`).join('')}</ul>`;
}

/** me.uid = 원래 참가자 uid (재접속 승인된 기기라면 내 uid와 다를 수 있다) */
async function castVote(roomId, me, agree) {
  if (agree) {
    const secret = await api.getMySecret(roomId, me.uid);
    if (!secret) throw new Error('no-secret');
    await api.voteReveal(roomId, true, { name: me.name, target: secret.target }, me.uid);
    toast('공개에 동의했어요. 모두 동의하면 명단이 열려요');
  } else {
    await api.voteReveal(roomId, false, {}, me.uid);
    toast('동의를 취소했어요');
  }
}

/** 전원 동의가 막 이뤄졌을 때 한 번 축하 */
function celebrateOnce(key, info) {
  const seen = celebrateOnce.seen ??= new Map();
  if (info.all && seen.get(key) === false) burst(innerWidth / 2, innerHeight / 3, 140);
  seen.set(key, info.all);
}

async function revealMine(roomId, name, title, actingUid) {
  try {
    const secret = await api.getMySecret(roomId, actingUid);
    if (!secret) {
      toast('내 마니또 정보를 찾지 못했어요. 진행자에게 문의해 주세요');
      return;
    }
    deps.openManittoDialog(name, secret.target, null, title ?? secret.title);
  } catch (err) {
    toast(errorMessage(err));
  }
}

/* ==========================================================================
   진행자 (온라인 방 탭)
   ========================================================================== */
const admin = {
  started: false,
  uid: null,
  rooms: null,        // 내가 만든 방 목록 (null = 불러오는 중)
  counts: new Map(),  // roomId → 입장 인원
  creating: false,    // 방이 있어도 '새 방' 폼을 보여주는 중
  roomId: null,       // 관리 중인 방
  room: null,
  members: [],
  rejoins: [],
  unsub: [],
  selectToken: 0,
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

function formatDate(ts) {
  const d = ts?.toDate?.();
  return d ? `${d.getMonth() + 1}월 ${d.getDate()}일` : '방금';
}

function renderRoomList() {
  const rooms = admin.rooms ?? [];
  $('#room-list-wrap').hidden = !rooms.length;
  $('#room-new').disabled = admin.creating;
  $('#room-list').innerHTML = rooms.map((r) => {
    const count = r.id === admin.roomId ? admin.members.length : admin.counts.get(r.id);
    const meta = [r.ownerUid !== admin.uid ? '공동 방장' : null, r.status === 'done' ? '구성 완료' : '입장 받는 중', count == null ? null : `${count}명`, formatDate(r.createdAt)]
      .filter(Boolean).join(' · ');
    const active = r.id === admin.roomId && !admin.creating;
    return `<li><button class="room-item${active ? ' is-active' : ''}" type="button" data-room="${r.id}" ${active ? 'aria-current="true"' : ''}>
      <span class="room-dot ${r.status === 'done' ? 'is-done' : ''}" aria-hidden="true"></span>
      <span class="room-item-text"><span class="room-item-name">${escapeHtml(roomName(r))}</span><span class="room-item-meta">${meta}</span></span>
    </button></li>`;
  }).join('');
}

function renderAdmin() {
  const { roomId, room, members, uid, busy, creating } = admin;
  const hasRooms = Boolean(admin.rooms?.length);
  const managing = Boolean(roomId && room) && !creating;
  renderRoomList();

  $('#room-create-form').hidden = managing || (admin.rooms === null && Boolean(roomId));
  $('#room-create-cancel').hidden = !hasRooms;
  $('#room-manage').hidden = !managing;
  $('#room-create-btn').disabled = busy || !api.isConfigured();

  const grid = $('#room-members');
  if (!managing) {
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
  const isOwner = room.ownerUid === uid;
  $('.room-label', $('#room-manage')).textContent = isOwner ? '관리 중인 방' : '관리 중인 방 · 공동 방장';
  $('#room-rename').disabled = busy;
  $('#room-delete').disabled = busy;
  $('#room-delete').hidden = !isOwner;
  $('#room-open-actions').hidden = !open;
  $('#room-done-actions').hidden = open;

  $('#room-self').hidden = !open;
  $('#room-self-form').hidden = Boolean(me);
  $('#room-self-joined').hidden = !me;
  $('#room-self-joined-name').textContent = me?.name ?? '';
  $('#room-my-manitto').hidden = open || !me;
  const info = revealInfo(room);
  const iVoted = info.votes.includes(uid);
  $('#room-my-vote').hidden = !info.supported || !me || info.all;
  $('#room-my-vote').textContent = iVoted ? '공개 동의 취소' : '나도 공개에 동의하기';
  $('#room-my-vote').disabled = busy;

  const canComplete = members.length >= MIN_MEMBERS && !dups.length && members.length <= MAX_MEMBERS;
  $('#room-complete').disabled = busy || !canComplete;
  $('#room-complete-hint').textContent = dups.length
    ? `같은 이름이 있어요: ${dups.join(', ')} — 한 명을 내보내거나 이름을 바꿔 달라고 해주세요.`
    : members.length < MIN_MEMBERS ? `${MIN_MEMBERS}명 이상 입장하면 구성을 완료할 수 있어요.` : '';
  $('#room-complete-hint').classList.toggle('is-error', dups.length > 0);

  $('#room-status').innerHTML = open
    ? `<span>입장 <b>${members.length}</b>명</span><span class="live-dot">실시간</span>`
    : `<span>참가 <b>${members.length}</b>명</span><span class="done">구성 완료 🎁 각자 자기 마니또만 볼 수 있어요</span>`;

  renderRejoinPanel();

  const panel = $('#room-reveal');
  panel.hidden = !info.supported;
  if (info.supported) {
    ensureRevealed(roomId, info, renderAdmin);
    celebrateOnce(`admin:${roomId}`, info);
    panel.innerHTML = info.all
      ? `<h3 class="reveal-title">🎉 전원 동의! 마니또 명단이 공개됐어요</h3>
         <p class="hint">왼쪽 사람이 오른쪽 사람을 몰래 챙겼어요.</p>${chainHtml(revealed.get(roomId), members)}`
      : `<h3 class="reveal-title">마니또 공개 투표</h3>
         <p class="hint">참가자 전원이 동의하면 이곳과 참가자 화면에 전체 명단이 공개돼요. 방장도 그 전에는 볼 수 없어요.</p>
         ${voteProgressHtml(info, members)}`;
  }

  grid.innerHTML = members.length
    ? memberChips(members, uid, { removable: open, votes: info.supported ? info.votes : null, room, canGrant: isOwner })
    : '<div class="empty"><span class="empty-emoji" aria-hidden="true">📨</span><p>아직 입장한 사람이 없어요.<br><b>초대 링크 보내기</b>로 링크를 공유해 보세요.</p></div>';
}

function renderRejoinPanel() {
  const box = $('#room-rejoins');
  const pending = admin.rejoins.filter((r) => !r.approved);
  const approved = admin.rejoins.filter((r) => r.approved);
  box.hidden = !admin.rejoins.length;
  if (box.hidden) return;
  box.innerHTML = `
    ${pending.length ? `<h3 class="reveal-title">🔄 재접속 요청 ${pending.length}건</h3>
      <p class="hint">기기·브라우저가 바뀌어 마니또가 안 보이는 참가자가 보낸 요청이에요. 승인하면 그 기기에서 해당 참가자의 마니또를 볼 수 있으니, <b>단톡방 등에서 본인이 맞는지 꼭 확인</b>하고 승인하세요.</p>
      <ul class="rejoin-list">${pending.map((r) => `
        <li><span class="rejoin-name"><b>${escapeHtml(r.name)}</b>님으로 재접속 요청</span>
          <span class="m-actions">
            <button class="btn btn-sm btn-primary" type="button" data-approve="${r.newUid}">승인</button>
            <button class="btn btn-sm btn-ghost" type="button" data-reject="${r.newUid}">거절</button>
          </span></li>`).join('')}</ul>` : ''}
    ${approved.length ? `<p class="hint">승인된 재접속: ${approved.map((r) => escapeHtml(r.name)).join(', ')}
      ${approved.map((r) => `<button class="link-btn" type="button" data-reject="${r.newUid}">${escapeHtml(r.name)} 승인 취소</button>`).join(' · ')}</p>` : ''}`;
}

function stopWatching() {
  admin.unsub.forEach((off) => off());
  admin.unsub = [];
}

/** 관리할 방을 바꾼다 (null이면 선택 해제) */
async function selectRoom(roomId) {
  if (roomId === admin.roomId && admin.unsub.length) {
    admin.creating = false;
    renderAdmin();
    return;
  }
  stopWatching();
  const token = ++admin.selectToken;
  Object.assign(admin, { roomId, room: null, members: [], rejoins: [], creating: false });
  saveAdminRoom(roomId);
  renderAdmin();
  if (!roomId) return;
  // 구독을 거는 사이에 다른 방이 선택되면 방금 건 구독은 바로 해제한다
  const keep = (off) => (token === admin.selectToken ? admin.unsub.push(off) : off());
  try {
    keep(await api.watchRoom(roomId, (room) => {
      if (admin.roomId !== roomId) return;
      if (!room || (room.ownerUid !== admin.uid && !room.admins?.includes(admin.uid))) {
        // 삭제됐거나 내 방이 아니면 다른 방으로
        const next = admin.rooms?.find((r) => r.id !== roomId)?.id ?? null;
        selectRoom(next);
        return;
      }
      admin.room = room;
      renderAdmin();
    }, (err) => adminError(errorMessage(err))));
    keep(await api.watchMembers(roomId, (members) => {
      if (admin.roomId !== roomId) return;
      admin.members = members;
      renderAdmin();
    }, (err) => adminError(errorMessage(err))));
    keep(await api.watchRejoins(roomId, (rejoins) => {
      if (admin.roomId !== roomId) return;
      admin.rejoins = rejoins;
      renderAdmin();
    }, (err) => console.warn('rejoins unavailable', err)));
  } catch (err) {
    adminError(errorMessage(err));
  }
}

/** 목록에 있는 다른 방들의 인원 수를 채운다 */
function refreshCounts(rooms) {
  for (const r of rooms) {
    if (r.id === admin.roomId) continue;
    api.countMembers(r.id).then((n) => {
      admin.counts.set(r.id, n);
      renderRoomList();
    }).catch(() => {});
  }
}

async function watchRoomList() {
  try {
    admin.listOff?.();
    admin.listOff = await api.watchMyRooms((rooms) => {
      admin.rooms = rooms;
      refreshCounts(rooms);
      // 선택된 방이 없거나 사라졌으면 가장 최근 방을 고른다
      if (!admin.creating && (!admin.roomId || !rooms.some((r) => r.id === admin.roomId))) {
        selectRoom(rooms[0]?.id ?? null);
      } else {
        renderAdmin();
      }
    }, (err) => {
      // 규칙이 아직 목록 조회를 허용하지 않으면, 저장된 방 하나만 관리한다
      console.warn('room list unavailable', err);
      admin.rooms = [];
      renderAdmin();
    });
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

function renameRoom() {
  const current = admin.room?.title ?? '';
  const title = prompt('새 방 이름을 입력해 주세요 (30자 이내)', current)?.trim().slice(0, 30);
  if (title == null || title === current) return;
  withBusy(async () => {
    await api.renameRoom(admin.roomId, title);
    toast('방 이름을 바꿨어요');
  });
}

function deleteRoom() {
  const { roomId, room, members } = admin;
  const warn = room.status === 'done'
    ? '참가자 명단과 마니또 결과가 모두 지워져서, 참가자들도 더 이상 결과를 볼 수 없어요.'
    : '참가자 명단이 지워지고, 초대 링크로 더 이상 들어올 수 없어요.';
  if (!confirm(`'${roomName(room)}' 방을 삭제할까요? (${members.length}명 참가)\n${warn}\n삭제하면 되돌릴 수 없어요.`)) return;
  withBusy(async () => {
    stopWatching();
    await api.deleteRoom(roomId);
    const next = admin.rooms?.find((r) => r.id !== roomId)?.id ?? null;
    admin.roomId = null;
    await selectRoom(next);
    toast('방을 삭제했어요');
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
      $('#room-title').value = '';
      await selectRoom(roomId);
      toast('방을 만들었어요. 초대 링크를 보내주세요');
    });
  });
  $('#room-create-cancel').addEventListener('click', () => {
    admin.creating = false;
    selectRoom(admin.roomId ?? admin.rooms?.[0]?.id ?? null);
  });
  $('#room-new').addEventListener('click', () => {
    admin.creating = true;
    renderAdmin();
    $('#room-title').focus();
  });
  $('#room-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-room]')?.dataset.room;
    if (id) selectRoom(id);
  });
  $('#room-rename').addEventListener('click', renameRoom);
  $('#room-delete').addEventListener('click', deleteRoom);
  $('#room-invite').addEventListener('click', sendInvite);
  $('#room-complete').addEventListener('click', completeRoom);
  $('#room-self-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#room-self-name').value.trim().slice(0, 20);
    if (!name) return;
    withBusy(() => api.joinRoom(admin.roomId, name));
  });
  $('#room-self-leave').addEventListener('click', () => withBusy(() => api.removeMember(admin.roomId)));
  $('#room-my-vote').addEventListener('click', () => {
    const me = admin.members.find((m) => m.uid === admin.uid);
    if (me) withBusy(() => castVote(admin.roomId, me, !revealInfo(admin.room).votes.includes(admin.uid)));
  });
  $('#room-my-manitto').addEventListener('click', () => {
    const me = admin.members.find((m) => m.uid === admin.uid);
    if (me) revealMine(admin.roomId, me.name, roomName(admin.room), me.uid);
  });
  $('#room-rejoins').addEventListener('click', (e) => {
    const approveId = e.target.closest('[data-approve]')?.dataset.approve;
    const rejectId = e.target.closest('[data-reject]')?.dataset.reject;
    const req = admin.rejoins.find((r) => r.newUid === (approveId ?? rejectId));
    if (!req) return;
    if (approveId && confirm(`${req.name}님의 재접속을 승인할까요?\n승인하면 그 기기에서 ${req.name}님의 마니또를 볼 수 있어요. 본인이 맞는지 꼭 확인하세요.`)) {
      withBusy(async () => { await api.approveRejoin(admin.roomId, approveId); toast(`${req.name}님 재접속을 승인했어요`); });
    }
    if (rejectId && confirm(req.approved ? `${req.name}님 재접속 승인을 취소할까요?` : `${req.name}님의 재접속 요청을 거절할까요?`)) {
      withBusy(() => api.rejectRejoin(admin.roomId, rejectId));
    }
  });
  $('#room-members').addEventListener('click', (e) => {
    const adminUid = e.target.closest('[data-admin]')?.dataset.admin;
    if (adminUid) {
      const member = admin.members.find((m) => m.uid === adminUid);
      const on = !(admin.room.admins ?? []).includes(adminUid);
      if (member && confirm(on
        ? `${member.name}님을 이 방의 공동 방장으로 지정할까요?\n재접속 승인, 내보내기, 구성 완료, 이름 바꾸기를 할 수 있게 돼요. (방 삭제는 불가)\n${member.name}님은 입장할 때 쓴 기기에서 사이트 첫 화면의 '온라인 방' 탭을 열면 관리할 수 있어요.`
        : `${member.name}님의 공동 방장 권한을 해제할까요?`)) {
        withBusy(async () => {
          await api.setAdmin(admin.roomId, adminUid, on);
          toast(on ? `${member.name}님을 공동 방장으로 지정했어요` : `${member.name}님의 공동 방장을 해제했어요`);
        });
      }
      return;
    }
    const uid = e.target.closest('[data-remove]')?.dataset.remove;
    const member = admin.members.find((m) => m.uid === uid);
    if (member && confirm(`${member.name}님을 방에서 내보낼까요?`)) {
      withBusy(() => api.removeMember(admin.roomId, uid));
    }
  });

  renderAdmin();
  api.myUid().then((uid) => {
    admin.uid = uid;
    // 참가자 화면의 '방장 화면으로 가기'(?manage=ID)로 왔으면 그 방을 연다
    const wanted = new URLSearchParams(location.search).get('manage');
    const saved = (wanted && /^[a-z0-9]{6,20}$/.test(wanted) ? wanted : null) ?? loadAdminRoom();
    if (saved) selectRoom(saved);
    watchRoomList();
  }).catch((err) => adminError(errorMessage(err)));
}

/* ==========================================================================
   참가자 (초대 링크 ?room=ID 로 열었을 때)
   ========================================================================== */
const guest = { roomId: null, room: undefined, members: [], uid: null, rejoin: null };

/** 이 기기가 행동하는 참가자 uid: 재접속이 승인됐으면 원래 참가자, 아니면 내 uid */
const actingUid = () => (guest.rejoin?.approved ? guest.rejoin.memberUid : guest.uid);

function rejoinPickerHtml(members) {
  return `<div class="rejoin-box">
      <h2 class="reveal-title">입장했었는데 내 화면이 안 보이나요?</h2>
      <p class="hint">기기나 브라우저가 바뀌면 이렇게 보일 수 있어요. 먼저 <b>처음 입장할 때 쓴 앱</b>(카카오톡·사파리·크롬)으로 열어보고, 그래도 안 되면 내 이름을 골라 방장에게 재접속을 요청하세요.</p>
      <ul class="rv-chips rejoin-names">${members.map((m) =>
        `<li><button type="button" data-rejoin="${m.uid}">${escapeHtml(m.name)}</button></li>`).join('')}</ul>
    </div>`;
}

function renderGuest() {
  const { room, members } = guest;
  const uid = actingUid();
  const body = $('#rv-body');
  const me = members.find((m) => m.uid === uid);
  const isAlias = Boolean(me) && uid !== guest.uid;

  $('#rv-title').textContent = room ? roomName(room) : '마니또 방';
  const manages = Boolean(room) && (room.ownerUid === guest.uid || room.admins?.includes(guest.uid));
  $('#rv-manage').hidden = !manages;
  $('#rv-manage').href = `./?manage=${guest.roomId}`;
  $('#rv-members-wrap').hidden = !room;
  $('#rv-count').textContent = `${members.length}명`;
  $('#rv-members').innerHTML = members.map((m) =>
    `<li class="${m.uid === uid ? 'is-me' : ''}">${escapeHtml(m.name)}${m.uid === uid ? ' (나)' : ''}</li>`).join('');

  if (room === undefined) {
    body.innerHTML = '<p class="rv-text">방 정보를 불러오는 중…</p>';
  } else if (room === null) {
    body.innerHTML = '<p class="rv-text">방을 찾을 수 없어요.<br>진행자가 방을 삭제했거나 링크가 잘못됐어요.</p>';
  } else if (!me && guest.rejoin && !guest.rejoin.approved) {
    body.innerHTML = `
      <div class="rv-state"><span class="rv-check is-wait" aria-hidden="true">…</span>
        <p><b>${escapeHtml(guest.rejoin.name)}</b>님으로 재접속 요청 중</p></div>
      <p class="rv-text">방장이 승인하면 이 화면에서 바로 마니또를 확인할 수 있어요.<br>방장에게 <b>"재접속 요청했어요"</b>라고 알려주세요.</p>
      <div class="rv-waiting" aria-hidden="true"><span></span><span></span><span></span></div>
      <button class="btn btn-ghost btn-block" type="button" data-act="cancel-rejoin">요청 취소</button>`;
  } else if (room.status === 'open' && !me) {
    if (!$('#rv-join-form')) {
      body.innerHTML = `
        <p class="rv-text">이름을 입력하고 입장하세요.<br>진행자가 방 구성을 마치면 여기서 내 마니또를 확인할 수 있어요.</p>
        <form class="join-form" id="rv-join-form">
          <label class="sr-only" for="rv-name">이름</label>
          <input id="rv-name" type="text" maxlength="20" placeholder="이름" autocomplete="name" required>
          <button class="btn btn-primary btn-xl" type="submit">입장하기</button>
        </form>
        <details class="rejoin-details" id="rv-rejoin-details"><summary>이미 입장했는데 다시 들어왔나요?</summary>${rejoinPickerHtml(members)}</details>`;
    } else if (!$('#rv-rejoin-details')?.open) {
      $('#rv-rejoin-details').innerHTML = `<summary>이미 입장했는데 다시 들어왔나요?</summary>${rejoinPickerHtml(members)}`;
    }
  } else if (room.status === 'open') {
    body.innerHTML = `
      <div class="rv-state"><span class="rv-check" aria-hidden="true">✓</span>
        <p><b>${escapeHtml(me.name)}</b>님, 입장 완료!</p></div>
      <p class="rv-text">진행자가 방 구성을 마치면 이 화면에서 바로 확인할 수 있어요.<br>이 창을 닫았다면 <b>같은 기기·브라우저</b>로 초대 링크를 다시 열어주세요.</p>
      <div class="rv-waiting" aria-hidden="true"><span></span><span></span><span></span></div>
      ${isAlias ? '<p class="hint">방장 승인으로 이 기기에서 재접속했어요.</p>' : `<div class="m-row">
        <button class="btn btn-ghost" type="button" data-act="rename">이름 바꾸기</button>
        <button class="btn btn-ghost" type="button" data-act="leave">나가기</button>
      </div>`}`;
  } else if (me) {
    const info = revealInfo(room);
    const iVoted = info.votes.includes(uid);
    let revealBox = '';
    if (info.supported) {
      ensureRevealed(guest.roomId, info, renderGuest);
      celebrateOnce(`guest:${guest.roomId}`, info);
      revealBox = info.all
        ? `<section class="reveal-box is-open">
            <h2 class="reveal-title">🎉 전원 동의! 마니또 공개</h2>
            <p class="hint">왼쪽 사람이 오른쪽 사람을 몰래 챙겼어요.</p>
            ${chainHtml(revealed.get(guest.roomId), members)}
          </section>`
        : `<section class="reveal-box">
            <h2 class="reveal-title">마니또 공개 투표</h2>
            <p class="hint">모두 동의하면 누가 누구를 챙겼는지 전체 명단이 공개돼요.<br>한 명이라도 동의하지 않으면 공개되지 않아요.</p>
            ${voteProgressHtml(info, members)}
            <button class="btn ${iVoted ? 'btn-ghost' : 'btn-dark'} btn-block" type="button" data-act="${iVoted ? 'unvote' : 'vote'}">${iVoted ? '동의 취소' : '공개에 동의하기'}</button>
          </section>`;
    }
    body.innerHTML = `
      <p class="rv-text"><b>${escapeHtml(me.name)}</b>님, 방 구성이 끝났어요!<br>주변에 보는 사람이 없을 때 눌러주세요 🤫</p>
      <button class="btn btn-primary btn-xl" type="button" data-act="reveal">내 마니또 확인하기</button>
      ${revealBox}
      ${isAlias ? '<p class="hint">방장 승인으로 이 기기에서 재접속했어요.</p>' : ''}`;
  } else {
    body.innerHTML = `<p class="rv-text">이미 구성이 끝난 방이에요.</p>${rejoinPickerHtml(members)}`;
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
    await api.watchMyRejoin(roomId, (rejoin) => { guest.rejoin = rejoin; renderGuest(); },
      (err) => console.warn('rejoin unavailable', err));
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
    const me = guest.members.find((m) => m.uid === actingUid());
    const rejoinUid = e.target.closest('[data-rejoin]')?.dataset.rejoin;
    try {
      if (rejoinUid) {
        const target = guest.members.find((m) => m.uid === rejoinUid);
        if (target && confirm(`${target.name}님으로 재접속을 요청할까요?\n방장이 본인인지 확인한 뒤 승인하면 이 기기에서 마니또를 확인할 수 있어요.`)) {
          await api.requestRejoin(roomId, target.uid, target.name);
          toast('재접속을 요청했어요. 방장에게 알려주세요');
        }
        return;
      }
      if (act === 'cancel-rejoin') await api.cancelRejoin(roomId);
      if (act === 'reveal' && me) await revealMine(roomId, me.name, roomName(guest.room), me.uid);
      if (act === 'leave' && confirm('방에서 나갈까요?')) await api.removeMember(roomId);
      if ((act === 'vote' || act === 'unvote') && me) {
        e.target.closest('button').disabled = true;
        await castVote(roomId, me, act === 'vote');
      }
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

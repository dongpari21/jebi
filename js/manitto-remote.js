// 비대면 마니또: 참가 등록 → 코드 수집 → 암호화된 개인 결과 링크 전송
import { shuffle } from './random.js?v=4';
import {
  $, $$, escapeHtml, readHash, clearHash, pageUrl, shareOrCopy, toast,
} from './utils.js?v=4';
import {
  SecretError, isSupported, newRoomId, makeJoinToken, parseJoinToken,
  register, keysForRoom, extractCodes, sealResult, openResult,
} from './secret.js?v=4';

const REMOTE_KEY = 'jebi:remote';
const MAX_MEMBERS = 50;

/** @type {{ roomId: string, title: string, members: {name: string, key: string}[], links: {name: string, url: string, sent: boolean}[] | null }} */
let remote = loadRemote();
let busy = false;
let deps;

function loadRemote() {
  try {
    const r = JSON.parse(localStorage.getItem(REMOTE_KEY) || 'null');
    if (r?.roomId && Array.isArray(r.members)) return { title: '', links: null, ...r };
  } catch {}
  return { roomId: newRoomId(), title: '', members: [], links: null };
}

function saveRemote() {
  try { localStorage.setItem(REMOTE_KEY, JSON.stringify(remote)); } catch {}
}

const eventName = (title) => title.trim() || '마니또';

const SEND_RESULT = { shared: '공유했어요', copied: '복사했어요', failed: '복사에 실패했어요' };

/* ==========================================================================
   진행자 화면
   ========================================================================== */
function renderRemote() {
  const { members, links } = remote;
  const dupNames = new Set(members.map((m) => m.name).filter((n, i, a) => a.indexOf(n) !== i));
  const sent = links?.filter((l) => l.sent).length ?? 0;

  $('#remote-status').innerHTML = links
    ? `<span>결과 링크 보냄 <b>${sent}</b> / ${links.length}</span>${sent === links.length ? '<span class="done">모두 보냈어요 🎁</span>' : ''}`
    : `<span>등록 <b>${members.length}</b>명</span>${members.length < 3 ? '<span>3명 이상이면 마니또를 정할 수 있어요</span>' : ''}`;
  $('#remote-progress').style.width = links ? `${(sent / links.length) * 100}%` : '0';

  $('#remote-make').disabled = busy || members.length < 3 || dupNames.size > 0;
  $('#remote-make').textContent = links ? '마니또 다시 정하기' : '마니또 정하고 결과 링크 만들기';
  $('#remote-dup-hint').hidden = dupNames.size === 0;
  $('#remote-dup-hint').textContent = `같은 이름이 있어요: ${[...dupNames].join(', ')} — 하나를 지워 주세요.`;
  $('#remote-reset').disabled = busy;

  const grid = $('#remote-grid');
  if (!members.length) {
    grid.innerHTML = `<div class="empty"><span class="empty-emoji" aria-hidden="true">📨</span>
      <p>왼쪽 <b>1단계</b>에서 등록 링크를 보내고,<br>받은 코드를 <b>2단계</b>에 붙여넣으세요.</p></div>`;
    return;
  }

  grid.innerHTML = members.map((m, i) => {
    const link = links?.find((l) => l.name === m.name);
    const n = escapeHtml(m.name);
    const state = link ? (link.sent ? '보냄' : '보내기 전') : (dupNames.has(m.name) ? '이름 중복' : '등록됨');
    const action = link
      ? `<button class="btn btn-sm ${link.sent ? 'btn-ghost' : 'btn-primary'}" type="button" data-act="send" data-i="${i}">${link.sent ? '다시 보내기' : '결과 링크 보내기'}</button>`
      : `<button class="btn btn-sm btn-icon btn-ghost" type="button" data-act="remove" data-i="${i}" title="삭제" aria-label="${n} 삭제">✕</button>`;
    return `<article class="m-card${link?.sent ? ' is-checked' : ''}${dupNames.has(m.name) ? ' is-warn' : ''}" style="--i:${i}">
      <span class="m-avatar" aria-hidden="true">${link?.sent ? '✓' : escapeHtml([...m.name][0])}</span>
      <span class="m-info"><span class="m-name">${n}</span><span class="m-state">${state}</span></span>
      <span class="m-actions">${action}</span>
    </article>`;
  }).join('');
}

/** 결과를 이미 만든 뒤 참가자가 바뀌면 링크를 버려야 하므로 확인을 받는다 */
function confirmDropLinks() {
  if (!remote.links) return true;
  const anySent = remote.links.some((l) => l.sent);
  const ok = confirm(anySent
    ? '참가자가 바뀌면 마니또를 다시 정해야 해요.\n이미 보낸 결과 링크는 예전 결과를 보여주니, 다시 정한 뒤 모두에게 새 링크를 보내야 해요. 계속할까요?'
    : '참가자가 바뀌면 마니또를 다시 정해야 해요. 계속할까요?');
  if (ok) remote.links = null;
  return ok;
}

function addCodes(text) {
  const codes = extractCodes(text);
  if (!codes.length) return false;
  const mine = codes.filter((c) => c.roomId === remote.roomId);
  const fresh = mine.filter((c) => !remote.members.some((m) => m.key === c.key));
  const otherRoom = codes.length - mine.length;

  if (fresh.length && !confirmDropLinks()) return true;
  const room = MAX_MEMBERS - remote.members.length;
  remote.members.push(...fresh.slice(0, room).map(({ name, key }) => ({ name, key })));
  saveRemote();
  renderRemote();

  const msgs = [];
  if (fresh.length) msgs.push(`${fresh.slice(0, room).map((c) => c.name).join(', ')} 등록`);
  else if (mine.length) msgs.push('이미 등록된 코드예요');
  if (otherRoom) msgs.push(`다른 마니또의 코드 ${otherRoom}개는 제외`);
  if (fresh.length > room) msgs.push(`최대 ${MAX_MEMBERS}명까지만 등록돼요`);
  toast(msgs.join(' · '));
  return true;
}

async function makeLinks() {
  const { members, roomId, title } = remote;
  if (members.length < 3 || busy) return;
  if (remote.links?.some((l) => l.sent)
    && !confirm('이미 보낸 결과 링크는 예전 결과를 보여줘요. 다시 정하면 모두에게 새 링크를 보내야 해요. 계속할까요?')) return;

  busy = true;
  renderRemote();
  try {
    // 섞은 순서대로 원형 배정 (자기 자신·서로 챙기기 없음). 배정 결과는 이 함수 밖으로 나가지 않는다.
    const order = shuffle(members);
    const name = eventName(title);
    remote.links = await Promise.all(members.map(async (m) => {
      const target = order[(order.indexOf(m) + 1) % order.length];
      const token = await sealResult(roomId, m.key, { g: m.name, t: target.name, title: name });
      return { name: m.name, url: `${pageUrl()}#r=${token}`, sent: false };
    }));
    saveRemote();
    toast('결과 링크를 만들었어요. 한 명씩 보내주세요');
  } catch (err) {
    console.error(err);
    toast('결과 링크를 만들지 못했어요');
  } finally {
    busy = false;
    renderRemote();
  }
}

async function sendJoinLink() {
  remote.title = $('#remote-title').value.trim();
  saveRemote();
  const url = `${pageUrl()}#join=${makeJoinToken(remote.roomId, remote.title)}`;
  const text = `🎁 ${eventName(remote.title)} 참가 등록 링크예요.\n링크를 열어 이름을 등록하고, 나오는 등록 코드를 저에게 보내주세요.\n${url}`;
  const r = await shareOrCopy(text);
  if (r !== 'cancelled') toast(r === 'copied' ? '등록 링크를 복사했어요. 참가자들에게 보내주세요' : SEND_RESULT[r]);
}

async function sendResultLink(i) {
  const member = remote.members[i];
  const link = remote.links?.find((l) => l.name === member?.name);
  if (!link) return;
  const text = `🎁 ${member.name}님의 ${eventName(remote.title)} 결과 링크예요.\n등록할 때 사용한 기기·브라우저에서 열어주세요. 다른 사람은 열 수 없어요.\n${link.url}`;
  const r = await shareOrCopy(text);
  if (r === 'cancelled' || r === 'failed') {
    if (r === 'failed') toast(SEND_RESULT.failed);
    return;
  }
  link.sent = true;
  saveRemote();
  renderRemote();
  toast(`${member.name}님 결과 링크를 ${SEND_RESULT[r]}`);
}

function resetRoom() {
  if (remote.members.length && !confirm('등록된 참가자와 결과 링크를 모두 지우고 새로 시작할까요?\n이전 등록 링크와 코드는 더 이상 쓸 수 없어요.')) return;
  remote = { roomId: newRoomId(), title: '', members: [], links: null };
  $('#remote-title').value = '';
  saveRemote();
  renderRemote();
  toast('새 마니또를 시작했어요');
}

function initOrganizer() {
  $('#remote-title').value = remote.title;
  $('#remote-title').addEventListener('input', (e) => {
    remote.title = e.target.value;
    saveRemote();
  });
  $('#remote-join-copy').addEventListener('click', sendJoinLink);
  $('#remote-make').addEventListener('click', makeLinks);
  $('#remote-reset').addEventListener('click', resetRoom);

  const codes = $('#remote-codes');
  const hint = $('#remote-codes-hint');
  codes.addEventListener('input', () => {
    if (!codes.value.trim()) {
      hint.textContent = '';
      return;
    }
    if (addCodes(codes.value)) {
      codes.value = '';
      hint.textContent = '';
    } else {
      hint.textContent = '등록 코드(JEBI1-…)를 찾지 못했어요. 코드 전체가 복사됐는지 확인해 주세요.';
    }
  });

  $('#remote-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (btn.dataset.act === 'send') sendResultLink(i);
    if (btn.dataset.act === 'remove' && confirmDropLinks()) {
      remote.members.splice(i, 1);
      saveRemote();
      renderRemote();
    }
  });

  if (!isSupported()) {
    $('#remote-unsupported').hidden = false;
    $('#remote-join-copy').disabled = true;
  }
  renderRemote();
}

/* ==========================================================================
   참가자 화면 (#join= / #r= 링크로 열었을 때)
   ========================================================================== */
function notice(emoji, title, message) {
  const dialog = $('#notice-dialog');
  $('.n-emoji', dialog).textContent = emoji;
  $('.n-title', dialog).textContent = title;
  $('.n-message', dialog).innerHTML = message;
  dialog.showModal();
}

function showJoinStep(step) {
  for (const el of $$('#join-dialog [data-step]')) el.hidden = el.dataset.step !== step;
}

function showCode(name, code) {
  const dialog = $('#join-dialog');
  $('.j-name', dialog).textContent = name;
  $('.j-code', dialog).textContent = code;
  showJoinStep('code');
}

async function openJoin(token) {
  let room;
  try { room = parseJoinToken(token); } catch {
    notice('⚠️', '링크가 올바르지 않아요', '진행자에게 등록 링크를 다시 받아주세요.');
    return;
  }
  if (!isSupported()) {
    notice('⚠️', '이 브라우저에서는 등록할 수 없어요', '사생활 보호(시크릿) 모드라면 일반 모드로 열어주세요.');
    return;
  }

  const dialog = $('#join-dialog');
  dialog.dataset.roomId = room.roomId;
  for (const el of $$('.j-title', dialog)) el.textContent = eventName(room.title);
  $('#join-name').value = '';

  const existing = await keysForRoom(room.roomId).catch(() => []);
  if (existing.length) showCode(existing[0].name, existing[0].code);
  else showJoinStep('form');
  dialog.showModal();
}

async function submitJoin(e) {
  e.preventDefault();
  const dialog = $('#join-dialog');
  const name = $('#join-name').value.trim().slice(0, 20);
  if (!name) return;
  const btn = $('#join-form button[type="submit"]');
  btn.disabled = true;
  try {
    const code = await register(dialog.dataset.roomId, name);
    showCode(name, code);
  } catch (err) {
    console.error(err);
    toast(err instanceof SecretError && err.code === 'unsupported'
      ? '이 브라우저에서는 등록할 수 없어요'
      : '등록하지 못했어요. 시크릿 모드라면 일반 모드로 열어주세요');
  } finally {
    btn.disabled = false;
  }
}

async function openResultLink(token) {
  try {
    const { g, t, title } = await openResult(token);
    deps.setTab('manitto');
    deps.openManittoDialog(g, t, null, title);
  } catch (err) {
    const code = err instanceof SecretError ? err.code : 'invalid';
    if (code === 'no-key' || code === 'wrong-key') {
      notice('🔒', '이 기기에서는 열 수 없어요',
        '이 결과 링크는 <b>참가 등록을 한 기기·브라우저</b>에서만 열려요.<br>'
        + '카카오톡에서 등록했다면 카카오톡에서, 크롬에서 등록했다면 크롬에서 열어주세요.<br>'
        + '본인 링크가 맞는데도 안 열리면 진행자에게 다시 등록하겠다고 알려주세요.');
    } else if (code === 'unsupported') {
      notice('⚠️', '이 브라우저에서는 열 수 없어요', '등록할 때 사용한 브라우저로 열어주세요.');
    } else {
      notice('⚠️', '링크가 올바르지 않아요', '링크가 잘리지 않았는지 확인하고, 진행자에게 다시 받아주세요.');
    }
  }
}

function initParticipant() {
  const dialog = $('#join-dialog');
  $('#join-form').addEventListener('submit', submitJoin);
  dialog.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') dialog.close();
    if (act === 'rejoin') {
      $('#join-name').value = '';
      showJoinStep('form');
      $('#join-name').focus();
    }
    if (act === 'send') {
      const name = $('.j-name', dialog).textContent;
      const code = $('.j-code', dialog).textContent;
      const r = await shareOrCopy(`[마니또 등록] ${name}\n${code}`);
      if (r !== 'cancelled') toast(r === 'copied' ? '등록 코드를 복사했어요. 진행자에게 보내주세요' : SEND_RESULT[r]);
    }
  });
  $('#notice-dialog').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="close"]')) $('#notice-dialog').close();
  });

  const join = readHash('join');
  const result = readHash('r');
  if (join || result) clearHash();
  if (join) openJoin(join);
  if (result) openResultLink(result);
}

export function initRemoteManitto(options) {
  deps = options;
  initOrganizer();
  initParticipant();
}

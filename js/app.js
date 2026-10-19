import { randomInt, shuffle, sample, pick } from './random.js';
import { burst } from './confetti.js';

/* ==========================================================================
   State
   ========================================================================== */
const STORAGE_KEY = 'jebi:v1';
const THEME_KEY = 'jebi:theme';
const MAX_SLIPS = 60;
const LOSE_WORDS = ['꽝', '꽝!', '다음 기회에', '없음', '패스'];

const DEFAULTS = {
  tab: 'board',
  board: {
    mode: 'win',
    total: 12,
    winners: 2,
    winText: '당첨',
    loseText: '꽝',
    items: '커피 쏘기\n점심 메뉴 결정권\n오늘 칼퇴권\n꽝*5',
  },
  people: '김민준\n이서연\n박도윤\n최하은\n정시우\n강지아\n윤예준\n임수아',
  names: { count: 1, exclude: true },
  teams: { count: 2 },
};

const state = loadState();

// 화면에만 존재하는 런타임 상태 (저장하지 않음)
let slips = [];
let boardLog = [];
let drawn = [];
let drawHistory = [];
let lastTeams = null;
let drawing = false;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function loadState() {
  const merged = structuredClone(DEFAULTS);
  const fromHash = readShareHash();
  let saved = fromHash;
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
  }
  if (saved && typeof saved === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in saved)) continue;
      if (typeof DEFAULTS[key] === 'object') Object.assign(merged[key], saved[key]);
      else merged[key] = saved[key];
    }
  }
  if (fromHash) window.history.replaceState(null, '', location.pathname + location.search);
  return merged;
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }, 200);
}

const getPath = (path) => path.split('.').reduce((o, k) => o?.[k], state);
function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], state)[last] = value;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ==========================================================================
   Share link (#s=base64url(JSON))
   ========================================================================== */
function encodeShare(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readShareHash() {
  const m = location.hash.match(/^#s=([\w-]+)$/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* ==========================================================================
   Toast
   ========================================================================== */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

/* ==========================================================================
   Tabs
   ========================================================================== */
function setTab(tab, focus = false) {
  state.tab = tab;
  for (const btn of $$('.tab')) {
    const on = btn.dataset.tab === tab;
    btn.setAttribute('aria-selected', on);
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus();
  }
  for (const panel of $$('.panel')) panel.hidden = panel.id !== `panel-${tab}`;
  moveIndicator();
  save();
}

function moveIndicator() {
  const active = $('.tab[aria-selected="true"]');
  const ind = $('.tab-indicator');
  if (!active) return;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
}

function initTabs() {
  const tabs = $$('.tab');
  tabs.forEach((btn, i) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      setTab(tabs[(i + dir + tabs.length) % tabs.length].dataset.tab, true);
    });
  });
  addEventListener('resize', moveIndicator);
  document.fonts?.ready.then(moveIndicator);
  setTab(state.tab in { board: 1, names: 1, teams: 1 } ? state.tab : 'board');
}

/* ==========================================================================
   Generic form bindings (data-bind="board.total" 등)
   ========================================================================== */
const onChange = {
  board: () => scheduleBoardRebuild(),
  names: () => renderPool(),
  teams: () => {},
};

function writeField(el) {
  const v = getPath(el.dataset.bind);
  if (el.type === 'checkbox') el.checked = !!v;
  else if (el.type === 'radio') el.checked = el.value === v;
  else el.value = v;
}

function normalizeNumbers() {
  const b = state.board;
  b.total = clamp(Math.round(+b.total || 2), 2, MAX_SLIPS);
  b.winners = clamp(Math.round(+b.winners || 1), 1, b.total);
  state.names.count = clamp(Math.round(+state.names.count || 1), 1, 50);
  state.teams.count = clamp(Math.round(+state.teams.count || 2), 2, 12);
}

function initBindings() {
  for (const el of $$('[data-bind]')) {
    writeField(el);
    const evt = el.type === 'number' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (el.type === 'radio' && !el.checked) return;
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number') value = Number(value);
      setPath(el.dataset.bind, value);
      if (el.type === 'number') {
        normalizeNumbers();
        $$('[data-bind]').filter((x) => x.type === 'number').forEach(writeField);
      }
      updateConditional();
      onChange[el.dataset.bind.split('.')[0]]?.();
      save();
    });
  }

  for (const btn of $$('.stepper button')) {
    btn.addEventListener('click', () => {
      const input = $('input', btn.parentElement);
      input.value = Number(input.value) + Number(btn.dataset.step);
      input.dispatchEvent(new Event('change'));
    });
  }

  // 참가자 목록은 이름 뽑기/팀 나누기가 공유
  for (const ta of $$('.people-input')) {
    ta.value = state.people;
    ta.addEventListener('input', () => {
      state.people = ta.value;
      for (const other of $$('.people-input')) if (other !== ta) other.value = ta.value;
      drawn = drawn.filter((n) => parsePeople().includes(n));
      renderPeopleCount();
      renderPool();
      save();
    });
  }

  updateConditional();
}

function updateConditional() {
  for (const el of $$('[data-show-if]')) {
    const [path, expected] = el.dataset.showIf.split('=');
    el.hidden = String(getPath(path)) !== expected;
  }
}

/* ==========================================================================
   뽑기판
   ========================================================================== */
function parseItems(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\s*[*×]\s*(\d{1,3})$/);
    const label = (m ? m[1] : line).trim().slice(0, 20);
    const n = m ? Number(m[2]) : 1;
    if (!label) continue;
    for (let i = 0; i < n && out.length < MAX_SLIPS; i++) {
      out.push({ text: label, win: !LOSE_WORDS.includes(label) });
    }
  }
  return out;
}

function boardItems() {
  const b = state.board;
  if (b.mode === 'custom') return parseItems(b.items);
  const winText = b.winText.trim() || '당첨';
  const loseText = b.loseText.trim() || '꽝';
  return [
    ...Array.from({ length: b.winners }, () => ({ text: winText, win: true })),
    ...Array.from({ length: b.total - b.winners }, () => ({ text: loseText, win: false })),
  ];
}

let rebuildTimer;
function scheduleBoardRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildBoard, 250);
}

function buildBoard() {
  const items = boardItems();
  const hint = $('#board-items-hint');
  if (state.board.mode === 'custom') {
    const wins = items.filter((i) => i.win).length;
    hint.classList.toggle('is-error', items.length < 2);
    hint.textContent = items.length < 2
      ? '제비를 2개 이상 입력해 주세요.'
      : `총 ${items.length}장 · 당첨 ${wins}장 · 꽝 ${items.length - wins}장`;
  }
  slips = shuffle(items).map((it) => ({ ...it, open: false }));
  boardLog = [];
  renderBoard();
}

function renderBoard() {
  const grid = $('#slip-grid');
  grid.innerHTML = slips.map((_, i) => {
    const tilt = randomInt(7) - 3;
    return `<button class="slip" type="button" data-i="${i}" style="--i:${i};--tilt:${tilt}deg" aria-label="${i + 1}번 제비 펼치기">
      <span class="slip-inner">
        <span class="face front"><span class="slip-no">${i + 1}</span></span>
        <span class="face back" aria-hidden="true"></span>
      </span>
    </button>`;
  }).join('');
  if (!slips.length) {
    grid.innerHTML = '<div class="empty"><span class="empty-emoji" aria-hidden="true">🎟️</span><p>왼쪽에서 제비 내용을 입력해 주세요.</p></div>';
  }
  renderBoardStatus();
  renderBoardLog();
}

function openSlip(i, { celebrate = true } = {}) {
  const s = slips[i];
  if (!s || s.open) return;
  s.open = true;
  boardLog.push(i);

  const el = $(`.slip[data-i="${i}"]`);
  const back = $('.back', el);
  const text = escapeHtml(s.text);
  back.innerHTML = `<span class="back-no">${i + 1}</span>` + (s.win
    ? `<span class="stamp ${[...s.text].length <= 3 ? 'round' : 'rect'}">${text}</span>`
    : `<span class="lose-text">${text}</span>`);
  back.removeAttribute('aria-hidden');
  el.classList.add('is-open', s.win ? 'is-win' : 'is-lose');
  el.setAttribute('aria-label', `${i + 1}번 제비: ${s.text}`);
  el.setAttribute('aria-disabled', 'true');

  if (s.win && celebrate) {
    const r = el.getBoundingClientRect();
    setTimeout(() => burst(r.left + r.width / 2, r.top + r.height / 2, 90), reduceMotion.matches ? 0 : 420);
  }
  renderBoardStatus();
  renderBoardLog();
}

function renderBoardStatus() {
  const total = slips.length;
  const opened = slips.filter((s) => s.open).length;
  const winsLeft = slips.filter((s) => s.win && !s.open).length;
  const allDone = total > 0 && opened === total;
  $('#board-status').innerHTML = total
    ? `<span>남은 제비 <b>${total - opened}</b> / ${total}</span>
       <span class="accent">남은 당첨 <b>${winsLeft}</b></span>
       ${allDone ? '<span class="done">모든 제비를 펼쳤어요 🎉</span>' : ''}`
    : '';
  $('#board-progress').style.width = total ? `${(opened / total) * 100}%` : '0';
  $('#board-reveal-all').disabled = allDone || !total;
}

function renderBoardLog() {
  const log = $('#board-log');
  if (!boardLog.length) {
    log.innerHTML = '<li class="empty-log">아직 펼친 제비가 없어요. 아무 제비나 눌러보세요!</li>';
    return;
  }
  log.innerHTML = boardLog.map((i) => {
    const s = slips[i];
    return `<li class="${s.win ? 'win' : ''}">${i + 1}번 · ${escapeHtml(s.text)}</li>`;
  }).join('');
}

function initBoard() {
  $('#slip-grid').addEventListener('click', (e) => {
    const el = e.target.closest('.slip');
    if (el) openSlip(Number(el.dataset.i));
  });
  $('#board-shuffle').addEventListener('click', () => {
    buildBoard();
    toast('제비를 새로 섞었어요');
  });
  $('#board-reveal-all').addEventListener('click', () => {
    const closed = slips.map((s, i) => (s.open ? -1 : i)).filter((i) => i >= 0);
    closed.forEach((i, n) => setTimeout(() => openSlip(i, { celebrate: false }), reduceMotion.matches ? 0 : n * 60));
  });
  buildBoard();
}

/* ==========================================================================
   이름 뽑기
   ========================================================================== */
function parsePeople() {
  return state.people.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function currentPool() {
  const list = parsePeople();
  if (!state.names.exclude) return list;
  const taken = [...drawn];
  return list.filter((name) => {
    const k = taken.indexOf(name);
    if (k === -1) return true;
    taken.splice(k, 1);
    return false;
  });
}

function renderPeopleCount() {
  const n = parsePeople().length;
  for (const el of $$('.people-count')) el.textContent = `참가자 ${n}명`;
}

function renderPool() {
  const pool = currentPool();
  const hint = $('#pool-hint');
  const need = state.names.count;
  hint.classList.toggle('is-error', pool.length < need);
  hint.textContent = pool.length < need
    ? (pool.length ? `남은 후보가 ${pool.length}명이라 ${need}명을 뽑을 수 없어요` : '남은 후보가 없어요. 기록을 초기화해 주세요.')
    : `남은 후보 ${pool.length}명 중 ${need}명`;
  $('#names-draw').disabled = drawing || pool.length < need;
}

function renderHistory() {
  const el = $('#names-history');
  if (!drawHistory.length) {
    el.innerHTML = '<li class="empty-log">아직 뽑은 기록이 없어요.</li>';
    return;
  }
  el.innerHTML = drawHistory.slice().reverse().map((h) => `
    <li><span class="h-round">${h.round}회</span><span class="h-time">${h.time}</span>
    <span class="h-names">${h.names.map(escapeHtml).join(', ')}</span></li>`).join('');
}

function renderPapers(names) {
  const el = $('#result-papers');
  if (!names) {
    el.innerHTML = '<div class="empty"><span class="empty-emoji" aria-hidden="true">🫙</span><p><b>뽑기!</b>를 누르면 제비통에서 이름이 나와요.</p></div>';
    return;
  }
  el.innerHTML = names.map((n, i) => `
    <div class="paper" style="--i:${i}">
      <span class="paper-no">No. ${String(i + 1).padStart(2, '0')}</span>
      <span class="paper-name">${escapeHtml(n)}</span>
    </div>`).join('');
}

function draw() {
  const pool = currentPool();
  const count = state.names.count;
  if (drawing || pool.length < count) return;
  drawing = true;
  renderPool();

  const jar = $('#jar');
  const ticker = $('#ticker');
  const duration = reduceMotion.matches ? 0 : 1300;
  jar.classList.add('shaking');
  ticker.classList.add('is-rolling');
  const roll = setInterval(() => { ticker.textContent = pick(pool); }, 70);

  setTimeout(() => {
    clearInterval(roll);
    jar.classList.remove('shaking');
    ticker.classList.remove('is-rolling');

    const winners = sample(pool, count);
    ticker.textContent = winners.length === 1 ? `🎉 ${winners[0]}` : `🎉 ${winners.length}명 당첨`;
    if (state.names.exclude) drawn.push(...winners);
    const now = new Date();
    drawHistory.push({
      round: drawHistory.length + 1,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      names: winners,
    });
    renderPapers(winners);
    renderHistory();
    const r = $('#result-papers').getBoundingClientRect();
    burst(r.left + Math.min(r.width, 320) / 2, r.top + 50, 130);

    drawing = false;
    renderPool();
  }, duration);
}

function initNames() {
  $('#names-draw').addEventListener('click', draw);
  $('#names-reset').addEventListener('click', () => {
    drawn = [];
    drawHistory = [];
    $('#ticker').textContent = '';
    renderPapers(null);
    renderHistory();
    renderPool();
    toast('뽑기 기록을 초기화했어요');
  });
  renderPeopleCount();
  renderPapers(null);
  renderHistory();
  renderPool();
}

/* ==========================================================================
   팀 나누기
   ========================================================================== */
function makeTeams() {
  const people = parsePeople();
  if (people.length < 2) {
    toast('참가자를 2명 이상 입력해 주세요');
    return;
  }
  const n = Math.min(state.teams.count, people.length);
  if (n < state.teams.count) toast(`참가자가 ${people.length}명이라 ${n}팀으로 나눴어요`);

  const teams = Array.from({ length: n }, () => []);
  // 남는 인원이 특정 팀에 몰리지 않도록 팀 순서도 섞는다
  const order = shuffle([...Array(n).keys()]);
  shuffle(people).forEach((p, i) => teams[order[i % n]].push(p));
  lastTeams = teams;

  $('#team-grid').innerHTML = teams.map((members, i) => `
    <article class="team" style="--i:${i};--c:var(--t${i % 8})">
      <header class="team-head"><span class="team-name">${i + 1}팀</span><span class="team-size">${members.length}명</span></header>
      <ul>${members.map((m, j) => `<li style="--j:${j}">${escapeHtml(m)}</li>`).join('')}</ul>
    </article>`).join('');
  $('#teams-copy').disabled = false;
}

function initTeams() {
  $('#teams-make').addEventListener('click', makeTeams);
  $('#teams-copy').addEventListener('click', async () => {
    if (!lastTeams) return;
    const text = lastTeams.map((m, i) => `${i + 1}팀: ${m.join(', ')}`).join('\n');
    toast((await copyText(text)) ? '팀 결과를 복사했어요' : '복사에 실패했어요');
  });
}

/* ==========================================================================
   Top bar: share + theme
   ========================================================================== */
function initTopbar() {
  $('#share-btn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#s=${encodeShare(state)}`;
    toast((await copyText(url)) ? '현재 설정이 담긴 링크를 복사했어요' : '복사에 실패했어요');
  });

  $('#theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#15130F' : '#F3EEE4';
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */
normalizeNumbers();
initBindings();
initTabs();
initBoard();
initNames();
initTeams();
initTopbar();

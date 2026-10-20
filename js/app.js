import { shuffle } from './random.js?v=7';
import { burst } from './confetti.js?v=7';
import { $, $$, reduceMotion, escapeHtml, toast } from './utils.js?v=7';
import { initRoomManitto, activateRoomAdmin } from './manitto-room.js?v=7';

/* ==========================================================================
   State
   ========================================================================== */
const STORAGE_KEY = 'manitto:v1';
const THEME_KEY = 'jebi:theme';
const MANITTO_KEY = 'jebi:manitto';

const DEFAULTS = {
  tab: 'room',
  people: '김민준\n이서연\n박도윤\n최하은\n정시우\n강지아\n윤예준\n임수아',
};

const state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }, 200);
}

/* ==========================================================================
   Tabs (온라인 방 / 모여서 뽑기)
   ========================================================================== */
const TABS = ['room', 'local'];

function setTab(tab, focus = false) {
  state.tab = TABS.includes(tab) ? tab : 'room';
  for (const btn of $$('.tab')) {
    const on = btn.dataset.tab === state.tab;
    btn.setAttribute('aria-selected', on);
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus();
  }
  for (const panel of $$('.panel')) panel.hidden = panel.id !== `panel-${state.tab}`;
  moveIndicator();
  // Firebase는 온라인 방 탭을 열 때만 불러온다
  if (state.tab === 'room') activateRoomAdmin();
  save();
}

function moveIndicator() {
  const active = $('.tab[aria-selected="true"]');
  if (!active) return;
  const ind = $('.tab-indicator');
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
  setTab(state.tab);
}

/* ==========================================================================
   모여서 뽑기
   참가자를 섞은 순서대로 원형으로 이어서(A→B→C→…→A) 배정한다.
   n!개의 순서가 (n-1)!개의 원형 배치에 n개씩 대응하므로 모든 배치가 균등하게 나오고,
   자기 자신이나 서로를 챙기는 쌍(n≥3일 때)은 생기지 않는다.
   ========================================================================== */
let manitto = loadManitto(); // { people, order, checked } | null
let manittoRevealed = false;
let dialogDone = null;

function parsePeople() {
  return state.people.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function loadManitto() {
  try {
    const m = JSON.parse(localStorage.getItem(MANITTO_KEY) || 'null');
    return m && Array.isArray(m.people) && Array.isArray(m.order) ? { checked: [], ...m } : null;
  } catch {
    return null;
  }
}

function saveManitto() {
  try {
    if (manitto) localStorage.setItem(MANITTO_KEY, JSON.stringify(manitto));
    else localStorage.removeItem(MANITTO_KEY);
  } catch {}
}

const manittoStale = () => !!manitto && manitto.people.join('\n') !== parsePeople().join('\n');

function targetOf(name) {
  const { order } = manitto;
  return order[(order.indexOf(name) + 1) % order.length];
}

function makeManitto() {
  const people = parsePeople();
  if (people.length < 3) {
    toast('마니또는 3명 이상부터 뽑을 수 있어요');
    return;
  }
  const dup = people.find((p, i) => people.indexOf(p) !== i);
  if (dup) {
    toast(`같은 이름이 두 번 있어요: ${dup}`);
    return;
  }
  if (manitto && !manittoStale() && manitto.checked.length
    && !confirm('이미 결과를 확인한 사람이 있어요. 마니또를 새로 뽑을까요?')) return;

  manitto = { people, order: shuffle(people), checked: [] };
  manittoRevealed = false;
  saveManitto();
  renderManitto();
  toast('마니또를 뽑았어요! 한 명씩 몰래 확인해 보세요');
}

function renderPeopleCount() {
  $('#people-count').textContent = `참가자 ${parsePeople().length}명`;
}

function renderManitto() {
  const grid = $('#manitto-grid');
  const chain = $('#manitto-chain');
  const stale = manittoStale();
  $('#manitto-head').hidden = !manitto;
  $('#manitto-make').textContent = manitto ? '마니또 다시 뽑기' : '마니또 뽑기';
  $('#manitto-reveal-all').disabled = !manitto || stale;
  $('#manitto-reveal-all').textContent = manittoRevealed ? '전체 결과 숨기기' : '전체 결과 보기';

  if (!manitto) {
    grid.innerHTML = `<div class="empty"><span class="empty-emoji" aria-hidden="true">🎁</span>
      <p>참가자를 3명 이상 입력하고 <b>마니또 뽑기</b>를 눌러보세요.<br>한 기기를 돌려가며 각자 몰래 확인해요.</p></div>`;
    chain.hidden = true;
    return;
  }

  const total = manitto.people.length;
  const done = manitto.checked.length;
  $('#manitto-status').innerHTML = stale
    ? '<span class="warn">참가자 목록이 바뀌었어요. 마니또를 다시 뽑아 주세요.</span>'
    : `<span>확인 완료 <b>${done}</b> / ${total}</span>${done === total ? '<span class="done">모두 확인했어요 🎁</span>' : ''}`;
  $('#manitto-progress').style.width = stale ? '0' : `${(done / total) * 100}%`;

  // 섞인 순서(order)를 노출하면 배정이 드러나므로 입력 순서대로 보여준다
  grid.innerHTML = manitto.people.map((name, i) => {
    const checked = manitto.checked.includes(name);
    const n = escapeHtml(name);
    return `<article class="m-card${checked ? ' is-checked' : ''}" style="--i:${i}">
      <span class="m-avatar" aria-hidden="true">${checked ? '✓' : escapeHtml([...name][0])}</span>
      <span class="m-info"><span class="m-name">${n}</span><span class="m-state">${checked ? '확인함' : '확인 전'}</span></span>
      <span class="m-actions">
        <button class="btn btn-sm btn-primary" type="button" data-act="open" data-name="${n}" ${stale ? 'disabled' : ''}>확인</button>
      </span>
    </article>`;
  }).join('');

  chain.hidden = !manittoRevealed || stale;
  if (!chain.hidden) {
    chain.innerHTML = `<h3 class="mini-title">전체 결과 · 왼쪽 사람이 오른쪽 사람을 몰래 챙겨요</h3>
      <ol class="m-chain">${manitto.people.map((n) => `
        <li><b>${escapeHtml(n)}</b><span class="arrow" aria-label="이(가) 챙길 사람">→</span><span>${escapeHtml(targetOf(n))}</span></li>`).join('')}
      </ol>`;
  }
}

function initLocal() {
  const ta = $('#local-people');
  ta.value = state.people;
  ta.addEventListener('input', () => {
    state.people = ta.value;
    renderPeopleCount();
    renderManitto();
    save();
  });
  $('#manitto-make').addEventListener('click', makeManitto);
  $('#manitto-reveal-all').addEventListener('click', () => {
    if (!manittoRevealed && !confirm('모든 사람의 마니또가 화면에 공개돼요. 계속할까요?')) return;
    manittoRevealed = !manittoRevealed;
    renderManitto();
  });
  $('#manitto-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="open"]');
    if (!btn || manittoStale()) return;
    const name = btn.dataset.name;
    openManittoDialog(name, targetOf(name), () => {
      if (!manitto.checked.includes(name)) manitto.checked.push(name);
      saveManitto();
      renderManitto();
    });
  });
  renderPeopleCount();
  renderManitto();
}

/* ==========================================================================
   결과 확인 대화상자 (모여서 뽑기·온라인 방 공용)
   ========================================================================== */
function openManittoDialog(giver, target, onDone, title = '') {
  const dialog = $('#manitto-dialog');
  $('.m-event', dialog).textContent = title;
  for (const el of $$('.m-who', dialog)) el.textContent = giver;
  $('.m-target', dialog).textContent = target;
  $('[data-step="1"]', dialog).hidden = false;
  $('[data-step="2"]', dialog).hidden = true;
  dialogDone = onDone;
  dialog.showModal();
}

function initDialog() {
  const dialog = $('#manitto-dialog');
  dialog.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reveal') {
      $('[data-step="1"]', dialog).hidden = true;
      $('[data-step="2"]', dialog).hidden = false;
      $('[data-act="done"]', dialog).focus();
      const r = $('.name-card', dialog).getBoundingClientRect();
      setTimeout(() => burst(r.left + r.width / 2, r.top + r.height / 2, 90), reduceMotion.matches ? 0 : 350);
    } else if (act === 'done') {
      dialogDone?.();
      dialog.close();
    } else if (act === 'close') {
      dialog.close();
    }
  });
  // 닫힐 때는 항상 결과를 지워 다음 사람이 보지 못하게 한다
  dialog.addEventListener('close', () => {
    $('.m-target', dialog).textContent = '';
    dialogDone = null;
  });
}

/* ==========================================================================
   Theme
   ========================================================================== */
function initTheme() {
  $('#theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    $('meta[name="theme-color"]').content = next === 'dark' ? '#16120F' : '#F6F1EA';
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */
initTheme();
initDialog();
// 초대 링크로 열었으면 참가자 화면만 보여준다
if (!initRoomManitto({ openManittoDialog })) {
  initLocal();
  initTabs();
}

/* ============================================================
   Миний Туслах — Personal Assistant PWA
   Tasks · Calendar · Habits · Reminders
   Data persists in localStorage. Works offline.
   ============================================================ */

'use strict';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- Auth store (separate from per-user data) ---------- */
const AUTH_KEY = 'minii-tuslakh-auth-v1';
const LEGACY_DATA_KEY = 'minii-tuslakh-v1'; // pre-auth single-user data (for migration)
let auth = loadAuth();
let currentUser = null;

function loadAuth() {
  try { return Object.assign({ users: [], currentUserId: null }, JSON.parse(localStorage.getItem(AUTH_KEY)) || {}); }
  catch (e) { return { users: [], currentUserId: null }; }
}
function saveAuth() { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }

/* ---------- Per-user data store ---------- */
const dataKey = (id) => 'minii-tuslakh-data-' + id;

const defaultState = () => ({
  tasks: [],      // {id, title, date, time, priority, category, note, done}
  habits: [],     // {id, name, icon, history:{'YYYY-MM-DD':true}}
  reminders: [],  // {id, title, time:'HH:MM', date:'YYYY-MM-DD'|null, repeat:'none'|'daily'|'weekly', enabled, lastFired}
  finance: [],    // {id, kind, title, amount, category, date, note}
});

/* ---------- Task categories ---------- */
const TASK_CATS = [
  { key: 'work', label: 'Ажил', icon: '💼' },
  { key: 'personal', label: 'Хувийн', icon: '🏠' },
  { key: 'finance', label: 'Санхүү', icon: '💰' },
  { key: 'health', label: 'Эрүүл мэнд', icon: '❤️' },
  { key: 'study', label: 'Суралцах', icon: '📚' },
  { key: 'other', label: 'Бусад', icon: '📌' },
];
const taskCat = (k) => TASK_CATS.find(c => c.key === k) || TASK_CATS.find(c => c.key === 'other');

/* ---------- Money formatting (Tugrik) ---------- */
function money(n) {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return (neg ? '-' : '') + s + '₮';
}

let state = defaultState();

function load() {
  if (!currentUser) return defaultState();
  try {
    const raw = localStorage.getItem(dataKey(currentUser.id));
    if (!raw) return defaultState();
    return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) { return defaultState(); }
}
function save() {
  if (!currentUser) return;
  localStorage.setItem(dataKey(currentUser.id), JSON.stringify(state));
}

/* ---------- Password hashing (SHA-256 + salt) ---------- */
function randSalt() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPw(pw, salt) {
  const data = new TextEncoder().encode(salt + ':' + pw);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Permissions ---------- */
const ALL_PERMS = [
  { key: 'tasks', label: 'Даалгавар', icon: '✓' },
  { key: 'calendar', label: 'Календар', icon: '📅' },
  { key: 'habits', label: 'Зуршил', icon: '🔥' },
  { key: 'reminders', label: 'Сэрүүлэг', icon: '🔔' },
  { key: 'finance', label: 'Санхүү', icon: '💰' },
];
const PERM_KEYS = ALL_PERMS.map(p => p.key);

function can(view) {
  if (!currentUser) return false;
  if (view === 'today' || view === 'profile') return true;
  if (currentUser.role === 'admin') return true;
  return (currentUser.perms || []).includes(view);
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '')[0] || '?').toUpperCase() + (parts[1] ? parts[1][0].toUpperCase() : '');
}

/* ---------- Date helpers ---------- */
const WD_SHORT = ['Ня', 'Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя']; // JS getDay: 0=Sun
const WD_MON = ['Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя', 'Ня'];    // Monday-first index
const MONTHS = ['1-р сар', '2-р сар', '3-р сар', '4-р сар', '5-р сар', '6-р сар',
  '7-р сар', '8-р сар', '9-р сар', '10-р сар', '11-р сар', '12-р сар'];

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayYmd() { return ymd(new Date()); }
// Monday-first weekday index (0=Mon..6=Sun)
function monIdx(d) { return (d.getDay() + 6) % 7; }
function fmtHuman(s) {
  const d = parseYmd(s);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${WD_SHORT[d.getDay()]}`;
}

/* ---------- App globals ---------- */
let currentView = 'today';
let selectedDate = todayYmd();      // for tasks view
let calMonth = new Date();          // calendar displayed month
let calSelected = todayYmd();       // calendar selected day
let taskFilter = 'all';
let taskMode = 'day';        // 'day' | 'list'
let listFilter = 'active';   // 'active' | 'done' | 'all'
let catFilter = 'all';       // 'all' | category key

/* ---------- Navigation ---------- */
const HEADER_TITLES = {
  today: 'Өнөөдөр', tasks: 'Даалгавар', calendar: 'Календар',
  habits: 'Зуршил', reminders: 'Сэрүүлэг', finance: 'Санхүү', profile: 'Профайл'
};

function switchView(view) {
  if (!can(view)) { toast('Танд энэ хэсгийн эрх алга'); return; }
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('header-title').textContent = HEADER_TITLES[view];
  // FAB shows on data-entry views, gated by the matching permission
  const fabPerm = { today: 'tasks', tasks: 'tasks', calendar: 'tasks', habits: 'habits', reminders: 'reminders', finance: 'finance' }[view];
  document.getElementById('fab').hidden = !fabPerm || !can(fabPerm);
  window.scrollTo(0, 0);
  render();
}

/* ---------- Rendering dispatch ---------- */
function render() {
  document.getElementById('header-date').textContent = fmtHuman(todayYmd());
  switch (currentView) {
    case 'today': renderToday(); break;
    case 'tasks': renderTasks(); break;
    case 'calendar': renderCalendar(); break;
    case 'habits': renderHabits(); break;
    case 'reminders': renderReminders(); break;
    case 'finance': renderFinance(); break;
    case 'profile': renderProfile(); break;
  }
}

/* ============================================================
   TODAY / DASHBOARD
   ============================================================ */
function renderToday() {
  const t = todayYmd();
  const hour = new Date().getHours();
  let greet = 'Сайн байна уу!';
  if (hour < 6) greet = 'Сайхан амраарай 🌙';
  else if (hour < 12) greet = 'Өглөөний мэнд ☀️';
  else if (hour < 18) greet = 'Өдрийн мэнд 🌤️';
  else greet = 'Оройн мэнд 🌆';
  document.getElementById('hero-greeting').textContent = greet;

  ensureWeather();

  const todayTasks = state.tasks.filter(x => x.date === t);
  const doneTasks = todayTasks.filter(x => x.done).length;
  const habitsDone = state.habits.filter(h => h.history[t]).length;
  const remCount = state.reminders.filter(r => r.enabled).length;

  document.getElementById('hero-sub').textContent =
    `${todayTasks.length} даалгавраас ${doneTasks} дууссан · ${habitsDone}/${state.habits.length} зуршил`;
  document.getElementById('stat-tasks').textContent = `${doneTasks}/${todayTasks.length}`;
  document.getElementById('stat-habits').textContent = `${habitsDone}/${state.habits.length}`;
  document.getElementById('stat-reminders').textContent = remCount;

  // Today's tasks (max 4)
  const tl = document.getElementById('today-tasks');
  tl.innerHTML = '';
  if (!todayTasks.length) {
    tl.innerHTML = `<div class="empty" style="padding:24px">Өнөөдөр даалгавар алга 🎉</div>`;
  } else {
    todayTasks.slice(0, 5).forEach(task => tl.appendChild(taskNode(task)));
  }

  // Habits quick row
  const hq = document.getElementById('today-habits');
  hq.innerHTML = '';
  if (!state.habits.length) {
    hq.innerHTML = `<div class="empty" style="padding:20px">Зуршил алга</div>`;
  } else {
    state.habits.forEach(h => {
      const done = !!h.history[t];
      const el = document.createElement('div');
      el.className = 'habit-chip' + (done ? ' done' : '');
      el.innerHTML = `<div class="hc-ico">${h.icon}</div>
        <div class="hc-name">${esc(h.name)}</div>
        <div class="hc-streak">🔥 ${streak(h)}</div>`;
      el.onclick = () => { toggleHabit(h.id, t); };
      hq.appendChild(el);
    });
  }

  // Upcoming reminders
  const rl = document.getElementById('today-reminders');
  rl.innerHTML = '';
  const active = state.reminders.filter(r => r.enabled).sort(sortRem);
  if (!active.length) {
    rl.innerHTML = `<div class="empty" style="padding:24px">Идэвхтэй сэрүүлэг алга</div>`;
  } else {
    active.slice(0, 4).forEach(r => rl.appendChild(reminderNode(r, true)));
  }

  renderTodayFinance();
}

/* ============================================================
   TASKS
   ============================================================ */
function renderTasks() {
  document.querySelectorAll('#view-tasks .ms-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === taskMode));
  document.getElementById('tasks-by-day').hidden = taskMode !== 'day';
  document.getElementById('tasks-all').hidden = taskMode !== 'list';
  if (taskMode === 'list') { renderTaskList(); return; }

  // Date strip: 7 days from -1 .. +5 around today, keep selected in view
  const strip = document.getElementById('date-strip');
  strip.innerHTML = '';
  const base = new Date();
  for (let i = -1; i <= 12; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const key = ymd(d);
    const pill = document.createElement('div');
    pill.className = 'date-pill' + (key === selectedDate ? ' active' : '');
    if (state.tasks.some(x => x.date === key)) pill.classList.add('has-dot');
    pill.innerHTML = `<div class="dp-wd">${WD_SHORT[d.getDay()]}</div><div class="dp-day">${d.getDate()}</div>`;
    pill.onclick = () => { selectedDate = key; renderTasks(); };
    strip.appendChild(pill);
  }

  document.querySelectorAll('#tasks-by-day .chip').forEach(c =>
    c.classList.toggle('active', c.dataset.filter === taskFilter));

  let list = state.tasks.filter(x => x.date === selectedDate);
  if (taskFilter === 'active') list = list.filter(x => !x.done);
  if (taskFilter === 'done') list = list.filter(x => x.done);
  list.sort((a, b) => (a.done - b.done) || ((a.time || '99') > (b.time || '99') ? 1 : -1));

  const ul = document.getElementById('task-list');
  ul.innerHTML = '';
  list.forEach(task => ul.appendChild(taskNode(task)));
  document.getElementById('task-empty').hidden = list.length > 0;
}

// Days until deadline (negative = overdue). null if no date.
function daysToDeadline(dateStr) {
  if (!dateStr) return null;
  return Math.round((parseYmd(dateStr) - parseYmd(todayYmd())) / 86400000);
}
function deadlineChip(task) {
  if (!task.date) return '';
  const d = daysToDeadline(task.date);
  let cls = '', txt;
  if (task.done) txt = `📅 ${fmtHuman(task.date)}`;
  else if (d < 0) { cls = 'over'; txt = `⚠️ ${-d} хоног хэтэрсэн`; }
  else if (d === 0) { cls = 'soon'; txt = '⏰ Өнөөдөр дуусна'; }
  else if (d === 1) { cls = 'soon'; txt = '⏰ Маргааш'; }
  else if (d <= 3) { cls = 'soon'; txt = `⏰ ${d} хоногийн дараа`; }
  else txt = `📅 ${fmtHuman(task.date)}`;
  return `<span class="deadline-chip ${cls}">${txt}</span>`;
}

function taskNode(task, opts = {}) {
  const li = document.createElement('li');
  li.className = 'task-item' + (task.done ? ' is-done' : '');
  const prio = { high: 'Чухал', med: 'Дунд', low: 'Бага' }[task.priority] || '';
  const prioCls = { high: 'prio-high', med: 'prio-med', low: 'prio-low' }[task.priority] || '';
  const cat = taskCat(task.category);
  li.innerHTML = `
    <div class="task-check ${task.done ? 'done' : ''}">✓</div>
    <div class="task-main">
      <div class="task-title">${esc(task.title)}</div>
      <div class="task-meta">
        <span class="cat-chip">${cat.icon} ${cat.label}</span>
        ${opts.showDeadline ? deadlineChip(task) : (task.time ? `<span>🕐 ${task.time}</span>` : '')}
        ${prio ? `<span class="prio-dot ${prioCls}"></span><span>${prio}</span>` : ''}
        ${task.note ? `<span>📝</span>` : ''}
      </div>
    </div>
    ${opts.postpone && !task.done ? `<button class="task-postpone">⏰ Сунгах</button>` : `<button class="task-del">🗑</button>`}`;
  li.querySelector('.task-check').onclick = () => { task.done = !task.done; save(); render(); };
  const del = li.querySelector('.task-del');
  if (del) del.onclick = () => { removeTask(task.id); };
  const pp = li.querySelector('.task-postpone');
  if (pp) pp.onclick = (e) => { e.stopPropagation(); openPostpone(task); };
  li.querySelector('.task-main').onclick = () => openTaskModal(task);
  return li;
}

/* ---- List mode: all tasks grouped by deadline ---- */
function renderTaskList() {
  document.querySelectorAll('#tasks-all .chip').forEach(c =>
    c.classList.toggle('active', c.dataset.lfilter === listFilter));

  // category filter chips
  const cf = document.getElementById('cat-filter');
  cf.innerHTML = `<button class="chip ${catFilter === 'all' ? 'active' : ''}" data-cat="all">Бүгд</button>` +
    TASK_CATS.map(c => `<button class="chip ${catFilter === c.key ? 'active' : ''}" data-cat="${c.key}">${c.icon} ${c.label}</button>`).join('');
  cf.querySelectorAll('.chip').forEach(b => b.onclick = () => { catFilter = b.dataset.cat; renderTaskList(); });

  let list = state.tasks.slice();
  if (listFilter === 'active') list = list.filter(t => !t.done);
  if (listFilter === 'done') list = list.filter(t => t.done);
  if (catFilter !== 'all') list = list.filter(t => (t.category || 'other') === catFilter);

  const groups = document.getElementById('task-groups');
  groups.innerHTML = '';
  document.getElementById('list-empty').hidden = list.length > 0;

  // buckets
  const buckets = [
    { key: 'over', title: '⚠️ Хугацаа хэтэрсэн', cls: 'overdue', items: [] },
    { key: 'today', title: '⏰ Өнөөдөр', cls: '', items: [] },
    { key: 'soon', title: '📅 Удахгүй', cls: '', items: [] },
    { key: 'later', title: '🗓️ Дараа', cls: '', items: [] },
    { key: 'none', title: '📋 Хугацаагүй', cls: '', items: [] },
    { key: 'done', title: '✅ Дууссан', cls: '', items: [] },
  ];
  const map = {};
  buckets.forEach(b => map[b.key] = b);
  list.forEach(t => {
    if (t.done) { map.done.items.push(t); return; }
    const d = daysToDeadline(t.date);
    if (d === null) map.none.items.push(t);
    else if (d < 0) map.over.items.push(t);
    else if (d === 0) map.today.items.push(t);
    else if (d <= 7) map.soon.items.push(t);
    else map.later.items.push(t);
  });
  // sort dated buckets by date asc
  ['over', 'today', 'soon', 'later'].forEach(k => map[k].items.sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1));

  buckets.forEach(b => {
    if (!b.items.length) return;
    const g = document.createElement('div');
    g.className = 'task-group ' + b.cls;
    g.innerHTML = `<div class="tg-head">${b.title}<span class="tg-count">${b.items.length}</span></div>`;
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    b.items.forEach(t => ul.appendChild(taskNode(t, { showDeadline: true, postpone: b.key !== 'done' })));
    g.appendChild(ul);
    groups.appendChild(g);
  });
}

/* ---- Postpone (extend deadline) ---- */
function openPostpone(task) {
  modalTitle.textContent = 'Хугацаа сунгах';
  const base = task.date ? task.date : todayYmd();
  const plus = (n) => { const d = parseYmd(base); d.setDate(d.getDate() + n); return ymd(d); };
  modalBody.innerHTML = `
    <div class="field"><label>"${esc(task.title)}"</label>
      <div style="color:var(--muted);font-size:13px;margin-bottom:6px">${task.date ? 'Одоогийн хугацаа: ' + fmtHuman(task.date) : 'Хугацаа тогтоогоогүй'}</div>
    </div>
    <div class="seg" style="margin-bottom:10px">
      <button data-add="1">+1 өдөр</button>
      <button data-add="3">+3 өдөр</button>
      <button data-add="7">+1 долоо хоног</button>
    </div>
    <div class="field"><label>Эсвэл огноо сонгох</label>
      <input id="pp-date" type="date" value="${base}"/></div>
    <button class="btn-primary" id="pp-save">Хадгалах</button>`;
  modalBody.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    task.date = plus(parseInt(b.dataset.add, 10)); save(); closeModal(); render(); toast('Хугацаа сунгалаа');
  });
  document.getElementById('pp-save').onclick = () => {
    task.date = val('pp-date'); save(); closeModal(); render(); toast('Хугацаа шинэчлэгдлээ');
  };
  openModal();
}

function removeTask(id) {
  state.tasks = state.tasks.filter(x => x.id !== id);
  save(); render(); toast('Устгалаа');
}

/* ============================================================
   CALENDAR
   ============================================================ */
function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  document.getElementById('cal-title').textContent = `${y} он, ${MONTHS[m]}`;
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  const first = new Date(y, m, 1);
  const startPad = monIdx(first);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const t = todayYmd();

  for (let i = 0; i < startPad; i++) {
    const c = document.createElement('div'); c.className = 'cal-cell empty'; grid.appendChild(c);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = ymd(new Date(y, m, day));
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (key === t) cell.classList.add('today');
    if (key === calSelected) cell.classList.add('selected');

    const dots = [];
    if (state.tasks.some(x => x.date === key)) dots.push('var(--primary-2)');
    if (state.reminders.some(r => r.date === key)) dots.push('var(--amber)');
    cell.innerHTML = `<span>${day}</span>` +
      (dots.length ? `<div class="cal-dots">${dots.map(c => `<i style="background:${c}"></i>`).join('')}</div>` : '');
    cell.onclick = () => { calSelected = key; renderCalendar(); };
    grid.appendChild(cell);
  }

  // Day detail
  document.getElementById('cal-day-title').textContent = fmtHuman(calSelected);
  const items = document.getElementById('cal-day-items');
  items.innerHTML = '';
  const dayTasks = state.tasks.filter(x => x.date === calSelected);
  const dayRems = state.reminders.filter(r => r.date === calSelected);
  if (!dayTasks.length && !dayRems.length) {
    items.innerHTML = `<div class="empty" style="padding:24px">Энэ өдөр зүйл алга.<br/>+ товчоор нэмээрэй.</div>`;
  } else {
    dayTasks.forEach(task => items.appendChild(taskNode(task)));
    dayRems.forEach(r => items.appendChild(reminderNode(r, true)));
  }
}

/* ============================================================
   HABITS
   ============================================================ */
function streak(h) {
  let s = 0;
  const d = new Date();
  // if today not done, start counting from yesterday
  if (!h.history[ymd(d)]) d.setDate(d.getDate() - 1);
  while (h.history[ymd(d)]) { s++; d.setDate(d.getDate() - 1); }
  return s;
}

function toggleHabit(id, dateKey) {
  const h = state.habits.find(x => x.id === id);
  if (!h) return;
  if (h.history[dateKey]) delete h.history[dateKey];
  else h.history[dateKey] = true;
  save(); render();
}

// Compute detailed statistics for a habit
function habitStats(h) {
  const keys = Object.keys(h.history).filter(k => h.history[k]).sort();
  const total = keys.length;
  // best streak
  let best = 0, run = 0, prev = null;
  keys.forEach(k => {
    if (prev) {
      const diff = Math.round((parseYmd(k) - parseYmd(prev)) / 86400000);
      run = diff === 1 ? run + 1 : 1;
    } else run = 1;
    if (run > best) best = run;
    prev = k;
  });
  // this month
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthDone = keys.filter(k => k.startsWith(ym)).length;
  const daysElapsed = now.getDate();
  const monthPct = Math.round((monthDone / daysElapsed) * 100);
  return { total, best, current: streak(h), monthDone, monthPct };
}

function renderHabitSummary() {
  const bar = document.getElementById('habit-summary');
  if (!state.habits.length) { bar.className = 'habit-summary empty'; bar.innerHTML = ''; return; }
  bar.className = 'habit-summary';
  const t = todayYmd();
  const doneToday = state.habits.filter(h => h.history[t]).length;
  // 7-day completion across all habits
  let slots = 0, hits = 0;
  const base = new Date();
  state.habits.forEach(h => {
    for (let i = 0; i < 7; i++) { const d = new Date(base); d.setDate(base.getDate() - i); slots++; if (h.history[ymd(d)]) hits++; }
  });
  const weekPct = slots ? Math.round((hits / slots) * 100) : 0;
  const bestStreak = Math.max(0, ...state.habits.map(h => habitStats(h).best));
  bar.innerHTML = `
    <div class="hs-tile"><div class="hs-num">${doneToday}/${state.habits.length}</div><div class="hs-lbl">Өнөөдөр</div></div>
    <div class="hs-tile"><div class="hs-num">${weekPct}%</div><div class="hs-lbl">7 хоног</div></div>
    <div class="hs-tile"><div class="hs-num">🔥 ${bestStreak}</div><div class="hs-lbl">Дээд амжилт</div></div>`;
}

function renderHabits() {
  renderHabitSummary();
  const cont = document.getElementById('habit-container');
  cont.innerHTML = '';
  document.getElementById('habit-empty').hidden = state.habits.length > 0;

  // Last 7 days (Mon-first window ending today)
  const days = [];
  const base = new Date();
  for (let i = 6; i >= 0; i--) { const d = new Date(base); d.setDate(base.getDate() - i); days.push(d); }
  const t = todayYmd();

  state.habits.forEach(h => {
    const card = document.createElement('div');
    card.className = 'habit-card';
    const head = document.createElement('div');
    head.className = 'habit-card-head';
    head.innerHTML = `<div class="hc-ico">${h.icon}</div>
      <div class="hc-info"><div class="hc-name">${esc(h.name)}</div>
      <div class="hc-streak">🔥 ${streak(h)} өдөр дараалан</div></div>
      <button class="task-del st-btn">📊</button>
      <button class="task-del">🗑</button>`;
    head.querySelector('.st-btn').onclick = () => openHabitStats(h);
    head.querySelector('.task-del:not(.st-btn)').onclick = () => {
      if (!confirm(`"${h.name}" зуршлыг устгах уу?`)) return;
      state.habits = state.habits.filter(x => x.id !== h.id); save(); render(); toast('Зуршил устлаа');
    };
    card.appendChild(head);

    const week = document.createElement('div');
    week.className = 'habit-week';
    days.forEach(d => {
      const key = ymd(d);
      const isFuture = key > t;
      const box = document.createElement('div');
      box.className = 'habit-day';
      box.innerHTML = `<div class="hd-wd">${WD_SHORT[d.getDay()]}</div>
        <div class="hd-box ${h.history[key] ? 'done' : ''} ${isFuture ? 'future' : ''} ${key === t ? 'today' : ''}">✓</div>`;
      if (!isFuture) box.querySelector('.hd-box').onclick = () => toggleHabit(h.id, key);
      week.appendChild(box);
    });
    card.appendChild(week);
    cont.appendChild(card);
  });
}

/* ============================================================
   REMINDERS
   ============================================================ */
function sortRem(a, b) { return (a.time || '') > (b.time || '') ? 1 : -1; }

const REPEAT_LABEL = { none: 'Нэг удаа', daily: 'Өдөр бүр', weekly: 'Долоо хоног бүр' };

function renderReminders() {
  const list = document.getElementById('reminder-list');
  list.innerHTML = '';
  const sorted = [...state.reminders].sort(sortRem);
  sorted.forEach(r => list.appendChild(reminderNode(r, false)));
  document.getElementById('reminder-empty').hidden = state.reminders.length > 0;

  // notification permission notice
  const notice = document.getElementById('notif-notice');
  notice.hidden = !('Notification' in window) || Notification.permission === 'granted';
}

function reminderNode(r, compact) {
  const li = document.createElement('li');
  li.className = 'reminder-item';
  let when = REPEAT_LABEL[r.repeat] || '';
  if (r.repeat === 'none' && r.date) when = fmtHuman(r.date);
  li.innerHTML = `
    <div class="rem-icon">${r.enabled ? '🔔' : '🔕'}</div>
    <div class="rem-main">
      <div class="rem-title">${esc(r.title)}</div>
      <div class="rem-meta">🕐 ${r.time} · ${when}</div>
    </div>
    ${compact ? '' : `<label class="switch"><input type="checkbox" ${r.enabled ? 'checked' : ''}/><span class="slider"></span></label>`}`;
  if (!compact) {
    li.querySelector('input').onchange = (e) => { r.enabled = e.target.checked; save(); render(); };
    li.querySelector('.rem-main').onclick = () => openReminderModal(r);
    // long press / context to delete
    let press;
    li.querySelector('.rem-icon').onclick = () => {
      if (confirm('Энэ сэрүүлгийг устгах уу?')) {
        state.reminders = state.reminders.filter(x => x.id !== r.id); save(); render();
      }
    };
  }
  return li;
}

/* ============================================================
   MODALS  (add / edit)
   ============================================================ */
const overlay = document.getElementById('modal-overlay');
const modalBody = document.getElementById('modal-body');
const modalTitle = document.getElementById('modal-title');

function openModal() { overlay.hidden = false; }
function closeModal() { overlay.hidden = true; modalBody.innerHTML = ''; }
document.getElementById('modal-close').onclick = closeModal;
overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

/* ---- Task modal ---- */
function openTaskModal(task) {
  const editing = !!task;
  modalTitle.textContent = editing ? 'Даалгавар засах' : 'Шинэ даалгавар';
  const prio = task ? task.priority : 'med';
  const curCat = task ? (task.category || 'other') : 'personal';
  modalBody.innerHTML = `
    <div class="field"><label>Гарчиг</label>
      <input id="f-title" placeholder="Жишээ: Англи хэл сурах" value="${task ? esc(task.title) : ''}"/></div>
    <div class="field"><label>Ангилал</label>
      <div class="cat-pick" id="f-cat">
        ${TASK_CATS.map(c => `<button data-v="${c.key}" class="${curCat === c.key ? 'active' : ''}">${c.icon} ${c.label}</button>`).join('')}
      </div></div>
    <div class="field"><label>Эцсийн хугацаа / deadline (заавал биш)</label>
      <input id="f-date" type="date" value="${task ? (task.date || '') : selectedDate}"/></div>
    <div class="field"><label>Цаг (заавал биш)</label>
      <input id="f-time" type="time" value="${task ? (task.time || '') : ''}"/></div>
    <div class="field"><label>Чухал байдал</label>
      <div class="seg" id="f-prio">
        <button data-v="high" class="${prio === 'high' ? 'active' : ''}">Чухал</button>
        <button data-v="med" class="${prio === 'med' ? 'active' : ''}">Дунд</button>
        <button data-v="low" class="${prio === 'low' ? 'active' : ''}">Бага</button>
      </div></div>
    <div class="field"><label>Тэмдэглэл (заавал биш)</label>
      <textarea id="f-note" placeholder="Нэмэлт мэдээлэл...">${task ? esc(task.note || '') : ''}</textarea></div>
    <button class="btn-primary" id="f-save">${editing ? 'Хадгалах' : 'Нэмэх'}</button>`;
  segHandler('f-prio');
  segHandler('f-cat');
  document.getElementById('f-save').onclick = () => {
    const title = val('f-title').trim();
    if (!title) { toast('Гарчиг оруулна уу'); return; }
    const data = {
      title, date: val('f-date'), time: val('f-time'),
      priority: segVal('f-prio'), category: segVal('f-cat'), note: val('f-note').trim()
    };
    if (editing) Object.assign(task, data);
    else state.tasks.push(Object.assign({ id: uid(), done: false }, data));
    save(); closeModal(); render(); toast(editing ? 'Хадгаллаа' : 'Даалгавар нэмлээ');
  };
  openModal();
}

/* ---- Habit modal ---- */
const HABIT_ICONS = ['💧', '🏃', '📚', '🧘', '💪', '🥗', '😴', '🚭', '✍️', '🎯', '🧹', '💊'];
function openHabitModal() {
  modalTitle.textContent = 'Шинэ зуршил';
  modalBody.innerHTML = `
    <div class="field"><label>Зуршлын нэр</label>
      <input id="f-name" placeholder="Жишээ: Ус уух"/></div>
    <div class="field"><label>Дүрс сонгох</label>
      <div class="emoji-row" id="f-icon">
        ${HABIT_ICONS.map((e, i) => `<button data-v="${e}" class="${i === 0 ? 'active' : ''}">${e}</button>`).join('')}
      </div></div>
    <button class="btn-primary" id="f-save">Нэмэх</button>`;
  emojiHandler('f-icon');
  document.getElementById('f-save').onclick = () => {
    const name = val('f-name').trim();
    if (!name) { toast('Нэр оруулна уу'); return; }
    state.habits.push({ id: uid(), name, icon: emojiVal('f-icon'), history: {} });
    save(); closeModal(); render(); toast('Зуршил нэмлээ');
  };
  openModal();
}

/* ---- Habit stats modal (monthly heatmap) ---- */
let statsMonth = new Date();
function openHabitStats(h) {
  statsMonth = new Date();
  renderHabitStats(h);
  openModal();
}
function renderHabitStats(h) {
  const s = habitStats(h);
  modalTitle.textContent = `${h.icon} ${h.name}`;
  const y = statsMonth.getFullYear(), m = statsMonth.getMonth();
  const startPad = monIdx(new Date(y, m, 1));
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const t = todayYmd();
  let cells = '';
  for (let i = 0; i < startPad; i++) cells += `<div class="heat-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = ymd(new Date(y, m, day));
    const done = !!h.history[key];
    cells += `<div class="heat-cell ${done ? 'done' : ''} ${key === t ? 'today' : ''}">${day}</div>`;
  }
  modalBody.innerHTML = `
    <div class="stat-grid">
      <div class="stat-tile"><div class="st-num">🔥 ${s.current}</div><div class="st-lbl">Одоогийн цуваа</div></div>
      <div class="stat-tile"><div class="st-num">🏆 ${s.best}</div><div class="st-lbl">Дээд цуваа</div></div>
      <div class="stat-tile"><div class="st-num">✅ ${s.total}</div><div class="st-lbl">Нийт хийсэн</div></div>
      <div class="stat-tile"><div class="st-num">📈 ${s.monthPct}%</div><div class="st-lbl">Энэ сар (${s.monthDone} өдөр)</div></div>
    </div>
    <div class="heat-head">
      <button class="heat-nav" id="heat-prev">‹</button>
      <span class="hh-title">${y} он, ${MONTHS[m]}</span>
      <button class="heat-nav" id="heat-next">›</button>
    </div>
    <div class="heat-weekdays"><span>Да</span><span>Мя</span><span>Лх</span><span>Пү</span><span>Ба</span><span>Бя</span><span>Ня</span></div>
    <div class="heat-grid">${cells}</div>`;
  document.getElementById('heat-prev').onclick = () => { statsMonth.setMonth(statsMonth.getMonth() - 1); renderHabitStats(h); };
  document.getElementById('heat-next').onclick = () => { statsMonth.setMonth(statsMonth.getMonth() + 1); renderHabitStats(h); };
}

/* ---- Reminder modal ---- */
function openReminderModal(rem) {
  const editing = !!rem;
  modalTitle.textContent = editing ? 'Сэрүүлэг засах' : 'Шинэ сэрүүлэг';
  const rep = rem ? rem.repeat : 'daily';
  modalBody.innerHTML = `
    <div class="field"><label>Нэр</label>
      <input id="f-title" placeholder="Жишээ: Эм уух" value="${rem ? esc(rem.title) : ''}"/></div>
    <div class="field"><label>Цаг</label>
      <input id="f-time" type="time" value="${rem ? rem.time : '08:00'}"/></div>
    <div class="field"><label>Давталт</label>
      <div class="seg" id="f-rep">
        <button data-v="none" class="${rep === 'none' ? 'active' : ''}">Нэг удаа</button>
        <button data-v="daily" class="${rep === 'daily' ? 'active' : ''}">Өдөр бүр</button>
        <button data-v="weekly" class="${rep === 'weekly' ? 'active' : ''}">7 хоног</button>
      </div></div>
    <div class="field" id="date-field" ${rep === 'none' ? '' : 'hidden'}><label>Огноо</label>
      <input id="f-date" type="date" value="${rem && rem.date ? rem.date : todayYmd()}"/></div>
    <button class="btn-primary" id="f-save">${editing ? 'Хадгалах' : 'Нэмэх'}</button>`;
  segHandler('f-rep', (v) => {
    document.getElementById('date-field').hidden = (v !== 'none');
  });
  document.getElementById('f-save').onclick = () => {
    const title = val('f-title').trim();
    if (!title) { toast('Нэр оруулна уу'); return; }
    const repeat = segVal('f-rep');
    const data = {
      title, time: val('f-time'), repeat,
      date: repeat === 'none' ? val('f-date') : null,
    };
    if (editing) Object.assign(rem, data);
    else state.reminders.push(Object.assign({ id: uid(), enabled: true, lastFired: null }, data));
    save(); closeModal(); render();
    requestNotifPermission();
    toast(editing ? 'Хадгаллаа' : 'Сэрүүлэг нэмлээ');
  };
  openModal();
}

/* ---- FAB: context-aware add ---- */
document.getElementById('fab').onclick = () => {
  if (currentView === 'habits') openHabitModal();
  else if (currentView === 'reminders') openReminderModal(null);
  else if (currentView === 'finance') openFinanceModal(null);
  else if (currentView === 'calendar') { selectedDate = calSelected; openTaskModal(null); }
  else openTaskModal(null);
};

/* ============================================================
   Small UI helpers
   ============================================================ */
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function segHandler(id, cb) {
  const wrap = document.getElementById(id);
  wrap.querySelectorAll('button').forEach(b => b.onclick = () => {
    wrap.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); if (cb) cb(b.dataset.v);
  });
}
function segVal(id) { const a = document.querySelector(`#${id} button.active`); return a ? a.dataset.v : ''; }
function emojiHandler(id) { segHandler(id); }
function emojiVal(id) { return segVal(id); }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

/* ============================================================
   WEATHER  (Open-Meteo — no API key required)
   ============================================================ */
const WX_KEY = 'tuslakh-weather-v1';
const WX_TTL = 30 * 60 * 1000; // 30 min
let wxFetching = false;

const WX_CODES = {
  0: ['☀️', 'Цэлмэг'], 1: ['🌤️', 'Багавтар үүлтэй'], 2: ['⛅', 'Үүлэрхэг'], 3: ['☁️', 'Бүрхэг'],
  45: ['🌫️', 'Манантай'], 48: ['🌫️', 'Манантай'],
  51: ['🌦️', 'Шиврээ бороо'], 53: ['🌦️', 'Шиврээ бороо'], 55: ['🌦️', 'Шиврээ бороо'],
  56: ['🌧️', 'Хүйтэн шиврээ'], 57: ['🌧️', 'Хүйтэн шиврээ'],
  61: ['🌧️', 'Бороотой'], 63: ['🌧️', 'Бороотой'], 65: ['🌧️', 'Их бороотой'],
  66: ['🌧️', 'Хүйтэн бороо'], 67: ['🌧️', 'Хүйтэн бороо'],
  71: ['🌨️', 'Цастай'], 73: ['🌨️', 'Цастай'], 75: ['❄️', 'Их цастай'], 77: ['🌨️', 'Цас'],
  80: ['🌧️', 'Аадар бороо'], 81: ['🌧️', 'Аадар бороо'], 82: ['⛈️', 'Их аадар'],
  85: ['🌨️', 'Цас орно'], 86: ['❄️', 'Их цас'],
  95: ['⛈️', 'Аянга цахилгаан'], 96: ['⛈️', 'Аянга, мөндөр'], 99: ['⛈️', 'Аянга, мөндөр'],
};
const wxInfo = (c) => WX_CODES[c] || ['🌡️', '—'];

function loadWx() { try { return JSON.parse(localStorage.getItem(WX_KEY)); } catch (e) { return null; } }
function saveWx(d) { localStorage.setItem(WX_KEY, JSON.stringify(d)); }

function ensureWeather() {
  const cached = loadWx();
  if (cached) renderWeather(cached);
  else renderWeatherMsg('🌦️ Цаг агаарыг харахын тулд дарна уу', true);
  // refresh if stale & online
  if (navigator.onLine && (!cached || (Date.now() - cached.ts) > WX_TTL)) fetchWeather();
}

function renderWeatherMsg(html, dark) {
  const card = document.getElementById('weather-card');
  if (!card) return;
  card.className = 'weather-card' + (dark ? ' empty-state' : '');
  card.innerHTML = `<div class="wx-msg ${dark ? 'dark' : ''}"><span>${html}</span>
    <button class="mini-btn" id="wx-retry">Шинэчлэх</button></div>`;
  const btn = document.getElementById('wx-retry');
  if (btn) btn.onclick = () => fetchWeather(true);
}

function fetchWeather(force) {
  if (wxFetching) return;
  if (!('geolocation' in navigator)) { renderWeatherMsg('📍 Байршил тодорхойлох боломжгүй', true); return; }
  if (!navigator.onLine) { if (!loadWx()) renderWeatherMsg('📡 Интернэт холболт алга', true); return; }
  wxFetching = true;
  renderWeatherMsg('⏳ Цаг агаарыг ачааллаж байна...', true);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude: lat, longitude: lon } = pos.coords;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min` +
        `&timezone=auto&forecast_days=4`;
      const res = await fetch(url);
      const j = await res.json();
      let city = '';
      try {
        const g = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=mn`);
        const gj = await g.json();
        city = gj.city || gj.locality || gj.principalSubdivision || '';
      } catch (e) { /* optional */ }
      const data = {
        ts: Date.now(), city,
        temp: Math.round(j.current.temperature_2m),
        code: j.current.weather_code,
        daily: (j.daily.time || []).map((t, i) => ({
          date: t, code: j.daily.weather_code[i],
          max: Math.round(j.daily.temperature_2m_max[i]),
          min: Math.round(j.daily.temperature_2m_min[i]),
        })),
      };
      saveWx(data); renderWeather(data);
    } catch (e) {
      const c = loadWx(); if (c) renderWeather(c); else renderWeatherMsg('⚠️ Цаг агаар авч чадсангүй', true);
    } finally { wxFetching = false; }
  }, (err) => {
    wxFetching = false;
    const c = loadWx();
    if (c) renderWeather(c);
    else renderWeatherMsg('📍 Байршлын зөвшөөрөл хэрэгтэй', true);
  }, { timeout: 10000, maximumAge: 600000 });
}

function renderWeather(d) {
  const card = document.getElementById('weather-card');
  if (!card) return;
  const [ico, cond] = wxInfo(d.code);
  const today = d.daily && d.daily[0];
  const hl = today ? `↑${today.max}° ↓${today.min}°` : '';
  const fc = (d.daily || []).map((day, i) => {
    const [di] = wxInfo(day.code);
    const wd = i === 0 ? 'Өнөөдөр' : WD_SHORT[parseYmd(day.date).getDay()];
    return `<div class="wx-day"><div class="wd">${wd}</div><div class="wi">${di}</div><div class="wt">${day.max}°</div></div>`;
  }).join('');
  card.className = 'weather-card';
  card.innerHTML = `
    <div class="wx-top">
      <span class="wx-ico">${ico}</span>
      <div class="wx-info">
        <div class="wx-temp">${d.temp}°</div>
        <div class="wx-cond">${cond}</div>
        ${d.city ? `<div class="wx-place">📍 ${esc(d.city)}</div>` : ''}
      </div>
      <div class="wx-hl">${hl}</div>
    </div>
    ${fc ? `<div class="wx-forecast">${fc}</div>` : ''}`;
  card.onclick = (e) => { if (e.target.id !== 'wx-retry') fetchWeather(true); };
}

/* ============================================================
   NOTIFICATIONS & ALARM ENGINE
   ============================================================ */
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(() => render());
  }
}
document.getElementById('enable-notif').onclick = requestNotifPermission;

// Web Audio beep (no asset needed)
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      const start = now + i * 0.5;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.4, start + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(start); o.stop(start + 0.4);
    }
  } catch (e) { /* ignore */ }
}

function fireReminder(r) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('🔔 ' + r.title, {
        body: `Цаг боллоо — ${r.time}`,
        icon: 'icons/icon.svg', tag: r.id, renotify: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* some browsers need SW notifications */ }
  }
  beep();
  toast('🔔 ' + r.title);
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

// Check every 20s for due reminders
function checkReminders() {
  const now = new Date();
  const nowKey = ymd(now);
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const minuteTag = nowKey + ' ' + hhmm;

  state.reminders.forEach(r => {
    if (!r.enabled || r.time !== hhmm) return;
    if (r.lastFired === minuteTag) return;            // already fired this minute

    let due = false;
    if (r.repeat === 'daily') due = true;
    else if (r.repeat === 'weekly') {
      // weekly anchored to its creation/edit weekday is complex; fire same weekday as today's match — simple: every 7 days from date if set, else any matching weekday
      due = true; // fire weekly on the configured weekday
      if (r.date) {
        const anchor = parseYmd(r.date);
        const diffDays = Math.round((parseYmd(nowKey) - anchor) / 86400000);
        due = diffDays >= 0 && diffDays % 7 === 0;
      }
    } else { // none
      due = r.date === nowKey;
    }

    if (due) {
      r.lastFired = minuteTag;
      if (r.repeat === 'none') r.enabled = false; // one-shot auto-off
      save();
      fireReminder(r);
      if (currentView === 'reminders' || currentView === 'today') render();
    }
  });
}

/* ============================================================
   FINANCE  (cash, loans, receivables, payables, future income)
   ============================================================ */
const FIN_KINDS = [
  { key: 'cash', label: 'Бэлэн мөнгө / Хадгаламж', short: 'Мөнгө', icon: '💵', sign: +1, group: 'asset' },
  { key: 'receivable', label: 'Авлага (надад өгөх)', short: 'Авлага', icon: '📥', sign: +1, group: 'asset' },
  { key: 'loan', label: 'Зээл', short: 'Зээл', icon: '🏦', sign: -1, group: 'liability' },
  { key: 'payable', label: 'Өр төлбөр (би өгөх)', short: 'Өр', icon: '📤', sign: -1, group: 'liability' },
  { key: 'income', label: 'Ирээдүйн орлого', short: 'Орлого', icon: '📈', sign: +1, group: 'future' },
];
const finKind = (k) => FIN_KINDS.find(x => x.key === k) || FIN_KINDS[0];
let finFilter = 'all';

function finTotals() {
  const t = { cash: 0, receivable: 0, loan: 0, payable: 0, income: 0 };
  state.finance.forEach(f => { t[f.kind] = (t[f.kind] || 0) + Number(f.amount || 0); });
  const assets = t.cash + t.receivable;
  const liab = t.loan + t.payable;
  return Object.assign(t, { assets, liab, net: assets - liab });
}

function renderFinance() {
  const tot = finTotals();
  const sum = document.getElementById('fin-summary');
  sum.className = 'fin-summary' + (tot.net < 0 ? ' neg' : '');
  sum.innerHTML = `
    <div class="fin-net-label">Цэвэр үлдэгдэл (хөрөнгө − өр)</div>
    <div class="fin-net">${money(tot.net)}</div>
    <div class="fin-ab">
      <div class="fab-tile"><div class="fab-num">${money(tot.assets)}</div><div class="fab-lbl">Хөрөнгө</div></div>
      <div class="fab-tile"><div class="fab-num">${money(tot.liab)}</div><div class="fab-lbl">Өр төлбөр</div></div>
    </div>
    ${tot.income ? `<div class="fin-future">📈 Ирээдүйд олох орлого: ${money(tot.income)}</div>` : ''}`;

  const ff = document.getElementById('fin-filter');
  ff.className = 'cat-filter';
  ff.innerHTML = `<button class="chip ${finFilter === 'all' ? 'active' : ''}" data-k="all">Бүгд</button>` +
    FIN_KINDS.map(k => `<button class="chip ${finFilter === k.key ? 'active' : ''}" data-k="${k.key}">${k.icon} ${k.short}</button>`).join('');
  ff.querySelectorAll('.chip').forEach(b => b.onclick = () => { finFilter = b.dataset.k; renderFinance(); });

  const groups = document.getElementById('fin-groups');
  groups.innerHTML = '';
  const kinds = finFilter === 'all' ? FIN_KINDS : FIN_KINDS.filter(k => k.key === finFilter);
  kinds.forEach(k => {
    const items = state.finance.filter(f => f.kind === k.key);
    if (!items.length) return;
    const total = items.reduce((s, f) => s + Number(f.amount || 0), 0);
    const g = document.createElement('div');
    g.className = 'fin-group';
    g.innerHTML = `<div class="fg-head"><span class="fg-title">${k.icon} ${k.label}</span>
      <span class="fg-total" style="color:${k.sign > 0 ? 'var(--green)' : 'var(--red)'}">${k.sign > 0 ? '+' : '−'}${money(total)}</span></div>`;
    items.sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1);
    items.forEach(f => g.appendChild(finNode(f, k)));
    groups.appendChild(g);
  });
  document.getElementById('fin-empty').hidden = state.finance.length > 0;
}

function finNode(f, k) {
  const div = document.createElement('div');
  div.className = 'fin-item';
  const dlabel = f.date ? (k.sign < 0 ? '🗓️ Төлөх: ' : '🗓️ ') + fmtHuman(f.date) : '';
  const sub = [dlabel, f.note].filter(Boolean).join(' · ');
  div.innerHTML = `
    <span class="fi-ico">${k.icon}</span>
    <div class="fi-main"><div class="fi-title">${esc(f.title)}</div>${sub ? `<div class="fi-sub">${esc(sub)}</div>` : ''}</div>
    <div class="fi-amount ${k.sign > 0 ? 'pos' : 'neg'}">${k.sign > 0 ? '+' : '−'}${money(Number(f.amount || 0))}</div>`;
  div.onclick = () => openFinanceModal(f);
  return div;
}

function openFinanceModal(item) {
  const editing = !!item;
  modalTitle.textContent = editing ? 'Бичлэг засах' : 'Шинэ санхүүгийн бичлэг';
  let kind = item ? item.kind : 'cash';
  modalBody.innerHTML = `
    <div class="field"><label>Төрөл</label>
      <div class="cat-pick" id="fin-kind">
        ${FIN_KINDS.map(k => `<button data-v="${k.key}" class="${kind === k.key ? 'active' : ''}">${k.icon} ${k.short}</button>`).join('')}
      </div></div>
    <div class="field"><label>Нэр</label><input id="fin-title" value="${editing ? esc(item.title) : ''}" placeholder="Жишээ: Хаан банкны зээл"/></div>
    <div class="field"><label>Дүн (₮)</label><input id="fin-amount" type="number" inputmode="numeric" value="${editing ? item.amount : ''}" placeholder="0"/></div>
    <div class="field"><label>Огноо / төлөх хугацаа (заавал биш)</label><input id="fin-date" type="date" value="${editing ? (item.date || '') : ''}"/></div>
    <div class="field"><label>Тэмдэглэл (заавал биш)</label><textarea id="fin-note" placeholder="Жишээ: сарын хүү, хэнээс/хэнд гэх мэт...">${editing ? esc(item.note || '') : ''}</textarea></div>
    <button class="btn-primary" id="fin-save">${editing ? 'Хадгалах' : 'Нэмэх'}</button>
    ${editing ? `<button class="btn-primary" id="fin-del" style="background:rgba(255,94,126,0.15);color:var(--red);margin-top:10px">Устгах</button>` : ''}`;
  segHandler('fin-kind', v => { kind = v; });
  document.getElementById('fin-save').onclick = () => {
    const title = val('fin-title').trim();
    const amount = parseFloat(val('fin-amount'));
    if (!title) { toast('Нэр оруулна уу'); return; }
    if (isNaN(amount) || amount < 0) { toast('Зөв дүн оруулна уу'); return; }
    const data = { kind, title, amount, date: val('fin-date'), note: val('fin-note').trim() };
    if (editing) Object.assign(item, data);
    else state.finance.push(Object.assign({ id: uid() }, data));
    save(); closeModal(); render(); toast(editing ? 'Хадгаллаа' : 'Бичлэг нэмлээ');
  };
  const del = document.getElementById('fin-del');
  if (del) del.onclick = () => {
    if (!confirm('Энэ бичлэгийг устгах уу?')) return;
    state.finance = state.finance.filter(x => x.id !== item.id);
    save(); closeModal(); render(); toast('Устгалаа');
  };
  openModal();
}

function renderTodayFinance() {
  const fin = document.getElementById('today-finance');
  if (!fin) return;
  if (!state.finance.length) {
    fin.innerHTML = `<div class="fin-mini" id="fin-mini"><span class="fm-ico">💰</span>
      <div class="fm-main"><div class="fm-label">Санхүүгийн бүртгэл хоосон</div><div class="fm-net">Нэмж эхлэх →</div></div></div>`;
  } else {
    const tot = finTotals();
    fin.innerHTML = `<div class="fin-mini" id="fin-mini"><span class="fm-ico">💰</span>
      <div class="fm-main"><div class="fm-label">Цэвэр үлдэгдэл</div>
      <div class="fm-net ${tot.net < 0 ? 'neg' : 'pos'}">${money(tot.net)}</div></div>
      <span style="color:var(--muted);font-size:18px">›</span></div>`;
  }
  document.getElementById('fin-mini').onclick = () => switchView('finance');
}

/* ============================================================
   AUTH SCREEN  (login / first-run setup)
   ============================================================ */
const authScreen = document.getElementById('auth-screen');
let authMode = 'login';

function showAuth(mode) {
  authMode = mode;
  renderAuth();
  authScreen.hidden = false;
  document.body.style.overflow = 'hidden';
}
function hideAuth() { authScreen.hidden = true; document.body.style.overflow = ''; }

function renderAuth(err) {
  const setup = authMode === 'setup';
  authScreen.innerHTML = `
    <div class="auth-box">
      <div class="auth-logo">
        <div class="al-ico">🗂️</div>
        <h2>Миний Туслах</h2>
        <p>${setup ? 'Эхний админ хэрэглэгчээ үүсгэнэ үү' : 'Тавтай морил! Нэвтэрнэ үү'}</p>
      </div>
      <div class="auth-card">
        <h3>${setup ? 'Бүртгэл үүсгэх' : 'Нэвтрэх'}</h3>
        ${err ? `<div class="auth-error">⚠️ ${esc(err)}</div>` : ''}
        ${setup ? `<div class="field"><label>Нэр</label><input id="au-name" placeholder="Таны нэр"/></div>` : ''}
        <div class="field"><label>Хэрэглэгчийн нэр</label><input id="au-user" placeholder="username" autocapitalize="off" autocomplete="username"/></div>
        <div class="field"><label>Нууц үг</label><input id="au-pass" type="password" placeholder="••••••" autocomplete="${setup ? 'new-password' : 'current-password'}"/></div>
        ${setup ? `<div class="field"><label>Нууц үг давтах</label><input id="au-pass2" type="password" placeholder="••••••"/></div>` : ''}
        <button class="btn-primary" id="au-submit">${setup ? 'Үүсгэх' : 'Нэвтрэх'}</button>
      </div>
    </div>`;
  const submit = setup ? doSetup : doLogin;
  document.getElementById('au-submit').onclick = submit;
  authScreen.querySelectorAll('input').forEach(i =>
    i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}

async function doSetup() {
  const name = val('au-name').trim();
  const username = val('au-user').trim().toLowerCase();
  const pass = val('au-pass'), pass2 = val('au-pass2');
  if (!name) return renderAuth('Нэрээ оруулна уу');
  if (username.length < 3) return renderAuth('Хэрэглэгчийн нэр доод тал нь 3 тэмдэгт');
  if (pass.length < 4) return renderAuth('Нууц үг доод тал нь 4 тэмдэгт');
  if (pass !== pass2) return renderAuth('Нууц үг таарахгүй байна');
  const salt = randSalt();
  const passHash = await hashPw(pass, salt);
  const u = { id: uid(), username, name, salt, passHash, role: 'admin', perms: [...PERM_KEYS], createdAt: todayYmd() };
  auth.users.push(u); saveAuth();
  // migrate any pre-auth data to the first admin
  try {
    const legacy = localStorage.getItem(LEGACY_DATA_KEY);
    if (legacy && !localStorage.getItem(dataKey(u.id))) localStorage.setItem(dataKey(u.id), legacy);
  } catch (e) { /* ignore */ }
  enterApp(u);
}

async function doLogin() {
  const username = val('au-user').trim().toLowerCase();
  const pass = val('au-pass');
  const u = auth.users.find(x => x.username === username);
  if (!u) return renderAuth('Хэрэглэгч олдсонгүй');
  const h = await hashPw(pass, u.salt);
  if (h !== u.passHash) return renderAuth('Нууц үг буруу байна');
  enterApp(u);
}

/* ---------- Enter / leave the app ---------- */
let engineStarted = false;
function enterApp(u) {
  currentUser = u;
  auth.currentUserId = u.id; saveAuth();
  state = load(); seedIfEmpty(); save();
  hideAuth();
  applyPermissions();
  updateAvatar();
  switchView('today');
  updateInstallBanner();
  startEngine();
}
function startEngine() {
  if (engineStarted) return;
  engineStarted = true;
  checkReminders();
  setInterval(checkReminders, 20000);
}
function logout() {
  auth.currentUserId = null; saveAuth();
  currentUser = null; state = defaultState();
  document.getElementById('fab').hidden = true;
  closeModal();
  showAuth('login');
}

/* ---------- Permissions UI ---------- */
function applyPermissions() {
  document.querySelectorAll('.tab').forEach(t => {
    const v = t.dataset.view;
    t.hidden = PERM_KEYS.includes(v) && !can(v);
  });
  document.querySelectorAll('#view-today [data-perm]').forEach(el => {
    el.hidden = !can(el.dataset.perm);
  });
}
function updateAvatar() {
  document.getElementById('avatar-btn').textContent = currentUser ? initials(currentUser.name) : '?';
}

/* ============================================================
   PROFILE & USER MANAGEMENT
   ============================================================ */
function renderProfile() {
  const u = currentUser, isAdmin = u.role === 'admin';
  const v = document.getElementById('view-profile');
  let html = `
    <div class="profile-card">
      <div class="pc-avatar">${initials(u.name)}</div>
      <div class="pc-name">${esc(u.name)}</div>
      <div class="pc-user">@${esc(u.username)}</div>
      <span class="role-badge ${isAdmin ? 'role-admin' : 'role-user'}">${isAdmin ? '👑 Админ' : 'Хэрэглэгч'}</span>
    </div>
    <div class="settings-group">
      <div class="sg-title">Бүртгэл</div>
      <div class="settings-row" id="pf-pass">
        <span class="sr-ico">🔑</span><div class="sr-main"><div class="sr-label">Нууц үг солих</div></div><span class="sr-arrow">›</span>
      </div>
      <div class="settings-row danger" id="pf-logout">
        <span class="sr-ico">🚪</span><div class="sr-main"><div class="sr-label">Гарах</div><div class="sr-sub">@${esc(u.username)}</div></div>
      </div>
    </div>
    <div class="settings-group">
      <div class="sg-title">Өгөгдөл</div>
      <div class="settings-row" id="pf-export">
        <span class="sr-ico">📤</span><div class="sr-main"><div class="sr-label">Нөөцлөх</div><div class="sr-sub">Бүх өгөгдлөө JSON файл болгон татах</div></div><span class="sr-arrow">›</span>
      </div>
      <div class="settings-row" id="pf-import">
        <span class="sr-ico">📥</span><div class="sr-main"><div class="sr-label">Сэргээх</div><div class="sr-sub">Нөөц файлаас өгөгдлөө буцааж ачаалах</div></div><span class="sr-arrow">›</span>
      </div>
    </div>`;
  if (isAdmin) {
    html += `<div class="section-head"><h2>Хэрэглэгчид (${auth.users.length})</h2>
      <button class="link-btn" id="pf-adduser">+ Нэмэх</button></div>
      <div id="pf-users">${auth.users.map(userRowHtml).join('')}</div>`;
  }
  v.innerHTML = html;
  document.getElementById('pf-pass').onclick = openChangePw;
  document.getElementById('pf-logout').onclick = () => { if (confirm('Системээс гарах уу?')) logout(); };
  document.getElementById('pf-export').onclick = exportData;
  document.getElementById('pf-import').onclick = importData;
  if (isAdmin) {
    document.getElementById('pf-adduser').onclick = () => openUserModal(null);
    auth.users.forEach(x => {
      const row = document.getElementById('user-' + x.id);
      if (row) row.onclick = () => openUserModal(x);
    });
  }
}
function userRowHtml(x) {
  const isAdmin = x.role === 'admin';
  const me = x.id === currentUser.id;
  const sub = isAdmin ? 'Бүх хэсэгт хандана' : `${(x.perms || []).length} хэсэгт хандана`;
  return `<div class="user-row" id="user-${x.id}">
    <div class="ur-avatar">${initials(x.name)}</div>
    <div class="ur-main">
      <div class="ur-name">${esc(x.name)}${me ? ' <span style="color:var(--muted);font-weight:400;font-size:12px">(та)</span>' : ''}</div>
      <div class="ur-sub">@${esc(x.username)} · ${sub}</div>
    </div>
    <span class="role-badge ${isAdmin ? 'role-admin' : 'role-user'}">${isAdmin ? 'Админ' : 'Хэрэглэгч'}</span>
  </div>`;
}

/* ---- Backup / Restore (current user's data) ---- */
function exportData() {
  const payload = {
    app: 'minii-tuslakh', version: 1,
    exportedAt: new Date().toISOString(),
    user: { username: currentUser.username, name: currentUser.name },
    data: state,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `minii-tuslakh-${currentUser.username}-${todayYmd()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('📤 Өгөгдөл татагдлаа');
}

// Validate + apply a parsed backup object. Returns true on success.
function restoreFromObject(obj) {
  const d = (obj && obj.data) ? obj.data : obj;
  if (!d || (!Array.isArray(d.tasks) && !Array.isArray(d.habits) && !Array.isArray(d.reminders))) return false;
  state = Object.assign(defaultState(), {
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    habits: Array.isArray(d.habits) ? d.habits : [],
    reminders: Array.isArray(d.reminders) ? d.reminders : [],
  });
  save();
  return true;
}

function importData() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let obj;
      try { obj = JSON.parse(reader.result); }
      catch (e) { toast('⚠️ Файлыг уншиж чадсангүй'); return; }
      const counts = obj.data || obj;
      const n = (Array.isArray(counts.tasks) ? counts.tasks.length : 0)
        + (Array.isArray(counts.habits) ? counts.habits.length : 0)
        + (Array.isArray(counts.reminders) ? counts.reminders.length : 0);
      if (!n && !Array.isArray(counts.tasks)) { toast('⚠️ Буруу нөөц файл'); return; }
      if (!confirm('Одоогийн өгөгдлийг энэ нөөцөөр солих уу? Энэ үйлдлийг буцаах боломжгүй.')) return;
      if (restoreFromObject(obj)) { render(); toast('📥 Өгөгдөл сэргээгдлээ'); }
      else toast('⚠️ Буруу нөөц файл');
    };
    reader.readAsText(file);
  };
  inp.click();
}

function openChangePw() {
  modalTitle.textContent = 'Нууц үг солих';
  modalBody.innerHTML = `
    <div class="field"><label>Одоогийн нууц үг</label><input id="cp-old" type="password"/></div>
    <div class="field"><label>Шинэ нууц үг</label><input id="cp-new" type="password"/></div>
    <div class="field"><label>Шинэ нууц үг давтах</label><input id="cp-new2" type="password"/></div>
    <button class="btn-primary" id="cp-save">Хадгалах</button>`;
  document.getElementById('cp-save').onclick = async () => {
    const old = val('cp-old'), nw = val('cp-new'), nw2 = val('cp-new2');
    const h = await hashPw(old, currentUser.salt);
    if (h !== currentUser.passHash) { toast('Одоогийн нууц үг буруу'); return; }
    if (nw.length < 4) { toast('Шинэ нууц үг доод тал нь 4 тэмдэгт'); return; }
    if (nw !== nw2) { toast('Нууц үг таарахгүй байна'); return; }
    currentUser.salt = randSalt();
    currentUser.passHash = await hashPw(nw, currentUser.salt);
    saveAuth(); closeModal(); toast('Нууц үг солигдлоо');
  };
  openModal();
}

function openUserModal(user) {
  const editing = !!user;
  const isSelf = editing && user.id === currentUser.id;
  modalTitle.textContent = editing ? 'Хэрэглэгч засах' : 'Шинэ хэрэглэгч';
  let role = editing ? user.role : 'user';
  let perms = editing ? [...(user.perms || [])] : [...PERM_KEYS];
  modalBody.innerHTML = `
    <div class="field"><label>Нэр</label><input id="us-name" value="${editing ? esc(user.name) : ''}" placeholder="Нэр"/></div>
    <div class="field"><label>Хэрэглэгчийн нэр</label><input id="us-user" value="${editing ? esc(user.username) : ''}" ${editing ? 'disabled' : ''} autocapitalize="off" placeholder="username"/></div>
    ${editing ? '' : `<div class="field"><label>Нууц үг</label><input id="us-pass" type="password" placeholder="••••••"/></div>`}
    <div class="field"><label>Эрхийн төрөл</label>
      <div class="seg" id="us-role">
        <button data-v="user" class="${role === 'user' ? 'active' : ''}">Хэрэглэгч</button>
        <button data-v="admin" class="${role === 'admin' ? 'active' : ''}">Админ</button>
      </div></div>
    <div class="field"><label>Хандах эрх</label><div class="perm-list" id="us-perms"></div></div>
    ${editing ? `<button class="btn-primary" id="us-reset" style="background:var(--card-2)">🔑 Нууц үг шинэчлэх</button>` : ''}
    <button class="btn-primary" id="us-save" style="margin-top:10px">${editing ? 'Хадгалах' : 'Үүсгэх'}</button>
    ${editing && !isSelf ? `<button class="btn-primary" id="us-del" style="background:rgba(255,94,126,0.15);color:var(--red);margin-top:10px">Хэрэглэгч устгах</button>` : ''}`;

  function renderPerms() {
    const cont = document.getElementById('us-perms');
    const adminAll = role === 'admin';
    cont.innerHTML = ALL_PERMS.map(p => {
      const on = adminAll || perms.includes(p.key);
      return `<div class="perm-item ${on ? 'on' : ''} ${adminAll ? 'locked' : ''}" data-k="${p.key}">
        <span class="pi-ico">${p.icon}</span><span class="pi-label">${p.label}</span>
        <span class="pi-check">✓</span></div>`;
    }).join('');
    if (!adminAll) {
      cont.querySelectorAll('.perm-item').forEach(el => el.onclick = () => {
        const k = el.dataset.k;
        if (perms.includes(k)) perms = perms.filter(x => x !== k); else perms.push(k);
        renderPerms();
      });
    }
  }
  renderPerms();
  segHandler('us-role', v => { role = v; renderPerms(); });

  document.getElementById('us-save').onclick = async () => {
    const name = val('us-name').trim();
    if (!name) { toast('Нэр оруулна уу'); return; }
    if (editing) {
      // guard: do not demote the last admin
      const adminCount = auth.users.filter(u => u.role === 'admin').length;
      if (user.role === 'admin' && role !== 'admin' && adminCount <= 1) { toast('Сүүлчийн админыг бууруулж болохгүй'); return; }
      user.name = name; user.role = role;
      user.perms = role === 'admin' ? [...PERM_KEYS] : perms;
      saveAuth(); closeModal();
      if (isSelf) { applyPermissions(); updateAvatar(); }
      render(); toast('Хадгаллаа');
    } else {
      const username = val('us-user').trim().toLowerCase();
      const pass = val('us-pass');
      if (username.length < 3) { toast('Хэрэглэгчийн нэр доод тал нь 3 тэмдэгт'); return; }
      if (auth.users.some(u => u.username === username)) { toast('Энэ нэр бүртгэлтэй байна'); return; }
      if (pass.length < 4) { toast('Нууц үг доод тал нь 4 тэмдэгт'); return; }
      const salt = randSalt(); const passHash = await hashPw(pass, salt);
      auth.users.push({ id: uid(), username, name, salt, passHash, role, perms: role === 'admin' ? [...PERM_KEYS] : perms, createdAt: todayYmd() });
      saveAuth(); closeModal(); render(); toast('Хэрэглэгч нэмлээ');
    }
  };

  const resetBtn = document.getElementById('us-reset');
  if (resetBtn) resetBtn.onclick = async () => {
    const np = prompt('Шинэ нууц үг (доод тал нь 4 тэмдэгт):');
    if (np === null) return;
    if (np.length < 4) { toast('Нууц үг доод тал нь 4 тэмдэгт'); return; }
    user.salt = randSalt(); user.passHash = await hashPw(np, user.salt);
    saveAuth(); toast('Нууц үг шинэчлэгдлээ');
  };

  const delBtn = document.getElementById('us-del');
  if (delBtn) delBtn.onclick = () => {
    const adminCount = auth.users.filter(u => u.role === 'admin').length;
    if (user.role === 'admin' && adminCount <= 1) { toast('Сүүлчийн админыг устгаж болохгүй'); return; }
    if (!confirm(`"${user.name}"-г устгах уу? Энэ хэрэглэгчийн бүх өгөгдөл устана.`)) return;
    localStorage.removeItem(dataKey(user.id));
    auth.users = auth.users.filter(u => u.id !== user.id);
    saveAuth(); closeModal(); render(); toast('Хэрэглэгч устлаа');
  };

  openModal();
}

/* ============================================================
   WIRE UP
   ============================================================ */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => switchView(b.dataset.goto));
document.getElementById('avatar-btn').onclick = () => switchView('profile');

// Quick add task (Today → today's date, Tasks → selected date)
function wireQuickAdd(inputId, btnId, getDate) {
  const inp = document.getElementById(inputId);
  const submit = () => {
    const title = inp.value.trim();
    if (!title) return;
    state.tasks.push({ id: uid(), title, date: getDate(), time: '', priority: 'med', category: 'personal', note: '', done: false });
    save(); inp.value = ''; render(); toast('Даалгавар нэмлээ');
    inp.focus();
  };
  document.getElementById(btnId).onclick = submit;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}
wireQuickAdd('qa-today', 'qa-today-btn', () => todayYmd());
wireQuickAdd('qa-tasks', 'qa-tasks-btn', () => selectedDate);
document.querySelectorAll('#tasks-by-day .chip').forEach(c =>
  c.onclick = () => { taskFilter = c.dataset.filter; renderTasks(); });
document.querySelectorAll('#view-tasks .ms-btn').forEach(b =>
  b.onclick = () => { taskMode = b.dataset.mode; renderTasks(); });
document.querySelectorAll('#tasks-all .chip[data-lfilter]').forEach(c =>
  c.onclick = () => { listFilter = c.dataset.lfilter; renderTaskList(); });
document.getElementById('cal-prev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); };
document.getElementById('cal-next').onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); };

// Seed sample data on very first run
function seedIfEmpty() {
  if (state.tasks.length || state.habits.length || state.reminders.length) return;
  const t = todayYmd();
  state.tasks.push(
    { id: uid(), title: 'Аппаа туршиж үзэх', date: t, time: '', priority: 'med', note: '', done: false },
    { id: uid(), title: 'Өдрийн төлөвлөгөө гаргах', date: t, time: '09:00', priority: 'high', note: '', done: false }
  );
  state.habits.push(
    { id: uid(), name: 'Ус уух', icon: '💧', history: {} },
    { id: uid(), name: 'Дасгал хийх', icon: '🏃', history: {} }
  );
  state.reminders.push(
    { id: uid(), title: 'Өглөөний дасгал', time: '07:00', repeat: 'daily', date: null, enabled: true, lastFired: null }
  );
  save();
}

// Service worker for offline / installability + auto-update
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    if (hadController) location.reload(); // reload once on UPDATE (not first install)
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update && reg.update();
    }).catch(() => {});
  });
}

/* ---------- PWA install prompt ---------- */
let deferredInstall = null;
let installDismissed = false;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isiOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function updateInstallBanner() {
  const b = document.getElementById('install-banner');
  if (!b || !currentUser) { if (b) b.hidden = true; return; }
  if (isStandalone() || installDismissed) { b.hidden = true; return; }
  const btn = document.getElementById('ib-install');
  const sub = document.getElementById('ib-sub');
  if (deferredInstall) {
    btn.hidden = false;
    sub.textContent = 'Үндсэн дэлгэцэд нэмж, тусдаа апп болгон ашиглаарай';
    b.hidden = false;
  } else if (isiOS()) {
    btn.hidden = true;
    sub.textContent = 'Safari доод талын "Хуваалцах" (⬆️) → "Add to Home Screen" дарна уу';
    b.hidden = false;
  } else {
    // Android/desktop where the auto-prompt has not fired — show manual steps
    btn.hidden = true;
    sub.textContent = 'Хөтчийн ⋮ цэс → "Install app / Add to Home screen" дарна уу';
    b.hidden = false;
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  updateInstallBanner();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  const b = document.getElementById('install-banner');
  if (b) b.hidden = true;
  toast('✅ Апп амжилттай суулгагдлаа');
});

document.getElementById('ib-install').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
  deferredInstall = null;
  updateInstallBanner();
};
document.getElementById('ib-close').onclick = () => { installDismissed = true; updateInstallBanner(); };

// Recalc on resume / focus (only when logged in)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) { render(); checkReminders(); }
});

/* ---------- Boot ---------- */
function migrateAuth() {
  // grant newly-added modules to existing 'user' accounts so they aren't hidden
  let changed = false;
  auth.users.forEach(u => {
    if (!Array.isArray(u.perms)) u.perms = [...PERM_KEYS];
    if (u.role === 'user' && !u.perms.includes('finance')) { u.perms.push('finance'); changed = true; }
  });
  if (changed) saveAuth();
}

function boot() {
  migrateAuth();
  if (auth.users.length === 0) { showAuth('setup'); return; }
  if (auth.currentUserId) {
    const u = auth.users.find(x => x.id === auth.currentUserId);
    if (u) { enterApp(u); return; }
  }
  showAuth('login');
}
boot();

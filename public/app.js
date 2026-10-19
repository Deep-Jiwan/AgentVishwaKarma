// Vishwakarma Calendar - front end. No framework, no build step.
// All text from the server goes in with textContent (via h()), never innerHTML.

const COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9', '#F0E442', '#5B6770'];
const PATTERN_NAMES = {
  solid: 'Solid',
  diagonal: 'Diagonal lines',
  backdiagonal: 'Back diagonal lines',
  dots: 'Dots',
  grid: 'Grid',
  horizontal: 'Horizontal lines',
  checks: 'Checks',
  zigzag: 'Zigzag',
};
const PATTERN_SVG = {
  solid: () => '',
  diagonal: (c) => `<path d='M-2 2L2 -2M0 8L8 0M6 10L10 6' stroke='${c}' stroke-width='1.6'/>`,
  backdiagonal: (c) => `<path d='M-2 6L2 10M0 0L8 8M6 -2L10 2' stroke='${c}' stroke-width='1.6'/>`,
  dots: (c) => `<circle cx='2' cy='2' r='1.3' fill='${c}'/><circle cx='6' cy='6' r='1.3' fill='${c}'/>`,
  grid: (c) => `<path d='M0 0.5H8M0.5 0V8' stroke='${c}' stroke-width='1'/>`,
  horizontal: (c) => `<path d='M0 2H8M0 6H8' stroke='${c}' stroke-width='1.4'/>`,
  checks: (c) => `<rect width='4' height='4' fill='${c}'/><rect x='4' y='4' width='4' height='4' fill='${c}'/>`,
  zigzag: (c) => `<path d='M0 6L2 2L4 6L6 2L8 6' fill='none' stroke='${c}' stroke-width='1.3'/>`,
};
const STATUS_LABEL = { planned: 'Planned', in_progress: 'In progress', done: 'Done' };

// ---------- tiny helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role') el.setAttribute(k, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  if (value !== undefined) el.value = value;
  return el;
}

const svgUri = (inner, opacity) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><g opacity='${opacity}'>${inner}</g></svg>`)}")`;

function patternBg(pattern, color, opacity) {
  const draw = PATTERN_SVG[pattern];
  const inner = draw ? draw(color) : '';
  return inner ? svgUri(inner, opacity) : 'none';
}

// A little square that shows a project's colour and pattern.
function swatch(p, size) {
  return h('span', {
    class: 'swatch',
    'aria-hidden': 'true',
    style: { 'background-color': p.color, 'background-image': patternBg(p.pattern, '#fff', 0.85), ...(size ? { width: size + 'px', height: size + 'px' } : {}) },
  });
}

// ---------- dates (plain YYYY-MM-DD strings, no timezones) ----------

const parseDate = (s) => new Date(s + 'T00:00:00Z');
const fmtDate = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmtDate(new Date(parseDate(s).getTime() + n * 86400000));
const diffDays = (a, b) => Math.round((parseDate(a) - parseDate(b)) / 86400000);
const addMonths = (s, n) => {
  const d = parseDate(s);
  return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
};
const weekStart = (s) => addDays(s, -((parseDate(s).getUTCDay() + 6) % 7)); // Monday first
const monthStart = (s) => s.slice(0, 8) + '01';
function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
const nowMinutes = () => new Date().getHours() * 60 + new Date().getMinutes();
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const intl = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts });
const fmt = {
  month: (s) => intl({ month: 'long', year: 'numeric' }).format(parseDate(s)),
  dow: (s) => intl({ weekday: 'short' }).format(parseDate(s)),
  dayLong: (s) => intl({ weekday: 'long', day: 'numeric', month: 'long' }).format(parseDate(s)),
  short: (s) => intl({ day: 'numeric', month: 'short' }).format(parseDate(s)),
};

// ---------- state ----------

const state = {
  me: null,
  projects: [],
  events: [],
  view: window.innerWidth < 820 ? 'agenda' : 'month',
  anchor: localToday(),
  hidden: new Set(),
  q: '',
};
const root = document.getElementById('root');
const shell = {};

const projectOf = (id) => state.projects.find((p) => p.id === id);
const canEdit = (e) => projectOf(e.project_id)?.level === 'edit';
const editableProjects = () => state.projects.filter((p) => p.level === 'edit');

function visibleEvents() {
  const q = state.q.trim().toLowerCase();
  return state.events.filter((e) => {
    if (state.hidden.has(e.project_id)) return false;
    if (!q) return true;
    return (e.title + ' ' + e.notes + ' ' + (projectOf(e.project_id)?.name || '')).toLowerCase().includes(q);
  });
}
const eventsOn = (list, day) => list.filter((e) => e.start_date <= day && e.end_date >= day).sort(byStart);
function byStart(a, b) {
  const ta = a.start_time || '', tb = b.start_time || '';
  return (a.start_date !== b.start_date ? (a.start_date < b.start_date ? -1 : 1) : 0) || (ta < tb ? -1 : ta > tb ? 1 : 0) || a.id - b.id;
}

function isOngoing(e) {
  if (e.status === 'done') return false;
  if (e.status === 'in_progress') return true;
  const today = localToday();
  if (today < e.start_date || today > e.end_date) return false;
  if (e.start_time && e.start_date === e.end_date) return nowMinutes() >= toMin(e.start_time) && nowMinutes() < toMin(e.end_time);
  return true;
}
function isUpcoming(e) {
  if (e.status === 'done' || isOngoing(e)) return false;
  const today = localToday();
  if (e.start_date > today) return e.start_date <= addDays(today, 14);
  return e.start_date === today && e.start_time && toMin(e.start_time) > nowMinutes();
}
const whenText = (e) => {
  const days = e.start_date === e.end_date ? fmt.short(e.start_date) : `${fmt.short(e.start_date)} - ${fmt.short(e.end_date)}`;
  return e.start_time ? `${days}, ${e.start_time}-${e.end_time}` : days;
};

// ---------- api ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function refresh({ quiet = false } = {}) {
  try {
    const data = await api('/state');
    state.me = data.me;
    state.projects = data.projects;
    state.events = data.events;
    renderAll();
  } catch (err) {
    if (!quiet) toast(err.message);
  }
}

// ---------- modal ----------

const modals = [];
function openModal(build, { wide = false } = {}) {
  const previouslyFocused = document.activeElement;
  const dialog = h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
  const overlay = h('div', { class: 'overlay' }, dialog);
  let downOnOverlay = false;
  overlay.addEventListener('mousedown', (ev) => { downOnOverlay = ev.target === overlay; });
  overlay.addEventListener('click', (ev) => { if (downOnOverlay && ev.target === overlay) close(); });
  const handle = { dialog, close, setContent: (...nodes) => dialog.replaceChildren(...nodes) };
  function close() {
    overlay.remove();
    modals.splice(modals.indexOf(handle), 1);
    previouslyFocused?.focus?.();
  }
  modals.push(handle);
  document.body.append(overlay);
  build(handle);
  (dialog.querySelector('[autofocus]') || dialog.querySelector('input,select,textarea,button'))?.focus();
  return handle;
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modals.length) modals[modals.length - 1].close();
});

const dialogHeader = (title, m) =>
  h('header', null, h('h2', null, title), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: m.close }, '✕'));

// ---------- login ----------

function showLogin(message = '') {
  modals.slice().forEach((m) => m.close());
  state.me = null;
  clearInterval(showLogin.timer);
  const error = h('div', { class: 'error', role: 'alert' }, message);
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', minLength: 15, required: true, placeholder: 'Your access password', 'aria-label': 'Password', autofocus: true });
  const toggle = h('button', { class: 'btn ghost', type: 'button', onclick: () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Open calendar');
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        error.textContent = '';
        if (input.value.length < 15) { error.textContent = 'Passwords are at least 15 characters.'; return; }
        submit.disabled = true;
        try {
          await api('/login', { method: 'POST', body: { password: input.value } });
          await start();
        } catch (err) {
          error.textContent = err.message;
          submit.disabled = false;
          input.select();
        }
      },
    },
    h('div', { class: 'pw-row' }, input, toggle),
    error,
    submit
  );
  root.replaceChildren(
    h('main', { class: 'login' },
      h('div', { class: 'login-card' },
        h('div', { class: 'logo', 'aria-hidden': 'true' }, logoSvg()),
        h('h1', null, 'Vishwakarma Calendar'),
        h('div', { class: 'muted' }, "Enter your password. This device will stay signed in for 30 days."),
        form))
  );
  input.focus();
}

function logoSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  const r = document.createElementNS(ns, 'rect');
  for (const [k, v] of Object.entries({ x: 7, y: 9, width: 18, height: 16, rx: 3, fill: 'none', stroke: '#fff', 'stroke-width': 2 })) r.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ d: 'M7 14h18M12 6v5M20 6v5', stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round' })) p.setAttribute(k, v);
  svg.append(r, p);
  return svg;
}

// ---------- shell ----------

function buildShell() {
  shell.title = h('h2');
  shell.seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
    ...[['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']].map(([v, label]) =>
      h('button', { 'data-view': v, onclick: () => { state.view = v; renderAll(); } }, label)));
  shell.newBtn = h('button', { class: 'btn primary', onclick: () => openEventModal(null, { date: state.view === 'month' ? localToday() : state.anchor }) }, '+ New task');
  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search tasks', oninput: (ev) => { state.q = ev.target.value; renderBody(); renderPanel(); } });
  const step = (dir) => { state.anchor = state.view === 'month' ? addMonths(state.anchor, dir) : addDays(state.anchor, dir * (state.view === 'week' ? 7 : 30)); renderAll(); };
  shell.topbar = h('div', { class: 'card topbar' },
    h('button', { class: 'btn icon', 'aria-label': 'Previous', onclick: () => step(-1) }, '‹'),
    h('button', { class: 'btn icon', 'aria-label': 'Next', onclick: () => step(1) }, '›'),
    h('button', { class: 'btn', onclick: () => { state.anchor = localToday(); renderAll(); } }, 'Today'),
    shell.title, search, shell.seg, shell.newBtn);
  shell.body = h('div', { class: 'card body' });
  shell.side = h('aside', { class: 'card sidebar' });
  shell.panel = h('aside', { class: 'card panel' });
  root.replaceChildren(h('div', { class: 'app' }, shell.side, h('main', { class: 'main' }, shell.topbar, shell.body), shell.panel));
}

function renderAll() {
  if (!shell.body?.isConnected) buildShell();
  renderTopbar();
  renderSide();
  renderBody();
  renderPanel();
}

function renderTopbar() {
  const a = state.anchor;
  if (state.view === 'month') shell.title.textContent = fmt.month(a);
  else if (state.view === 'week') { const s = weekStart(a); shell.title.textContent = `${fmt.short(s)} - ${fmt.short(addDays(s, 6))} ${parseDate(addDays(s, 6)).getUTCFullYear()}`; }
  else shell.title.textContent = 'Agenda';
  shell.seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  shell.newBtn.hidden = editableProjects().length === 0;
}

// ---------- sidebar ----------

function renderSide() {
  const roleLabel = { admin: 'Admin', editor: 'Editor', guest: 'View only' }[state.me.role];
  shell.side.replaceChildren(
    h('div', { class: 'brand' }, h('div', { class: 'logo', 'aria-hidden': 'true' }, logoSvg()), 'Vishwakarma'),
    miniCalendar(),
    h('section', null,
      h('h3', { class: 'side-title' }, 'Projects', state.me.role === 'admin' ? h('button', { class: 'btn ghost', onclick: () => openManage('projects') }, 'Manage') : null),
      h('div', { class: 'proj-list' },
        state.projects.length ? state.projects.map(projectToggle) : h('div', { class: 'muted' }, state.me.role === 'admin' ? 'No projects yet. Use Manage to add one.' : 'No projects shared with you yet.'))),
    h('div', { class: 'who' },
      h('div', null, h('div', null, state.me.name), h('span', { class: 'badge' }, roleLabel)),
      h('div', null,
        state.me.role === 'admin' ? h('button', { class: 'btn ghost', onclick: () => openManage('people') }, 'People') : null,
        h('button', { class: 'btn ghost', onclick: signOut }, 'Sign out')))
  );
}

async function signOut() {
  try { await api('/logout', { method: 'POST' }); } catch { /* already signed out */ }
  showLogin();
}

function projectToggle(p) {
  const on = !state.hidden.has(p.id);
  return h('button', { class: 'proj', 'aria-pressed': String(on), title: on ? 'Click to hide' : 'Click to show', onclick: () => { on ? state.hidden.add(p.id) : state.hidden.delete(p.id); renderSide(); renderBody(); renderPanel(); } },
    swatch(p), h('span', { class: 'name' }, p.name), p.level === 'view' && state.me.role !== 'guest' ? h('span', { class: 'tag' }, 'view only') : null);
}

function miniCalendar() {
  const first = monthStart(state.anchor);
  const start = weekStart(first);
  const today = localToday();
  const withEvents = new Set();
  for (const e of visibleEvents()) for (let d = e.start_date; d <= e.end_date && diffDays(d, e.start_date) < 62; d = addDays(d, 1)) withEvents.add(d);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.slice(0, 7) !== first.slice(0, 7)) break;
    cells.push(h('button', {
      class: [d.slice(0, 7) !== first.slice(0, 7) && 'out', d === today && 'today', d === state.anchor && 'sel', withEvents.has(d) && 'has'].filter(Boolean).join(' '),
      'aria-label': fmt.dayLong(d),
      onclick: () => { state.anchor = d; renderAll(); },
    }, String(Number(d.slice(8)))));
  }
  const dows = Array.from({ length: 7 }, (_, i) => h('div', { class: 'dow' }, fmt.dow(addDays('2026-10-19', i)).slice(0, 2)));
  return h('section', null,
    h('div', { class: 'mini-head' },
      h('button', { class: 'btn ghost icon', 'aria-label': 'Previous month', onclick: () => { state.anchor = addMonths(state.anchor, -1); renderAll(); } }, '‹'),
      h('span', null, fmt.month(first)),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Next month', onclick: () => { state.anchor = addMonths(state.anchor, 1); renderAll(); } }, '›')),
    h('div', { class: 'mini' }, dows, cells));
}

// ---------- chips ----------

function chip(e, day, { drag = true, compact = false } = {}) {
  const p = projectOf(e.project_id) || { color: '#5B6770', pattern: 'solid', name: '' };
  const editable = canEdit(e);
  const showTime = e.start_time && day === e.start_date;
  const el = h('button', {
    class: ['chip', e.status === 'done' && 'done', day > e.start_date && 'cont-l', day < e.end_date && 'cont-r'].filter(Boolean).join(' '),
    style: { '--c': p.color, 'background-image': patternBg(p.pattern, p.color, 0.55) },
    draggable: drag && editable,
    title: `${e.title} (${p.name}) - ${STATUS_LABEL[e.status]}`,
    onclick: () => openEventModal(e),
  },
    isOngoing(e) ? h('span', { class: 'live-dot', 'aria-label': 'Happening now' }) : null,
    showTime ? h('span', { class: 'time' }, e.start_time) : null,
    h('span', { class: 't' }, e.title));
  if (drag && editable) {
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', `${e.id}|${day}`);
      ev.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  }
  return el;
}

function makeDropTarget(el, day) {
  el.addEventListener('dragover', (ev) => { ev.preventDefault(); el.classList.add('drop'); });
  el.addEventListener('dragleave', (ev) => { if (!el.contains(ev.relatedTarget)) el.classList.remove('drop'); });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('drop');
    const [id, from] = (ev.dataTransfer.getData('text/plain') || '').split('|');
    const e = state.events.find((x) => x.id === Number(id));
    if (e && from && from !== day) moveEvent(e, diffDays(day, from));
  });
}

async function moveEvent(e, delta) {
  const before = { start_date: e.start_date, end_date: e.end_date };
  e.start_date = addDays(e.start_date, delta);
  e.end_date = addDays(e.end_date, delta);
  renderAll();
  try {
    const { event } = await api('/events/' + e.id, { method: 'PATCH', body: { start_date: e.start_date, end_date: e.end_date } });
    Object.assign(e, event);
    toast(`Moved to ${whenText(e)}`);
  } catch (err) {
    Object.assign(e, before);
    toast(err.message);
  }
  renderAll();
}

// ---------- calendar body ----------

function renderBody() {
  const list = visibleEvents();
  if (state.view === 'month') shell.body.replaceChildren(monthView(list));
  else if (state.view === 'week') shell.body.replaceChildren(weekView(list));
  else shell.body.replaceChildren(agendaView(list));
}

function monthView(list) {
  const first = monthStart(state.anchor);
  const start = weekStart(first);
  const today = localToday();
  const nodes = Array.from({ length: 7 }, (_, i) => h('div', { class: 'dow' }, fmt.dow(addDays(start, i))));
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.slice(0, 7) !== first.slice(0, 7)) break;
    const evs = eventsOn(list, d);
    const cell = h('div', { class: ['cell', d.slice(0, 7) !== first.slice(0, 7) && 'out', d === today && 'today'].filter(Boolean).join(' ') },
      h('button', { class: 'num', 'aria-label': 'Add task on ' + fmt.dayLong(d), onclick: () => editableProjects().length && openEventModal(null, { date: d }) }, String(Number(d.slice(8)))),
      evs.slice(0, 3).map((e) => chip(e, d)),
      evs.length > 3 ? h('button', { class: 'more', onclick: () => { state.view = 'week'; state.anchor = d; renderAll(); } }, `+${evs.length - 3} more`) : null);
    makeDropTarget(cell, d);
    nodes.push(cell);
  }
  return h('div', { class: 'month' }, nodes);
}

function weekView(list) {
  const start = weekStart(state.anchor);
  const today = localToday();
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const evs = eventsOn(list, d);
    const col = h('div', { class: 'wcol' + (d === today ? ' today' : '') },
      h('div', { class: 'head' }, `${fmt.dow(d)} ${Number(d.slice(8))}`),
      evs.map((e) => {
        const c = chip(e, d);
        if (e.start_time) c.append(h('span', { class: 'time' }, `${e.start_time}-${e.end_time}`));
        return c;
      }),
      evs.length ? null : h('div', { class: 'muted' }, '-'));
    makeDropTarget(col, d);
    cols.push(col);
  }
  return h('div', { class: 'week' }, cols);
}

function agendaView(list) {
  const from = state.anchor, to = addDays(from, 60);
  const groups = new Map();
  for (const e of list.filter((x) => x.end_date >= from && x.start_date <= to).sort(byStart)) {
    const key = e.start_date < from ? from : e.start_date;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  if (!groups.size) return h('div', { class: 'empty' }, 'Nothing scheduled in the next 60 days.');
  return h('div', { class: 'agenda' },
    [...groups].map(([day, evs]) =>
      h('section', { class: 'row' }, h('h3', null, fmt.dayLong(day) + (day === localToday() ? ' · Today' : '')),
        evs.map((e) => itemButton(e, true)))));
}

// ---------- right panel ----------

function itemButton(e, showProject = false) {
  const p = projectOf(e.project_id) || { color: '#5B6770', pattern: 'solid', name: '' };
  return h('button', { class: 'item', style: { '--c': p.color }, onclick: () => openEventModal(e) },
    h('div', { class: 'top' }, swatch(p, 14), isOngoing(e) ? h('span', { class: 'live-dot', 'aria-label': 'Happening now' }) : null, h('span', null, e.title)),
    h('div', { class: 'sub' }, [showProject ? p.name + ' · ' : '', whenText(e), e.status === 'in_progress' ? ' · In progress' : e.status === 'done' ? ' · Done' : ''].join('')));
}

function renderPanel() {
  const list = visibleEvents();
  const now = list.filter(isOngoing).sort(byStart);
  const next = list.filter(isUpcoming).sort(byStart).slice(0, 6);
  shell.panel.replaceChildren(
    h('section', null, h('h3', null, h('span', { class: 'live-dot' }), 'Happening now', h('span', { class: 'pill' }, String(now.length))),
      h('div', { class: 'items' }, now.length ? now.map((e) => itemButton(e, true)) : h('div', { class: 'muted' }, 'Nothing in progress right now.'))),
    h('section', null, h('h3', null, 'Up next', h('span', { class: 'pill' }, 'next 14 days')),
      h('div', { class: 'items' }, next.length ? next.map((e) => itemButton(e, true)) : h('div', { class: 'muted' }, 'Nothing coming up.'))),
    h('div', { class: 'muted' }, 'Last updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  );
}

// ---------- task modal ----------

function openEventModal(e, { date } = {}) {
  const editable = e ? canEdit(e) : true;
  if (!e && !editableProjects().length) return;
  const p0 = e ? projectOf(e.project_id) : editableProjects()[0];
  openModal((m) => {
    const err = h('div', { class: 'error', role: 'alert' });
    const f = {
      title: h('input', { class: 'input', value: e?.title ?? '', maxLength: 120, disabled: !editable, autofocus: true, 'aria-label': 'Title' }),
      project: h('select', { class: 'input', disabled: !editable }, (editable ? editableProjects() : [p0]).map((p) => h('option', { value: p.id }, p.name))),
      status: h('select', { class: 'input', disabled: !editable }, Object.entries(STATUS_LABEL).map(([v, l]) => h('option', { value: v }, l))),
      start_date: h('input', { class: 'input', type: 'date', value: e?.start_date ?? date, disabled: !editable }),
      end_date: h('input', { class: 'input', type: 'date', value: e?.end_date ?? date, disabled: !editable }),
      start_time: h('input', { class: 'input', type: 'time', value: e?.start_time ?? '', disabled: !editable }),
      end_time: h('input', { class: 'input', type: 'time', value: e?.end_time ?? '', disabled: !editable }),
      notes: h('textarea', { class: 'input', maxLength: 2000, disabled: !editable }, e?.notes ?? ''),
    };
    f.project.value = String(p0.id);
    f.status.value = e?.status ?? 'planned';
    f.start_date.addEventListener('change', () => { if (f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value; });
    const field = (label, input) => h('label', { class: 'f' }, h('span', null, label), input);
    const save = h('button', { class: 'btn primary', onclick: async () => {
      err.textContent = '';
      const body = {
        project_id: Number(f.project.value), title: f.title.value, notes: f.notes.value, status: f.status.value,
        start_date: f.start_date.value, end_date: f.end_date.value, start_time: f.start_time.value || null, end_time: f.end_time.value || null,
      };
      save.disabled = true;
      try {
        await api(e ? '/events/' + e.id : '/events', { method: e ? 'PATCH' : 'POST', body });
        m.close();
        await refresh();
      } catch (ex) {
        err.textContent = ex.message;
        save.disabled = false;
      }
    } }, e ? 'Save' : 'Add task');
    m.setContent(
      dialogHeader(e ? (editable ? 'Edit task' : 'Task') : 'New task', m),
      h('div', { class: 'content' },
        field('Title', f.title),
        h('div', { class: 'grid2' }, field('Project', f.project), field('Status', f.status)),
        h('div', { class: 'grid2' }, field('Starts', f.start_date), field('Ends', f.end_date)),
        h('div', { class: 'grid2' }, field('Start time (optional)', f.start_time), field('End time (optional)', f.end_time)),
        field('Notes', f.notes),
        e ? h('div', { class: 'muted' }, swatch(p0, 12), ` ${p0.name} · ${PATTERN_NAMES[p0.pattern]}` + (e.updated_by ? ` · last changed by ${e.updated_by}, ${new Date(e.updated_at.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '')) : null,
        !editable ? h('div', { class: 'muted' }, 'You can view this project but not change it.') : null,
        err,
        h('footer', null,
          e && editable ? h('button', { class: 'btn danger', onclick: async () => {
            if (!confirm('Delete this task?')) return;
            try { await api('/events/' + e.id, { method: 'DELETE' }); m.close(); await refresh(); } catch (ex) { err.textContent = ex.message; }
          } }, 'Delete') : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: m.close }, editable ? 'Cancel' : 'Close'),
          editable ? save : null)));
  });
}

// ---------- admin: projects & people ----------

function pickers(draft, onChange) {
  const colorBtns = COLORS.map((c) => h('button', { type: 'button', 'aria-label': 'Colour ' + c, 'aria-pressed': String(draft.color === c), title: c, onclick: () => { draft.color = c; onChange(); } },
    h('span', { class: 'swatch', style: { 'background-color': c } })));
  const patBtns = Object.keys(PATTERN_NAMES).map((k) => h('button', { type: 'button', 'aria-label': 'Pattern ' + PATTERN_NAMES[k], 'aria-pressed': String(draft.pattern === k), title: PATTERN_NAMES[k], onclick: () => { draft.pattern = k; onChange(); } },
    swatch({ color: draft.color, pattern: k })));
  return [h('div', { class: 'picker', role: 'group', 'aria-label': 'Colour' }, colorBtns), h('div', { class: 'picker', role: 'group', 'aria-label': 'Pattern' }, patBtns)];
}

function openManage(tab = 'projects') {
  openModal((m) => {
    const content = h('div', { class: 'content' });
    const tabs = h('div', { class: 'tabs' }, ...[['projects', 'Projects'], ['people', 'People']].map(([k, label]) =>
      h('button', { class: 'btn', 'aria-pressed': String(k === tab), onclick: () => { tab = k; draw(); } }, label)));
    async function draw() {
      tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['projects', 'people'][i] === tab)));
      content.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
      try {
        content.replaceChildren(...(tab === 'projects' ? projectsTab(draw) : await peopleTab(draw)));
      } catch (ex) { content.replaceChildren(h('div', { class: 'error' }, ex.message)); }
    }
    m.setContent(dialogHeader('Manage', m), tabs, content);
    draw();
  }, { wide: true });
}

function projectEditor(p, done) {
  const draft = { name: p?.name ?? '', color: p?.color ?? COLORS[state.projects.length % 8], pattern: p?.pattern ?? Object.keys(PATTERN_NAMES)[state.projects.length % 8] };
  const err = h('div', { class: 'error', role: 'alert' });
  const card = h('div', { class: 'rowcard' });
  const name = h('input', { class: 'input', value: draft.name, maxLength: 40, placeholder: 'Project name', 'aria-label': 'Project name', oninput: (ev) => { draft.name = ev.target.value; } });
  function draw() {
    card.replaceChildren(
      h('div', { class: 'rowline' }, swatch(draft, 26), h('div', { style: { flex: '1', 'min-width': '160px' } }, name)),
      ...pickers(draft, draw),
      err,
      h('div', { class: 'rowline' },
        h('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            await api(p ? '/projects/' + p.id : '/projects', { method: p ? 'PATCH' : 'POST', body: draft });
            await refresh();
            done();
          } catch (ex) { err.textContent = ex.message; }
        } }, p ? 'Save' : 'Add project'),
        p ? h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`Delete "${p.name}" and all its tasks? This can't be undone.`)) return;
          try { await api('/projects/' + p.id, { method: 'DELETE' }); await refresh(); done(); } catch (ex) { err.textContent = ex.message; }
        } }, 'Delete') : null));
  }
  draw();
  return card;
}

function projectsTab(redraw) {
  return [
    h('div', { class: 'muted' }, 'Every project gets a colour and a pattern, so it still reads clearly for colour-blind viewers.'),
    ...state.projects.map((p) => projectEditor(p, redraw)),
    h('h3', { class: 'side-title' }, 'New project'),
    projectEditor(null, redraw),
  ];
}

function secretBox(label, password) {
  const copy = h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(password); copy.textContent = 'Copied'; } catch { toast('Copy failed - select the text instead'); } } }, 'Copy');
  return h('div', { class: 'secret' }, h('strong', null, label), h('code', null, password), h('div', { class: 'muted' }, "Shown once. Copy it now and send it to them - it can't be viewed again, only replaced."), h('div', null, copy));
}

async function peopleTab(redraw) {
  const { users } = await api('/users');
  const out = [];
  const err = h('div', { class: 'error', role: 'alert' });
  const name = h('input', { class: 'input', placeholder: 'Name (e.g. Asha)', maxLength: 40, 'aria-label': 'Name' });
  const role = h('select', { class: 'input', 'aria-label': 'Role', style: { width: 'auto' } }, h('option', { value: 'editor' }, 'Editor - can change assigned projects'), h('option', { value: 'guest' }, 'Guest - read only, sees everything'));
  const secretSlot = h('div');
  out.push(
    h('div', { class: 'rowcard' }, h('strong', null, 'Add a person'),
      h('div', { class: 'rowline' }, h('div', { style: { flex: '1', 'min-width': '160px' } }, name), role,
        h('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            const r = await api('/users', { method: 'POST', body: { name: name.value, role: role.value } });
            await redrawWithSecret(redraw, `Password for ${r.user.name}`, r.password);
          } catch (ex) { err.textContent = ex.message; }
        } }, 'Create')),
      err, secretSlot));
  out.push(h('div', { class: 'muted' }, 'The admin password is set on the server (not shown here). People get a random 20-character password.'));
  for (const u of users) out.push(userCard(u, redraw));
  if (!users.length) out.push(h('div', { class: 'empty' }, 'No one yet.'));
  if (peopleTab.pending) { secretSlot.append(secretBox(peopleTab.pending.label, peopleTab.pending.password)); peopleTab.pending = null; }
  return out;
}
async function redrawWithSecret(redraw, label, password) { peopleTab.pending = { label, password }; await redraw(); }

function userCard(u, redraw) {
  const levels = new Map(u.access.map((a) => [a.project_id, a.level]));
  const err = h('div', { class: 'error', role: 'alert' });
  const name = h('input', { class: 'input', value: u.name, maxLength: 40, 'aria-label': 'Name', style: { 'max-width': '220px' } });
  const selects = state.projects.map((p) => {
    const s = h('select', { class: 'input', 'aria-label': `${u.name} access to ${p.name}` },
      h('option', { value: '' }, 'No access (hidden)'), h('option', { value: 'view' }, 'Can view'), h('option', { value: 'edit' }, 'Can edit'));
    s.value = levels.get(p.id) ?? '';
    return { p, s };
  });
  const secretSlot = h('div');
  return h('div', { class: 'rowcard' },
    h('div', { class: 'rowline' }, name, h('span', { class: 'badge' }, u.role === 'editor' ? 'Editor' : 'Guest'),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn', onclick: async () => {
        if (!confirm(`Give ${u.name} a new password? Their old password stops working and they are signed out.`)) return;
        try { const r = await api(`/users/${u.id}/reset-password`, { method: 'POST' }); secretSlot.replaceChildren(secretBox(`New password for ${u.name}`, r.password)); } catch (ex) { err.textContent = ex.message; }
      } }, 'New password'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`Remove ${u.name}? They are signed out straight away.`)) return;
        try { await api('/users/' + u.id, { method: 'DELETE' }); await redraw(); } catch (ex) { err.textContent = ex.message; }
      } }, 'Remove')),
    u.role === 'editor'
      ? h('div', { class: 'access' }, selects.map(({ p, s }) => [h('span', { class: 'rowline' }, swatch(p), p.name), s]))
      : h('div', { class: 'muted' }, 'Guests can see every project but cannot change anything.'),
    state.projects.length === 0 && u.role === 'editor' ? h('div', { class: 'muted' }, 'Add a project first, then choose what this person can reach.') : null,
    err, secretSlot,
    h('div', { class: 'rowline' }, h('button', { class: 'btn primary', onclick: async () => {
      err.textContent = '';
      const body = { name: name.value };
      if (u.role === 'editor') body.access = selects.filter(({ s }) => s.value).map(({ p, s }) => ({ project_id: p.id, level: s.value }));
      try { await api('/users/' + u.id, { method: 'PATCH', body }); toast('Saved'); await redraw(); } catch (ex) { err.textContent = ex.message; }
    } }, 'Save changes')));
}

// ---------- boot ----------

async function start() {
  state.anchor = localToday();
  state.hidden.clear();
  state.q = '';
  shell.body = null;
  await refresh();
  clearInterval(showLogin.timer);
  showLogin.timer = setInterval(() => { if (document.visibilityState === 'visible' && !modals.length && state.me) refresh({ quiet: true }); }, 30000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me && !modals.length) refresh({ quiet: true }); });

(async () => {
  try {
    await api('/state').then((d) => { state.me = d.me; });
    await start();
  } catch {
    if (!state.me) showLogin();
  }
})();

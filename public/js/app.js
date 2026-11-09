// Application shell: session, menu bar + command registry, router, status bar.
import { get, post, put, setUnauthorizedHandler } from './api.js';
import { h, clear, fill, toast, showError, modal, unsavedDialog, modalOpen, popupMenu, setStatuses } from './ui.js';
import { renderSetup, renderLogin, renderReset, changePasswordDialog } from './views/auth.js';
import * as dashboardView from './views/dashboard.js';
import * as jobsView from './views/jobs.js';
import * as jobEditorView from './views/job-editor.js';
import * as priceBooksView from './views/pricebooks.js';
import * as priceBookEditorView from './views/pricebook-editor.js';
import * as settingsView from './views/settings.js';
import * as calendarView from './views/calendar.js';
import { openEventDialog, fmtWhen } from './views/event-dialog.js';

const root = document.getElementById('root');

export const app = {
  state: { user: null, company: null, info: null },
  view: null,
  commands: new Map(),
  viewCommands: new Map(),
  isManager: () => ['owner', 'admin'].includes(app.state.user?.role),
  isOwner: () => app.state.user?.role === 'owner',
  navigate: (hash) => { if (location.hash === hash) route(); else location.hash = hash; },
  run: (id) => runCommand(id),
  setStatus: (text) => { const el = document.getElementById('status-left'); if (el) el.textContent = text || ''; },
  refreshChrome: () => { renderMenubar(); updateTitle(); },
  async reloadState() { const s = await get('/api/state'); Object.assign(app.state, { user: s.user, company: s.company, info: s.app }); setStatuses(s.statuses); },
};

// ---------------- commands ----------------

const KEY = (e) => [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');

function defineGlobal(id, label, run, opts = {}) { app.commands.set(id, { id, label, run, ...opts }); }

defineGlobal('file.new', 'New job…', () => jobsView.newJobDialog(app), { key: 'Alt+N' });
defineGlobal('file.open', 'Open job…', () => jobsView.openJobDialog(app), { key: 'Ctrl+O' });
defineGlobal('file.import', 'Import job file…', () => jobsView.importJobFile(app));
defineGlobal('app.signOut', 'Sign out', signOut);
defineGlobal('go.dashboard', 'Dashboard', () => app.navigate('#/dashboard'), { key: 'Alt+1' });
defineGlobal('go.jobs', 'Jobs', () => app.navigate('#/jobs'), { key: 'Alt+2' });
defineGlobal('go.pricebook', 'Price book', () => app.navigate('#/price-books'), { key: 'Alt+3' });
defineGlobal('go.calendar', 'Calendar', () => app.navigate('#/calendar'), { key: 'Alt+4' });
defineGlobal('app.reminders', 'Reminders', () => openReminders(document.getElementById('bell')));
defineGlobal('pb.import', 'Import price book file…', () => priceBooksView.importBook(app), { when: () => app.isManager() });
defineGlobal('admin.company', 'Company settings', () => app.navigate('#/settings/company'), { when: () => app.isManager() });
defineGlobal('admin.users', 'Users & access', () => app.navigate('#/settings/users'), { when: () => app.isOwner() });
defineGlobal('admin.templates', 'Area templates', () => app.navigate('#/settings/templates'), { when: () => app.isManager() });
defineGlobal('admin.backups', 'Backups', () => app.navigate('#/settings/backups'), { when: () => app.isOwner() });
defineGlobal('admin.staff', 'Staff & resources', () => app.navigate('#/settings/staff'), { when: () => app.isManager() });
defineGlobal('admin.workflow', 'Workflow events', () => app.navigate('#/settings/workflow'), { when: () => app.isManager() });
defineGlobal('admin.audit', 'Activity log', () => app.navigate('#/settings/activity'), { when: () => app.isManager() });
defineGlobal('account.password', 'Change my password…', () => changePasswordDialog());
defineGlobal('help.shortcuts', 'Keyboard shortcuts', shortcutsDialog, { key: 'F1' });
defineGlobal('help.about', 'About', aboutDialog);

function command(id) {
  const c = app.viewCommands.get(id) || app.commands.get(id);
  if (!c) return null;
  if (c.when && !c.when()) return null;
  return c;
}

async function runCommand(id) {
  const c = command(id);
  if (!c) return;
  document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  try { await c.run(); } catch (err) { showError(err); }
}

const MENUS = [
  ['File', ['file.new', 'file.open', '-', 'file.save', 'file.saveAs', '-', 'file.import', 'file.export', '-', 'file.close', '-', 'account.password', 'app.signOut']],
  ['Edit', ['edit.undo', 'edit.redo', '-', 'edit.addArea', 'edit.duplicateArea', 'edit.deleteArea', '-', 'edit.addLine', 'edit.addCustom']],
  ['Job', ['job.details', 'job.schedule', 'job.quote', 'job.quotes', 'job.costs', 'job.history', '-', 'job.reprice', 'job.archive']],
  ['Price Book', ['go.pricebook', 'pb.newDraft', 'pb.publish', '-', 'pb.export', 'pb.import']],
  ['Admin', ['admin.company', 'admin.users', 'admin.staff', 'admin.workflow', 'admin.templates', 'admin.backups', 'admin.audit']],
  ['View', ['go.dashboard', 'go.jobs', 'go.calendar', 'go.pricebook', '-', 'app.reminders']],
  ['Help', ['help.shortcuts', 'help.about']],
];

function renderMenubar() {
  const bar = document.getElementById('menus');
  if (!bar) return;
  clear(bar);
  for (const [name, ids] of MENUS) {
    if (name === 'Admin' && !app.isManager()) continue;
    const items = h('div', { class: 'menu-items', role: 'menu' });
    let lastSep = true;
    for (const id of ids) {
      if (id === '-') { if (!lastSep) items.append(h('div', { class: 'sep' })); lastSep = true; continue; }
      const def = app.viewCommands.get(id) || app.commands.get(id);
      const c = command(id);
      const label = def ? def.label : PLACEHOLDER_LABELS[id] || id;
      if (!def && !PLACEHOLDER_LABELS[id]) continue;
      if (def && def.when && !def.when() && !def.showDisabled) continue;
      items.append(h('button', { role: 'menuitem', disabled: !c, on: { click: () => runCommand(id) } }, h('span', null, label), def?.key ? h('kbd', null, def.key) : ''));
      lastSep = false;
    }
    if (items.lastChild && items.lastChild.classList.contains('sep')) items.lastChild.remove();
    const menu = h('div', { class: 'menu' },
      h('button', { class: 'menu-title', 'aria-haspopup': 'true', on: {
        click: (e) => { const m = e.currentTarget.parentElement; const open = m.classList.contains('open'); document.querySelectorAll('.menu.open').forEach((x) => x.classList.remove('open')); if (!open) m.classList.add('open'); },
        mouseenter: (e) => { if (document.querySelector('.menu.open') && !e.currentTarget.parentElement.classList.contains('open')) { document.querySelectorAll('.menu.open').forEach((x) => x.classList.remove('open')); e.currentTarget.parentElement.classList.add('open'); } },
      } }, name), items);
    bar.append(menu);
  }
}

// Commands that views provide; shown greyed out when the current view does not.
const PLACEHOLDER_LABELS = {
  'file.save': 'Save', 'file.saveAs': 'Save As…', 'file.export': 'Export job file…', 'file.close': 'Close',
  'edit.undo': 'Undo', 'edit.redo': 'Redo', 'edit.addArea': 'Add area…', 'edit.duplicateArea': 'Duplicate area', 'edit.deleteArea': 'Delete area',
  'edit.addLine': 'Add item', 'edit.addCustom': 'Add custom item',
  'job.details': 'Job details', 'job.schedule': 'Schedule', 'job.quote': 'Create quote…', 'job.quotes': 'Quotes', 'job.costs': 'Budget & costs', 'job.history': 'History',
  'job.reprice': 'Update to latest prices…', 'job.archive': 'Archive job',
  'pb.newDraft': 'New draft from this version…', 'pb.publish': 'Publish…', 'pb.export': 'Export price book file',
};
const PLACEHOLDER_KEYS = { 'file.save': 'Ctrl+S', 'file.saveAs': 'Ctrl+Shift+S', 'edit.undo': 'Ctrl+Z', 'edit.redo': 'Ctrl+Y', 'edit.addArea': 'Alt+A', 'edit.addLine': 'Alt+L' };

document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); });

document.addEventListener('keydown', (e) => {
  if (!app.state.user || modalOpen()) return;
  const k = KEY(e);
  const inText = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !['checkbox', 'radio', 'button'].includes(e.target.type);
  if (inText && (k === 'Ctrl+Z' || k === 'Ctrl+Y' || k === 'Ctrl+Shift+Z')) return; // native text undo
  const all = [...app.viewCommands.values(), ...app.commands.values()];
  const alias = { 'Ctrl+Shift+Z': 'Ctrl+Y' };
  const c = all.find((x) => x.key && (x.key === k || x.key === alias[k]) && (!x.when || x.when()));
  if (c) { e.preventDefault(); runCommand(c.id); }
});

// ---------------- routing ----------------

const ROUTES = [
  [/^#\/dashboard$/, dashboardView, 'dashboard'],
  [/^#\/jobs(?:\?[\w=&]*)?$/, jobsView, 'jobs'],
  [/^#\/jobs\/(\d+)(?:\/(\w+))?$/, jobEditorView, 'jobs'],
  [/^#\/price-books$/, priceBooksView, 'pricebook'],
  [/^#\/price-books\/(\d+)(?:\/(\w+))?$/, priceBookEditorView, 'pricebook'],
  [/^#\/settings(?:\/(\w+))?$/, settingsView, 'settings'],
  [/^#\/calendar(?:\?[\w=&,-]*)?$/, calendarView, 'calendar'],
];

let routing = false;
let lastHash = '';
async function route() {
  if (!app.state.user) return;
  if (routing) return;
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('.reminder-panel, .filter-panel, .popup-menu').forEach((p) => p.remove());
  const found = ROUTES.find(([re]) => re.test(hash));
  if (!found) { location.hash = '#/dashboard'; return; }
  routing = true;
  try {
    if (app.view && app.view.isDirty && app.view.isDirty() && !app.view.handlesHash?.(hash)) {
      const choice = await unsavedDialog(app.view.title());
      if (choice === 'cancel') { history.replaceState(null, '', lastHash); return; }
      if (choice === 'save' && !(await app.view.save())) { history.replaceState(null, '', lastHash); return; }
    }
    if (app.view && app.view.handlesHash?.(hash)) { app.view.onHash(hash); lastHash = hash; return; }
    if (app.view && app.view.unmount) app.view.unmount();
    app.view = null;
    app.viewCommands.clear();
    const [re, mod, nav] = found;
    const params = hash.match(re).slice(1);
    document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
    const main = clear(document.getElementById('view'));
    main.append(h('div', { class: 'loading' }, 'Loading…'));
    try {
      const view = await mod.mount(main, params, app);
      app.view = view || null;
      if (view && view.commands) for (const [id, c] of Object.entries(view.commands)) app.viewCommands.set(id, { id, label: PLACEHOLDER_LABELS[id], key: PLACEHOLDER_KEYS[id], ...c });
    } catch (err) {
      fill(main, h('div', { class: 'empty' }, h('h2', null, 'This page could not be opened'), h('p', null, err.message), h('button', { class: 'btn', on: { click: () => app.navigate('#/dashboard') } }, 'Go to dashboard')));
      if (err.status !== 404) console.error(err);
    }
    lastHash = hash;
    app.refreshChrome();
  } finally {
    routing = false;
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (app.view && app.view.isDirty && app.view.isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

function updateTitle() {
  const name = app.state.info?.name || 'Pricing Platform';
  const t = app.view && app.view.title ? app.view.title() : '';
  const dirty = app.view && app.view.isDirty && app.view.isDirty();
  document.title = `${app.state.info?.environment === 'staging' ? 'TEST · ' : ''}${dirty ? '● ' : ''}${t ? `${t} — ` : ''}${name}`;
  const save = document.getElementById('status-dirty');
  if (save) { save.textContent = dirty ? 'Unsaved changes' : ''; save.hidden = !dirty; }
}
app.updateTitle = updateTitle;

// ---------------- shell ----------------

function renderShell() {
  const { user, company, info } = app.state;
  const nav = (id, label, hash, icon) => h('a', { href: hash, dataset: { nav: id } }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), h('span', null, label));
  fill(root,
    h('div', { class: 'shell' },
      info?.environment === 'staging' ? h('div', { class: 'test-banner', role: 'note' }, 'TEST SITE – separate test data. Nothing you do here changes the live site.') : null,
      h('header', { class: 'menubar' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), h('span', null, company?.name || info?.name)),
        h('nav', { id: 'menus', class: 'menus', 'aria-label': 'Application menu' }),
        h('div', { class: 'spacer' }),
        h('button', { id: 'bell', class: 'bell-btn', 'aria-label': 'Reminders', title: 'Reminders', on: { click: (e) => openReminders(e.currentTarget) } }, '🔔', h('span', { id: 'bell-count', class: 'badge bad', hidden: true })),
        h('button', { class: 'user-btn', on: { click: (e) => userMenu(e.currentTarget) } }, h('span', { class: 'avatar' }, initials(user.name)), h('span', null, user.name), h('span', { class: 'role' }, user.role))),
      h('div', { class: 'workspace' },
        h('aside', { class: 'sidebar' },
          nav('dashboard', 'Dashboard', '#/dashboard', '▦'),
          nav('jobs', 'Jobs', '#/jobs', '▤'),
          nav('calendar', 'Calendar', '#/calendar', '▣'),
          nav('pricebook', 'Price book', '#/price-books', '$'),
          app.isManager() ? nav('settings', 'Settings', '#/settings', '⚙') : null,
          h('div', { class: 'grow' }),
          h('button', { class: 'btn primary block', on: { click: () => runCommand('file.new') } }, '+ New job')),
        h('main', { id: 'view', class: 'view', tabindex: '-1' })),
      h('footer', { class: 'statusbar' },
        h('span', { id: 'status-dirty', class: 'dirty', hidden: true }),
        h('span', { id: 'status-left' }),
        h('span', { class: 'grow' }),
        h('span', null, `${info?.name || ''} ${info?.version || ''}`),
        h('span', { class: 'dot ok', title: 'Connected to server' }, 'Connected'))));
  renderMenubar();
}

function initials(name) { return (name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(); }

function userMenu(anchor) {
  popupMenu(anchor, [
    { label: 'Change my password…', onClick: () => runCommand('account.password') },
    { label: 'Keyboard shortcuts', onClick: () => runCommand('help.shortcuts') },
    '-',
    { label: 'Sign out', onClick: () => runCommand('app.signOut') },
  ]);
}

async function signOut() {
  if (app.view && app.view.isDirty && app.view.isDirty()) {
    const choice = await unsavedDialog(app.view.title());
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await app.view.save())) return;
    app.view.isDirty = () => false;
  }
  await post('/api/logout');
  location.hash = '';
  location.reload();
}

function shortcutsDialog() {
  const rows = [...app.commands.values(), ...Object.entries(PLACEHOLDER_KEYS).map(([id, key]) => ({ id, key, label: PLACEHOLDER_LABELS[id] }))]
    .filter((c) => c.key).sort((a, b) => a.label.localeCompare(b.label));
  modal({
    title: 'Keyboard shortcuts', width: 440,
    body: h('table', { class: 'table compact' }, h('tbody', null, rows.map((c) => h('tr', null, h('td', null, c.label), h('td', { class: 'num' }, h('kbd', null, c.key)))),
      h('tr', null, h('td', null, 'In the item search: move / add'), h('td', { class: 'num' }, h('kbd', null, '↑ ↓ Enter'))),
      h('tr', null, h('td', null, 'Close a dialog or menu'), h('td', { class: 'num' }, h('kbd', null, 'Esc'))))),
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

function aboutDialog() {
  const { info, company } = app.state;
  modal({
    title: `About ${info.name}`, width: 440,
    body: h('div', null,
      h('p', null, h('strong', null, `${info.name} `), `version ${info.version}`),
      h('p', { class: 'muted' }, 'Modular pricing, quoting and job costing for kitchen and joinery manufacturers.'),
      h('p', { class: 'muted' }, `Licensed to ${company?.name || '—'}.`)),
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

// ---------------- reminders ----------------

let reminderList = [];
let reminderTimer = null;
const remindedIds = new Set();

async function pollReminders() {
  if (!app.state.user) return;
  try { reminderList = await get('/api/reminders'); } catch { return; }
  const badge = document.getElementById('bell-count');
  if (badge) { badge.textContent = String(reminderList.length); badge.hidden = !reminderList.length; }
  const fresh = reminderList.filter((r) => r.kind !== 'needs_completion' && !remindedIds.has(r.id));
  fresh.forEach((r) => remindedIds.add(r.id));
  if (fresh.length) toast(fresh.length === 1 ? `Reminder: ${fresh[0].title} (${fresh[0].jobNumber}) ${whenText(fresh[0])}` : `You have ${fresh.length} upcoming events. Click the bell to see them.`, 'info', 6000);
}

function whenText(r) {
  if (r.kind === 'needs_completion') return `ended ${r.minutes < 1440 ? `${Math.max(1, Math.round(r.minutes / 60))} h` : `${Math.round(r.minutes / 1440)} d`} ago`;
  if (r.kind === 'in_progress') return 'happening now';
  return r.minutes < 60 ? `in ${r.minutes} min` : r.minutes < 1440 ? `in ${Math.round(r.minutes / 60)} h` : `in ${Math.round(r.minutes / 1440)} day${Math.round(r.minutes / 1440) === 1 ? '' : 's'}`;
}

async function openReminders(anchor) {
  await pollReminders();
  document.querySelectorAll('.reminder-panel').forEach((p) => p.remove());
  const act = async (fn) => { try { await fn(); } catch (err) { showError(err); } panel.remove(); pollReminders(); if (app.view && location.hash.startsWith('#/calendar')) route(); };
  const panel = h('div', { class: 'reminder-panel popup-menu', role: 'dialog', 'aria-label': 'Reminders' },
    h('div', { class: 'rem-head' }, h('strong', null, 'Reminders'), h('a', { href: '#/calendar', on: { click: () => panel.remove() } }, 'Open calendar')),
    reminderList.length ? reminderList.map((r) => h('div', { class: `rem ${r.kind}` },
      h('div', { class: 'rem-title' }, h('span', { class: 'type-dot', style: { background: r.colour } }), h('span', { class: 'strong' }, r.title), ' ', h('span', { class: 'muted small' }, whenText(r))),
      h('div', { class: 'muted small' }, `${r.jobNumber} · ${r.jobName} · ${fmtWhen(r)}`),
      r.kind === 'needs_completion' ? h('div', { class: 'warn-text small' }, 'Finished but not marked completed.') : r.needsConfirmation ? h('div', { class: 'warn-text small' }, 'Not confirmed yet.') : null,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', on: { click: () => { panel.remove(); openEventDialog(app, r).then((c) => { if (c) pollReminders(); }); } } }, 'Open'),
        r.kind === 'needs_completion' ? h('button', { class: 'btn small primary', on: { click: () => act(() => put(`/api/events/${r.id}`, { status: 'completed' })) } }, 'Mark completed') : null,
        r.needsConfirmation ? h('button', { class: 'btn small primary', on: { click: () => act(() => put(`/api/events/${r.id}`, { status: 'confirmed' })) } }, 'Confirm') : null,
        h('button', { class: 'btn small ghost', on: { click: () => act(() => post(`/api/events/${r.id}/dismiss`)) } }, 'Dismiss'))))
      : h('p', { class: 'muted pad' }, 'Nothing due. Reminders appear here before events, and when finished events still need to be marked completed.'));
  document.body.append(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.top = `${rect.bottom + 4}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!panel.contains(e.target) && !anchor.contains(e.target)) { panel.remove(); document.removeEventListener('mousedown', off); } }), 0);
}

// Reminders refresh once a minute, but only while this tab is visible; a hidden tab makes no requests and catches up
// as soon as it is shown again.
function startReminders() {
  clearInterval(reminderTimer);
  pollReminders();
  reminderTimer = setInterval(() => { if (!document.hidden) pollReminders(); }, 60000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && reminderTimer) pollReminders(); });

// ---------------- boot ----------------

setUnauthorizedHandler(() => {
  if (!app.state.user) return;
  app.state.user = null;
  toast('Your session has ended. Please sign in again.', 'error');
  boot();
});

async function boot() {
  try {
    const s = await get('/api/state');
    app.state = { user: s.user, company: s.company, info: s.app, setupKeyRequired: !!s.setupKeyRequired };
    setStatuses(s.statuses);
    document.documentElement.classList.toggle('is-staging', s.app?.environment === 'staging');
    if (s.setupRequired) return renderSetup(root, app, boot);
    const reset = /^#\/reset\/([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (reset && !s.user) return renderReset(root, app, reset[1], boot);
    if (!s.user) return renderLogin(root, app, boot);
    renderShell();
    if (s.user.mustChangePassword) setTimeout(() => changePasswordDialog(true), 300);
    route();
    startReminders();
  } catch (err) {
    fill(root, h('div', { class: 'center-screen' }, h('div', { class: 'card narrow' }, h('h1', null, 'Cannot start'), h('p', null, err.message), h('button', { class: 'btn primary', on: { click: boot } }, 'Try again'))));
  }
}

boot();

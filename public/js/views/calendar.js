// Calendar: week / month / staff availability / list views, filters, drag-and-drop rescheduling and reassignment.
import { get, put } from '../api.js';
import { h, clear, fill, toast, showError } from '../ui.js';
import * as D from '/shared/dates.js';
import { scheduleMeta, openEventDialog, fmtDay, fmtDayYear, fmtTime, fmtWhen, initials, statusChip, STATUS_LABEL } from './event-dialog.js';

const GRID_START = 6, GRID_END = 20, PX = 0.8; // 06:00–20:00, 48px per hour
const SNAP = 15;
const VIEWS = [['week', 'Week'], ['month', 'Month'], ['staff', 'Staff'], ['list', 'List']];
const STORE = 'calendar.v1';

export async function mount(el, _params, app) {
  const meta = await scheduleMeta(true);
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  const state = {
    view: qs.get('view') || saved.view || 'week',
    anchor: qs.get('date') || D.today(),
    staff: new Set(saved.staff || []),
    types: new Set(saved.types || []),
    statuses: new Set(saved.statuses || ['pending', 'confirmed', 'completed']),
    job: qs.get('job') || '',
    listFrom: D.today(), listTo: D.addDays(D.today(), 30),
  };
  if (qs.get('job')) state.view = qs.get('view') || 'list';
  let events = [], leave = [], jobs = [];
  let dragging = null;
  const staffById = new Map(meta.staff.map((s) => [s.id, s]));
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify({ view: state.view, staff: [...state.staff], types: [...state.types], statuses: [...state.statuses] })); } catch { /* ignore */ } };

  const toolbar = h('div', { class: 'cal-toolbar' });
  const filters = h('div', { class: 'cal-filters' });
  const legend = h('div', { class: 'cal-legend' });
  const viewEl = h('div', { class: 'cal-view' });
  clear(el).append(h('div', { class: 'page-head' }, h('h1', null, 'Calendar'), h('div', { class: 'actions' }, h('button', { class: 'btn primary', on: { click: () => newEvent({}) } }, '+ New event'))), toolbar, filters, legend, viewEl);

  function range() {
    if (state.view === 'week') { const s = D.weekStart(state.anchor); return [s, D.addDays(s, 6)]; }
    if (state.view === 'month') { const s = D.weekStart(D.monthStart(state.anchor)); return [s, D.addDays(s, 41)]; }
    if (state.view === 'staff') { const s = D.weekStart(state.anchor); return [s, D.addDays(s, 13)]; }
    return [state.listFrom, state.listTo];
  }

  async function load() {
    const [from, to] = range();
    const p = new URLSearchParams({ from, to, status: [...state.statuses].join(',') });
    if (state.staff.size && state.view !== 'staff') p.set('staff', [...state.staff].join(','));
    if (state.types.size) p.set('types', [...state.types].join(','));
    if (state.job) p.set('job', state.job);
    [events, leave] = await Promise.all([get(`/api/events?${p}`), get(`/api/leave?from=${from}&to=${to}`)]);
    render();
  }

  function title() {
    const [from, to] = range();
    if (state.view === 'month') { const m = D.monthStart(state.anchor); return D.parseDate(m).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }); }
    if (state.view === 'list') return `${fmtDayYear(from)} – ${fmtDayYear(to)}`;
    return `${fmtDay(from)} – ${fmtDayYear(to)}`;
  }
  function shift(dir) {
    const step = { week: 7, staff: 14, list: 30 }[state.view];
    if (state.view === 'month') { const d = D.parseDate(D.monthStart(state.anchor)); d.setMonth(d.getMonth() + dir); state.anchor = D.ymd(d); }
    else if (state.view === 'list') { state.listFrom = D.addDays(state.listFrom, dir * step); state.listTo = D.addDays(state.listTo, dir * step); }
    else state.anchor = D.addDays(state.anchor, dir * step);
    load();
  }

  function renderToolbar() {
    const isList = state.view === 'list';
    const from = h('input', { type: 'date', value: state.listFrom, 'aria-label': 'From date', on: { change: (e) => { state.listFrom = e.target.value; if (state.listTo < state.listFrom) state.listTo = state.listFrom; load(); } } });
    const to = h('input', { type: 'date', value: state.listTo, 'aria-label': 'To date', on: { change: (e) => { state.listTo = e.target.value; load(); } } });
    fill(toolbar,
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', on: { click: () => { state.anchor = D.today(); state.listFrom = D.today(); state.listTo = D.addDays(D.today(), 30); load(); } } }, 'Today'),
        h('button', { class: 'icon-btn', 'aria-label': 'Previous', on: { click: () => shift(-1) } }, '‹'),
        h('button', { class: 'icon-btn', 'aria-label': 'Next', on: { click: () => shift(1) } }, '›'),
        isList ? h('span', { class: 'inline-fields' }, from, h('span', { class: 'muted' }, 'to'), to) : h('h2', { class: 'cal-title' }, title())),
      h('div', { class: 'seg', role: 'tablist' }, VIEWS.map(([k, l]) => h('button', { class: k === state.view ? 'on' : '', role: 'tab', 'aria-selected': String(k === state.view), on: { click: () => { state.view = k; persist(); load(); } } }, l))));
  }

  function checklistButton(label, options, selected, onChange) {
    const btn = h('button', { class: 'btn small filter-btn' });
    const setLabel = () => { btn.textContent = `${label}: ${selected.size ? (selected.size === 1 ? options.find((o) => selected.has(o.value))?.label : `${selected.size} selected`) : 'All'} ▾`; };
    setLabel();
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-panel').forEach((p) => p.remove());
      const panel = h('div', { class: 'filter-panel' },
        h('div', { class: 'row-actions' }, h('button', { class: 'btn small ghost', on: { click: () => { selected.clear(); sync(); } } }, 'All'), h('button', { class: 'btn small ghost', on: { click: () => panel.remove() } }, 'Done')),
        options.map((o) => o.group ? h('div', { class: 'filter-group' }, o.group) : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: selected.has(o.value), on: { change: (e) => { if (e.target.checked) selected.add(o.value); else selected.delete(o.value); onChange(); setLabel(); } } }), o.swatch ? h('span', { class: 'type-dot', style: { background: o.swatch } }) : null, h('span', null, o.label))));
      const sync = () => { panel.querySelectorAll('input').forEach((i, n) => { i.checked = false; }); onChange(); setLabel(); };
      document.body.append(panel);
      const r = btn.getBoundingClientRect();
      panel.style.left = `${Math.min(r.left, innerWidth - panel.offsetWidth - 8)}px`;
      panel.style.top = `${r.bottom + 4}px`;
      setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!panel.contains(e.target) && e.target !== btn) { panel.remove(); document.removeEventListener('mousedown', off); } }), 0);
    });
    return btn;
  }

  function renderFilters() {
    const changed = () => { persist(); load(); };
    const staffOpts = [];
    for (const [cat, name] of Object.entries(meta.categories)) {
      const people = meta.staff.filter((s) => s.category === cat);
      if (!people.length) continue;
      staffOpts.push({ group: name }, ...people.map((s) => ({ value: s.id, label: s.name, swatch: s.colour })));
    }
    const jobSel = h('select', { class: 'small-select', 'aria-label': 'Job', on: { change: (e) => { state.job = e.target.value; load(); } } },
      h('option', { value: '' }, 'Job: All'), jobs.map((j) => h('option', { value: j.id, selected: String(j.id) === String(state.job) }, `${j.job_number} · ${j.name}`)));
    fill(filters,
      h('span', { class: 'muted small' }, 'Filter'),
      checklistButton('Staff', staffOpts, state.staff, changed),
      jobSel,
      checklistButton('Event', meta.types.map((t) => ({ value: t.key, label: t.name, swatch: t.colour })), state.types, changed),
      checklistButton('Status', ['pending', 'confirmed', 'completed', 'cancelled'].map((s) => ({ value: s, label: STATUS_LABEL[s] })), state.statuses, changed),
      state.staff.size || state.types.size || state.job || state.statuses.size !== 3 ? h('button', { class: 'btn small ghost', on: { click: () => { state.staff.clear(); state.types.clear(); state.job = ''; state.statuses = new Set(['pending', 'confirmed', 'completed']); persist(); renderFilters(); load(); } } }, 'Clear filters') : null,
      h('span', { class: 'grow' }),
      h('span', { class: 'muted small' }, `${events.length} event${events.length === 1 ? '' : 's'}${events.some((e) => e.conflicts.length) ? ` · ${events.filter((e) => e.conflicts.length).length} with clashes` : ''}`));
    fill(legend, meta.types.map((t) => h('span', null, h('span', { class: 'type-dot', style: { background: t.colour } }), t.name)),
      h('span', { class: 'muted' }, '· dashed = pending, solid = confirmed, faded = completed, ⚠ = clash'));
  }

  function render() {
    renderToolbar();
    renderFilters();
    clear(viewEl);
    ({ week: renderWeek, month: renderMonth, staff: renderStaff, list: renderList })[state.view]();
    app.setStatus(state.view === 'staff' ? 'Drag an event to another day or person to reschedule or reassign it. Double-click a cell to add an event.' : 'Drag events to reschedule. Double-click an empty slot to add an event.');
  }

  // ---------- event element ----------
  function evEl(ev, { compact = false, style = {} } = {}) {
    const locked = ev.status === 'completed' || ev.status === 'cancelled';
    const staffNames = ev.staffIds.map((id) => staffById.get(id)?.name).filter(Boolean);
    const el = h('div', {
      class: `ev ev-${ev.status} ${ev.conflicts.length ? 'clash' : ''} ${compact ? 'compact' : ''}`, draggable: !locked, tabindex: 0, role: 'button',
      style: { '--c': ev.colour, ...style },
      title: `${ev.title} – ${ev.jobNumber} ${ev.jobName}\n${fmtWhen(ev)}\n${STATUS_LABEL[ev.status]}${staffNames.length ? `\nStaff: ${staffNames.join(', ')}` : '\nNo staff assigned'}${ev.conflicts.length ? `\n⚠ ${ev.conflicts.map((c) => c.title).join('; ')}` : ''}`,
      on: {
        click: (e) => { e.stopPropagation(); edit(ev); },
        keydown: (e) => { if (e.key === 'Enter') edit(ev); },
        dragstart: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          dragging = { ev, grabMin: ev.allDay ? 0 : (e.clientY - r.top) / PX, fromStaff: Number(e.currentTarget.dataset.staff) || null };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(ev.id));
          setTimeout(() => e.target.classList.add('dragging'), 0);
        },
        dragend: (e) => { e.target.classList.remove('dragging'); dragging = null; document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on')); },
      },
    },
    h('div', { class: 'ev-title' }, ev.conflicts.length ? '⚠ ' : '', ev.status === 'completed' ? '✓ ' : '', ev.title),
    compact ? null : h('div', { class: 'ev-sub' }, !ev.allDay ? `${fmtTime(D.timeOf(ev.start))} · ` : '', ev.jobNumber, ev.clientName ? ` · ${ev.clientName}` : ''),
    compact ? null : h('div', { class: 'ev-staff' }, ev.staffIds.length ? ev.staffIds.map((id) => staffById.get(id)).filter(Boolean).map((s) => h('span', { class: 'staff-chip xs', style: { '--c': s.colour }, title: s.name }, initials(s.name))) : h('span', { class: 'unassigned' }, 'Unassigned')));
    return el;
  }

  async function edit(ev) {
    if (await openEventDialog(app, ev)) load();
  }
  async function newEvent(defaults) {
    if (!jobs.length) jobs = await get('/api/jobs');
    const start = defaults.start || D.at(D.today(), '09:00');
    const ev = { jobId: state.job ? Number(state.job) : defaults.jobId, typeKey: 'consultation', allDay: !!defaults.allDay, start, end: defaults.end || (defaults.allDay ? start : D.addMinutes(start, 60)), staffIds: defaults.staffIds || [], status: 'pending' };
    if (await openEventDialog(app, ev, { isNew: true, jobs })) load();
  }

  async function move(ev, patch, message) {
    try {
      const saved = await put(`/api/events/${ev.id}`, patch);
      toast(saved.conflicts.length ? `${message}. ⚠ Clashes with: ${saved.conflicts.map((c) => c.title).join('; ')}` : message, saved.conflicts.length ? 'error' : 'success', saved.conflicts.length ? 6000 : 2500);
    } catch (err) { showError(err); }
    load();
  }
  /** Shift an event by whole days, keeping its times and length. */
  function shiftDays(ev, days) {
    if (ev.allDay) return { start: D.addDays(ev.start, days), end: D.addDays(ev.end, days) };
    return { start: D.addMinutes(ev.start, days * 1440), end: D.addMinutes(ev.end, days * 1440) };
  }
  function dropTarget(node, onDrop) {
    node.addEventListener('dragover', (e) => { if (!dragging) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-on'); });
    node.addEventListener('dragleave', () => node.classList.remove('drop-on'));
    node.addEventListener('drop', (e) => { e.preventDefault(); node.classList.remove('drop-on'); if (dragging) { const d = dragging; dragging = null; onDrop(d, e); } });
  }

  // ---------- week ----------
  function renderWeek() {
    const start = D.weekStart(state.anchor);
    const days = [...Array(7)].map((_, i) => D.addDays(start, i));
    const today = D.today();
    const head = h('div', { class: 'wk-head' }, h('div', { class: 'wk-corner' }), days.map((d) => h('div', { class: `wk-day ${d === today ? 'today' : ''} ${D.isWeekend(d) ? 'weekend' : ''}` }, fmtDay(d))));

    // all-day band with lanes
    const band = h('div', { class: 'wk-band' }, h('div', { class: 'wk-corner small muted' }, 'All day'));
    const bandGrid = h('div', { class: 'wk-band-grid' });
    days.forEach((d, i) => {
      const cell = h('div', { class: `wk-band-cell ${D.isWeekend(d) ? 'weekend' : ''}`, style: { gridColumn: `${i + 1}`, gridRow: '1 / -1' }, on: { dblclick: () => newEvent({ allDay: true, start: d, end: d }) } });
      dropTarget(cell, ({ ev }) => {
        const diff = D.daysBetween(D.dateOf(ev.start), d);
        if (diff) move(ev, shiftDays(ev, diff), `Moved to ${fmtDay(d)}`);
      });
      bandGrid.append(cell);
    });
    const bandItems = [
      ...events.filter((e) => e.allDay).map((e) => ({ kind: 'ev', e, s: Math.max(0, D.daysBetween(start, e.start)), n: Math.min(6, D.daysBetween(start, e.end)) })),
      ...leave.filter((l) => !state.staff.size || state.staff.has(l.staffId)).map((l) => ({ kind: 'leave', l, s: Math.max(0, D.daysBetween(start, l.start)), n: Math.min(6, D.daysBetween(start, l.end)) })),
    ].filter((x) => x.n >= 0 && x.s <= 6).sort((a, b) => a.s - b.s || b.n - a.n);
    const laneEnds = [];
    for (const it of bandItems) {
      let lane = laneEnds.findIndex((end) => end < it.s);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(-1); }
      laneEnds[lane] = it.n;
      const style = { gridColumn: `${it.s + 1} / ${it.n + 2}`, gridRow: `${lane + 1}` };
      bandGrid.append(it.kind === 'ev' ? evEl(it.e, { compact: true, style }) : h('div', { class: 'leave-bar', style, title: it.l.reason || 'Leave' }, `${staffById.get(it.l.staffId)?.name || 'Staff'} – leave`));
    }
    bandGrid.style.gridTemplateRows = `repeat(${Math.max(1, laneEnds.length)}, 26px)`;
    band.append(bandGrid);

    // time grid
    const height = (GRID_END - GRID_START) * 60 * PX;
    const times = h('div', { class: 'wk-times', style: { height: `${height}px` } }, [...Array(GRID_END - GRID_START)].map((_, i) => h('div', { class: 'wk-time', style: { top: `${i * 60 * PX}px` } }, fmtTime(`${String(GRID_START + i).padStart(2, '0')}:00`))));
    const cols = days.map((d) => {
      const col = h('div', { class: `wk-col ${D.isWeekend(d) ? 'weekend' : ''} ${d === today ? 'today' : ''}`, style: { height: `${height}px`, backgroundSize: `100% ${60 * PX}px` } });
      const minuteAt = (clientY, grab = 0) => {
        const y = clientY - col.getBoundingClientRect().top;
        const m = Math.round((y / PX - grab) / SNAP) * SNAP + GRID_START * 60;
        return Math.max(0, Math.min(23 * 60 + 45, m));
      };
      col.addEventListener('dblclick', (e) => { if (e.target !== col) return; const m = minuteAt(e.clientY); newEvent({ start: D.at(d, D.fromMin(m)) }); });
      const marker = h('div', { class: 'drop-line', hidden: true });
      col.append(marker);
      col.addEventListener('dragover', (e) => {
        if (!dragging) return;
        e.preventDefault();
        if (dragging.ev.allDay) return;
        const m = minuteAt(e.clientY, dragging.grabMin);
        marker.hidden = false;
        marker.style.top = `${(m - GRID_START * 60) * PX}px`;
        marker.textContent = fmtTime(D.fromMin(m));
      });
      col.addEventListener('dragleave', () => { marker.hidden = true; });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        marker.hidden = true;
        if (!dragging) return;
        const { ev, grabMin } = dragging;
        dragging = null;
        if (ev.allDay) { const diff = D.daysBetween(D.dateOf(ev.start), d); if (diff) move(ev, shiftDays(ev, diff), `Moved to ${fmtDay(d)}`); return; }
        const m = minuteAt(e.clientY, grabMin);
        const dur = D.absMin(ev.end) - D.absMin(ev.start);
        const s = D.at(d, D.fromMin(m));
        if (s !== ev.start) move(ev, { start: s, end: D.addMinutes(s, dur) }, `Moved to ${fmtDay(d)} ${fmtTime(D.fromMin(m))}`);
      });
      // overlap layout
      const dayEvents = events.filter((e) => !e.allDay && D.dateOf(e.start) === d).sort((a, b) => a.start.localeCompare(b.start));
      const placed = [];
      let cluster = [], clusterEnd = -1;
      const flush = () => { const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1)); cluster.forEach((c) => { c.lanes = lanes; }); cluster = []; };
      for (const e of dayEvents) {
        const s = D.absMin(e.start), en = D.absMin(e.end);
        if (s >= clusterEnd) { flush(); clusterEnd = -1; }
        const used = new Set(cluster.filter((c) => c.en > s).map((c) => c.lane));
        let lane = 0; while (used.has(lane)) lane++;
        const item = { e, s, en, lane };
        cluster.push(item); placed.push(item);
        clusterEnd = Math.max(clusterEnd, en);
      }
      flush();
      for (const p of placed) {
        const top = Math.max(0, (p.s % 1440 - GRID_START * 60) * PX);
        const h0 = Math.max(22, (p.en - p.s) * PX - 2);
        col.append(evEl(p.e, { style: { position: 'absolute', top: `${top}px`, height: `${h0}px`, left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`, width: `calc(${100 / p.lanes}% - 4px)` } }));
      }
      return col;
    });
    const body = h('div', { class: 'wk-body' }, times, cols);
    viewEl.append(h('div', { class: 'wk' }, head, band, h('div', { class: 'wk-scroll' }, body)));
    const scroller = viewEl.querySelector('.wk-scroll');
    scroller.scrollTop = (7 - GRID_START) * 60 * PX;
  }

  // ---------- month ----------
  function renderMonth() {
    const start = D.weekStart(D.monthStart(state.anchor));
    const month = D.monthStart(state.anchor).slice(0, 7);
    const today = D.today();
    const grid = h('div', { class: 'mo' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'mo-dow' }, d)));
    for (let i = 0; i < 42; i++) {
      const d = D.addDays(start, i);
      const dayEvents = events.filter((e) => D.eventDates(e).includes(d));
      const onLeave = leave.filter((l) => (!state.staff.size || state.staff.has(l.staffId)) && d >= l.start && d <= l.end);
      const cell = h('div', { class: `mo-cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'today' : ''} ${D.isWeekend(d) ? 'weekend' : ''}`, on: { dblclick: (e) => { if (e.target.closest('.ev')) return; newEvent({ start: D.at(d, '09:00') }); } } },
        h('button', { class: 'mo-num', on: { click: () => { state.view = 'week'; state.anchor = d; load(); } } }, String(Number(d.slice(8)))),
        dayEvents.slice(0, 4).map((e) => evEl(e, { compact: true })),
        dayEvents.length > 4 ? h('button', { class: 'more', on: { click: () => { state.view = 'week'; state.anchor = d; load(); } } }, `+${dayEvents.length - 4} more`) : null,
        onLeave.length ? h('div', { class: 'leave-note', title: onLeave.map((l) => `${staffById.get(l.staffId)?.name}: ${l.reason || 'leave'}`).join('\n') }, `${onLeave.length} on leave`) : null);
      dropTarget(cell, ({ ev }) => {
        const diff = D.daysBetween(D.dateOf(ev.start), d);
        if (diff) move(ev, shiftDays(ev, diff), `Moved to ${fmtDay(d)}`);
      });
      grid.append(cell);
    }
    viewEl.append(grid);
  }

  // ---------- staff availability ----------
  function renderStaff() {
    const start = D.weekStart(state.anchor);
    const days = [...Array(14)].map((_, i) => D.addDays(start, i));
    const today = D.today();
    const people = meta.staff.filter((s) => !state.staff.size || state.staff.has(s.id));
    const table = h('div', { class: 'res', style: { gridTemplateColumns: `200px repeat(14, minmax(84px, 1fr))` } });
    table.append(h('div', { class: 'res-corner' }, 'Staff'), ...days.map((d) => h('div', { class: `res-day ${d === today ? 'today' : ''} ${D.isWeekend(d) ? 'weekend' : ''}` }, fmtDay(d))));

    const row = (person) => {
      table.append(h('div', { class: 'res-name' }, person
        ? [h('span', { class: 'staff-chip', style: { '--c': person.colour } }, initials(person.name)), h('span', null, h('span', { class: 'strong' }, person.name), h('span', { class: 'muted small' }, person.position), person.placeholder ? h('span', { class: 'chip small' }, 'Sample') : null)]
        : [h('span', { class: 'staff-chip', style: { '--c': '#9AA79F' } }, '?'), h('span', null, h('span', { class: 'strong' }, 'Unassigned'), h('span', { class: 'muted small' }, 'Drag onto a person to assign'))]));
      for (const d of days) {
        const mine = events.filter((e) => e.status !== 'cancelled' && (person ? e.staffIds.includes(person.id) : !e.staffIds.length) && D.eventDates(e).includes(d));
        const lv = person && leave.find((l) => l.staffId === person.id && d >= l.start && d <= l.end);
        const hours = person ? mine.reduce((s, e) => s + D.hoursOnDate(e, d, person.hoursPerDay), 0) : 0;
        const ratio = person ? hours / person.hoursPerDay : 0;
        const load = lv ? 'leave' : ratio === 0 ? 'free' : ratio > 1.001 ? 'over' : ratio >= 0.999 ? 'full' : 'partial';
        const cell = h('div', {
          class: `res-cell ${load} ${D.isWeekend(d) ? 'weekend' : ''} ${d === today ? 'today' : ''}`,
          title: person ? (lv ? `${person.name} on leave${lv.reason ? `: ${lv.reason}` : ''}` : `${person.name}: ${Math.round(hours * 10) / 10} of ${person.hoursPerDay} h booked`) : '',
          on: { dblclick: (e) => { if (e.target.closest('.ev')) return; newEvent({ start: D.at(d, '09:00'), staffIds: person ? [person.id] : [] }); } },
        },
        person && !D.isWeekend(d) ? h('div', { class: 'load-bar' }, h('span', { style: { width: `${Math.min(100, ratio * 100)}%` } })) : null,
        lv ? h('div', { class: 'leave-tag' }, 'Leave') : null,
        mine.map((e) => { const x = evEl(e, { compact: true }); x.dataset.staff = person ? person.id : ''; return x; }));
        dropTarget(cell, ({ ev, fromStaff }) => {
          const patch = {};
          const diff = D.daysBetween(D.dateOf(ev.start), d);
          if (diff) Object.assign(patch, shiftDays(ev, diff));
          const target = person ? person.id : null;
          if (target !== fromStaff) {
            let ids = ev.staffIds.filter((id) => id !== fromStaff);
            if (target && !ids.includes(target)) ids = [...ids, target];
            patch.staffIds = ids;
          }
          if (!Object.keys(patch).length) return;
          const who = person ? person.name : 'unassigned';
          move(ev, patch, `${ev.title}: ${diff ? `moved to ${fmtDay(d)}` : ''}${diff && patch.staffIds ? ', ' : ''}${patch.staffIds ? `assigned to ${who}` : ''}`);
        });
        table.append(cell);
      }
    };
    if (!state.staff.size && events.some((e) => !e.staffIds.length && e.status !== 'cancelled')) row(null);
    let lastCat = null;
    for (const p of people.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))) {
      if (p.category !== lastCat) { table.append(h('div', { class: 'res-cat' }, meta.categories[p.category] || p.category)); lastCat = p.category; }
      row(p);
    }
    viewEl.append(h('div', { class: 'res-wrap' }, table),
      h('div', { class: 'res-legend muted small' }, h('span', { class: 'sw free' }), 'Free', h('span', { class: 'sw partial' }), 'Partly booked', h('span', { class: 'sw full' }), 'Fully booked', h('span', { class: 'sw over' }), 'Over-booked', h('span', { class: 'sw leave' }), 'On leave'));
  }

  // ---------- list ----------
  function renderList() {
    if (!events.length) { viewEl.append(h('div', { class: 'empty' }, h('p', null, 'No events match these filters in this date range.'))); return; }
    let lastDay = null;
    const tbody = h('tbody');
    for (const e of events) {
      const day = D.dateOf(e.start);
      if (day !== lastDay) { tbody.append(h('tr', { class: 'group-row' }, h('td', { colspan: 7 }, fmtDayYear(day)))); lastDay = day; }
      const statusSel = h('select', { class: 'small-select', 'aria-label': 'Status', disabled: e.status === 'cancelled', on: { change: (x) => move(e, { status: x.target.value }, `${e.title}: ${STATUS_LABEL[x.target.value]}`) } },
        ['pending', 'confirmed', 'completed', 'cancelled'].map((s) => h('option', { value: s, selected: s === e.status }, STATUS_LABEL[s])));
      tbody.append(h('tr', { class: e.conflicts.length ? 'has-warn' : '' },
        h('td', { class: 'nowrap small' }, e.allDay ? fmtWhen(e).split(' · ').slice(1).join(' · ') || 'All day' : `${fmtTime(D.timeOf(e.start))}–${fmtTime(D.timeOf(e.end))}`),
        h('td', null, h('span', { class: 'type-dot', style: { background: e.colour } }), h('button', { class: 'link strong', on: { click: () => edit(e) } }, e.title), e.conflicts.length ? h('div', { class: 'warn-text small' }, `⚠ ${e.conflicts.map((c) => c.title).join('; ')}`) : null),
        h('td', null, h('a', { href: `#/jobs/${e.jobId}/schedule` }, e.jobNumber), h('div', { class: 'muted small' }, e.jobName)),
        h('td', { class: 'small' }, e.staffIds.map((id) => staffById.get(id)?.name).filter(Boolean).join(', ') || h('span', { class: 'unassigned' }, 'Unassigned')),
        h('td', { class: 'small muted' }, e.location),
        h('td', null, statusSel),
        h('td', null, h('button', { class: 'btn small', on: { click: () => edit(e) } }, 'Open'))));
    }
    viewEl.append(h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
      h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Event'), h('th', null, 'Job'), h('th', null, 'Staff'), h('th', null, 'Location'), h('th', null, 'Status'), h('th'))), tbody)));
  }

  jobs = await get('/api/jobs');
  await load();
  return {
    title: () => 'Calendar',
    handlesHash: (hash) => /^#\/calendar(\?.*)?$/.test(hash),
    onHash: (hash) => { const q = new URLSearchParams(hash.split('?')[1] || ''); if (q.get('job')) { state.job = q.get('job'); state.view = 'list'; } if (q.get('date')) state.anchor = q.get('date'); load(); },
    commands: { 'edit.addLine': { label: 'New event…', run: () => newEvent({}) } },
  };
}

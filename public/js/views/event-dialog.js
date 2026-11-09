// Shared scheduling helpers: metadata cache, formatting, staff availability, and the event editor dialog.
import { get, put, post, del } from '../api.js';
import { h, clear, fill, modal, confirmDialog, toast, showError } from '../ui.js';
import * as D from '/shared/dates.js';

let metaCache = null;
export async function scheduleMeta(force = false) {
  if (!metaCache || force) metaCache = await get('/api/schedule/meta');
  return metaCache;
}
export const invalidateMeta = () => { metaCache = null; };

export const STATUS_LABEL = { proposed: 'Proposed', pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled' };
export const statusChip = (s) => h('span', { class: `chip ev-${s}` }, STATUS_LABEL[s] || s);
export const REMINDER_OPTIONS = [[null, 'No reminder'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before'], [2880, '2 days before'], [10080, '1 week before']];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (s) => { const d = D.dateOf(s); return `${DOW[D.weekday(d)]} ${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]}`; };
export const fmtDayYear = (s) => `${fmtDay(s)} ${D.dateOf(s).slice(0, 4)}`;
export function fmtTime(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return `${((hh + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${hh < 12 ? 'am' : 'pm'}`;
}
export function fmtWhen(ev) {
  if (ev.allDay) {
    const n = D.daysBetween(ev.start, ev.end) + 1;
    return n === 1 ? `${fmtDay(ev.start)} · all day` : `${fmtDay(ev.start)} – ${fmtDay(ev.end)} · ${n} days`;
  }
  return `${fmtDay(ev.start)} · ${fmtTime(D.timeOf(ev.start))}–${fmtTime(D.timeOf(ev.end))}`;
}
export function fmtDuration(ev) {
  if (ev.allDay) { const n = D.daysBetween(ev.start, ev.end) + 1; return `${n} day${n > 1 ? 's' : ''}`; }
  const m = D.absMin(ev.end) - D.absMin(ev.start);
  return m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min` : `${m / 60} h`;
}
export const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export function staffChips(ids, staff) {
  return ids.map((id) => staff.find((s) => s.id === id)).filter(Boolean)
    .map((s) => h('span', { class: 'staff-chip', title: `${s.name} – ${s.position}`, style: { '--c': s.colour } }, initials(s.name)));
}

/** Availability of every staff member for a proposed time slot, ignoring the event itself. */
export async function availabilityFor(ev, staff) {
  const from = D.addDays(D.dateOf(ev.start), -1), to = D.addDays(D.dateOf(ev.end), 1);
  const [events, leave] = await Promise.all([get(`/api/events?from=${from}&to=${to}`), get(`/api/leave?from=${from}&to=${to}`)]);
  const out = new Map();
  for (const s of staff) {
    const onLeave = leave.find((l) => l.staffId === s.id && D.overlaps(ev, { allDay: true, start: l.start, end: l.end }));
    const clashes = events.filter((o) => o.id !== ev.id && o.status !== 'cancelled' && o.staffIds.includes(s.id) && D.overlaps(ev, o));
    const dates = D.eventDates(ev);
    const booked = dates.reduce((sum, d) => sum + events.filter((o) => o.id !== ev.id && o.staffIds.includes(s.id)).reduce((x, o) => x + D.hoursOnDate(o, d, s.hoursPerDay), 0), 0);
    out.set(s.id, onLeave ? { state: 'leave', label: `On leave${onLeave.reason ? ` (${onLeave.reason})` : ''}` }
      : clashes.length ? { state: 'busy', label: `Booked: ${clashes.map((c) => `${c.title} ${c.jobNumber}`).join(', ')}` }
        : { state: 'free', label: booked ? `Free · ${Math.round(booked * 10) / 10} h booked that day` : 'Free' });
  }
  return out;
}

/**
 * Open the event editor. Pass an existing event, or { jobId?, start, end, allDay, typeKey } for a new one.
 * Resolves true when something changed.
 */
export async function openEventDialog(app, ev, { isNew = false, jobs = null } = {}) {
  const meta = await scheduleMeta();
  const staff = meta.staff;
  const type = meta.types.find((t) => t.key === ev.typeKey);
  let allDay = !!ev.allDay;
  const work = { ...ev, staffIds: [...(ev.staffIds || [])] };

  const title = h('input', { value: ev.title || type?.name || '', 'aria-label': 'Title' });
  const allDayChk = h('input', { type: 'checkbox', checked: allDay });
  const date1 = h('input', { type: 'date', value: D.dateOf(ev.start) });
  const date2 = h('input', { type: 'date', value: D.dateOf(ev.end) });
  const time1 = h('input', { type: 'time', step: 900, value: D.timeOf(ev.start) || type?.defaultStart || '09:00' });
  const time2 = h('input', { type: 'time', step: 900, value: D.timeOf(ev.end) || '10:00' });
  const status = h('select', null, Object.entries(STATUS_LABEL).filter(([k]) => k !== 'proposed' || ev.status === 'proposed').map(([k, l]) => h('option', { value: k, selected: k === (ev.status || 'pending') }, l)));
  const reminder = h('select', null, REMINDER_OPTIONS.map(([v, l]) => h('option', { value: v ?? '', selected: (ev.reminderMinutes ?? (isNew ? type?.reminderMinutes ?? 1440 : null)) === v }, l)));
  const location = h('input', { value: ev.location || '', placeholder: 'Defaults to the job site address' });
  const notes = h('textarea', { rows: 2 }, ev.notes || '');
  const typeSel = isNew ? h('select', { on: { change: () => { const t = meta.types.find((x) => x.key === typeSel.value); if (t && !title.value) title.value = t.name; renderStaff(); } } },
    meta.types.map((t) => h('option', { value: t.key, selected: t.key === ev.typeKey }, t.name)), h('option', { value: 'other' }, 'Other')) : null;
  const jobSel = isNew && !ev.jobId ? h('select', null, h('option', { value: '' }, '— Choose job —'), (jobs || []).map((j) => h('option', { value: j.id }, `${j.job_number} · ${j.name}`))) : null;
  const timeRow = h('div', { class: 'inline-fields' });
  const staffBox = h('div', { class: 'staff-pick' });
  const err = h('div', { class: 'form-error', hidden: true });

  function current() {
    return allDay ? { allDay, start: date1.value, end: date2.value || date1.value }
      : { allDay, start: `${date1.value}T${time1.value}`, end: `${date1.value}T${time2.value}` };
  }
  function renderTimes() {
    fill(timeRow,
      h('label', { class: 'field' }, h('span', null, allDay ? 'From' : 'Date'), date1),
      allDay ? h('label', { class: 'field' }, h('span', null, 'To (inclusive)'), date2) : null,
      allDay ? null : h('label', { class: 'field' }, h('span', null, 'Start'), time1),
      allDay ? null : h('label', { class: 'field' }, h('span', null, 'End'), time2),
      h('label', { class: 'check inline field end' }, allDayChk, h('span', null, 'All day / multi-day')));
  }
  let seq = 0;
  async function renderStaff() {
    const my = ++seq;
    const t = current();
    const cat = (meta.types.find((x) => x.key === (typeSel ? typeSel.value : ev.typeKey)) || {}).staffCategory;
    fill(staffBox, h('div', { class: 'muted small' }, 'Checking availability…'));
    let avail = new Map();
    try { if (D.isDate(D.dateOf(t.start))) avail = await availabilityFor({ id: ev.id, ...t }, staff); } catch { /* show without availability */ }
    if (my !== seq) return;
    const groups = Object.keys(meta.categories).sort((a, b) => (b === cat) - (a === cat));
    fill(staffBox, groups.map((g) => {
      const people = staff.filter((s) => s.category === g);
      if (!people.length) return null;
      return h('div', { class: 'staff-group' },
        h('div', { class: 'staff-group-head' }, meta.categories[g], g === cat ? h('span', { class: 'chip ok small' }, 'Suggested for this event') : null),
        people.map((s) => {
          const a = avail.get(s.id) || { state: 'free', label: '' };
          return h('label', { class: `staff-opt ${a.state}` },
            h('input', { type: 'checkbox', checked: work.staffIds.includes(s.id), on: { change: (e) => { work.staffIds = e.target.checked ? [...work.staffIds, s.id] : work.staffIds.filter((x) => x !== s.id); } } }),
            h('span', { class: 'staff-chip', style: { '--c': s.colour } }, initials(s.name)),
            h('span', null, h('span', { class: 'strong' }, s.name), h('span', { class: 'muted small' }, ` ${s.position}`)),
            h('span', { class: `avail ${a.state}`, title: a.label }, a.state === 'free' ? '● Free' : a.state === 'busy' ? '● Booked' : '● Leave'));
        }));
    }));
  }
  allDayChk.addEventListener('change', () => {
    allDay = allDayChk.checked;
    if (allDay && date2.value < date1.value) date2.value = date1.value;
    renderTimes(); renderStaff();
  });
  for (const i of [date1, date2, time1, time2]) i.addEventListener('change', () => {
    if (i === date1 && (!date2.value || date2.value < date1.value)) date2.value = date1.value;
    if (i === time1 && time2.value <= time1.value) time2.value = D.fromMin(Math.min(23 * 60 + 45, D.toMin(time1.value) + 60));
    renderStaff();
  });
  renderTimes();

  const body = h('div', { class: 'form' },
    !isNew ? h('div', { class: 'ev-job' }, h('span', { class: 'type-dot', style: { background: ev.colour } }), h('a', { href: `#/jobs/${ev.jobId}/schedule` }, `${ev.jobNumber} · ${ev.jobName}`), ev.clientName ? h('span', { class: 'muted' }, ` · ${ev.clientName}`) : null) : null,
    ev.reason ? h('p', { class: 'muted small' }, `Why: ${ev.reason}`) : null,
    jobSel ? h('label', { class: 'field' }, h('span', null, 'Job'), jobSel) : null,
    h('div', { class: 'inline-fields' }, typeSel ? h('label', { class: 'field' }, h('span', null, 'Event type'), typeSel) : null, h('label', { class: 'field grow' }, h('span', null, 'Title'), title)),
    timeRow,
    h('div', { class: 'inline-fields' }, h('label', { class: 'field' }, h('span', null, 'Status'), status), h('label', { class: 'field' }, h('span', null, 'Reminder'), reminder)),
    h('div', { class: 'field' }, h('span', null, 'Assigned staff'), staffBox),
    h('label', { class: 'field' }, h('span', null, 'Location'), location),
    h('label', { class: 'field' }, h('span', null, 'Notes'), notes),
    ev.conflicts && ev.conflicts.length ? h('div', { class: 'banner warn' }, `⚠ ${ev.conflicts.map((c) => `${staff.find((s) => s.id === c.staffId)?.name || 'Staff'}: ${c.title}`).join('; ')}`) : null,
    err);
  renderStaff();

  return new Promise((resolve) => {
    let changed = false;
    const actions = [];
    if (!isNew) actions.push({ label: ev.status === 'proposed' || ev.status === 'cancelled' ? 'Delete' : 'Cancel event', kind: 'danger-ghost', onClick: async () => {
      if (!(await confirmDialog({ title: 'Remove event', message: ev.status === 'proposed' || ev.status === 'cancelled' ? `Delete "${ev.title}"?` : `Cancel "${ev.title}"? It stays in the job history as cancelled.`, confirmLabel: 'Yes', danger: true }))) return false;
      await del(`/api/events/${ev.id}`);
      changed = true;
      toast('Event removed.', 'success');
      return true;
    } });
    actions.push({ label: 'Close' });
    actions.push({ label: isNew ? 'Add event' : 'Save', kind: 'primary', onClick: async () => {
      err.hidden = true;
      const t = current();
      const payload = { ...t, title: title.value.trim(), status: status.value, staffIds: work.staffIds, location: location.value, notes: notes.value, reminderMinutes: reminder.value === '' ? null : Number(reminder.value) };
      try {
        let saved;
        if (isNew) saved = await post('/api/events', { ...payload, jobId: ev.jobId || Number(jobSel.value), typeKey: typeSel.value });
        else saved = await put(`/api/events/${ev.id}`, payload);
        changed = true;
        toast(saved.conflicts?.length ? `Saved – ${saved.conflicts.length} clash${saved.conflicts.length > 1 ? 'es' : ''} with other bookings.` : 'Event saved.', saved.conflicts?.length ? 'error' : 'success');
        return true;
      } catch (e) { err.textContent = e.message; err.hidden = false; return false; }
    } });
    modal({ title: isNew ? 'New event' : ev.title, body, width: 640, actions, onClose: () => resolve(changed) });
  });
}

// Job → Schedule tab: review the system-proposed workflow events, adjust, then confirm them onto the calendar.
import { get, post, put } from '../api.js';
import { h, clear, fill, confirmDialog, toast, showError } from '../ui.js';
import * as D from '/shared/dates.js';
import { scheduleMeta, openEventDialog, fmtWhen, fmtDuration, staffChips, statusChip, STATUS_LABEL } from './event-dialog.js';

export async function renderSchedule(container, { app, jobId, job, isDirty }) {
  const meta = await scheduleMeta(true);
  const wrap = h('section', { class: 'panel' });
  clear(container).append(wrap);
  let events = [];

  async function load() {
    try { events = await get(`/api/jobs/${jobId}/schedule`); render(); } catch (err) { showError(err); }
  }

  function render() {
    const proposed = events.filter((e) => e.status === 'proposed');
    const toConfirm = proposed.filter((e) => e.included);
    const scheduled = events.filter((e) => e.status !== 'proposed');
    const clashes = events.filter((e) => e.included && e.conflicts.length && e.status !== 'cancelled').length;
    const lost = job.status === 'lost';
    fill(wrap,
      h('div', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Workflow schedule'),
          h('p', { class: 'muted small' }, proposed.length
            ? 'The system proposed these events from the job: areas, items and estimated install hours. Untick what this job does not need, adjust dates and staff, then confirm to put them on the calendar.'
            : 'These events are on the calendar. Changes here and in the calendar are the same events.')),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn', disabled: lost, title: 'Re-run the rules against the current job. Only unconfirmed proposals are replaced.', on: { click: recalc } }, '↻ Recalculate from job'),
          h('button', { class: 'btn', disabled: lost, on: { click: addEvent } }, '+ Add event'),
          scheduled.length ? h('a', { class: 'btn', href: `#/calendar?job=${jobId}` }, 'View in calendar') : null,
          toConfirm.length ? h('button', { class: 'btn primary', disabled: lost, on: { click: confirmAll } }, `Confirm ${toConfirm.length} event${toConfirm.length === 1 ? '' : 's'} to calendar`) : null)),
      lost ? h('div', { class: 'banner warn' }, 'This job is marked missed, so its open events were cancelled.') : null,
      clashes ? h('div', { class: 'banner warn' }, `⚠ ${clashes} event${clashes === 1 ? ' has' : 's have'} a staff clash (double-booking or leave). Open the event to choose someone who is free.`) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table schedule-table' },
        h('thead', null, h('tr', null, h('th', { style: { width: '44px' } }, 'Use'), h('th', null, 'Event'), h('th', null, 'When'), h('th', null, 'Length'), h('th', null, 'Staff'), h('th', null, 'Status'), h('th'))),
        h('tbody', null, events.map(row)))),
      h('p', { class: 'muted small' }, 'Lead times, durations, staff categories and rules are set in Admin → Workflow events.'));
  }

  function row(e) {
    const isProposed = e.status === 'proposed';
    const inc = h('input', { type: 'checkbox', checked: e.included, disabled: !isProposed, 'aria-label': `Include ${e.title}`, on: { change: async (x) => { await save(e, { included: x.target.checked }); } } });
    const date = isProposed && e.included ? h('input', { type: 'date', value: D.dateOf(e.start), 'aria-label': 'Date', on: { change: async (x) => {
      const diff = D.daysBetween(D.dateOf(e.start), x.target.value);
      if (!diff) return;
      const patch = e.allDay ? { start: D.addDays(e.start, diff), end: D.addDays(e.end, diff) } : { start: D.addMinutes(e.start, diff * 1440), end: D.addMinutes(e.end, diff * 1440) };
      await save(e, patch);
    } } }) : null;
    const statusSel = !isProposed && e.status !== 'cancelled' ? h('select', { class: 'small-select', 'aria-label': 'Status', on: { change: (x) => save(e, { status: x.target.value }) } },
      ['pending', 'confirmed', 'completed', 'cancelled'].map((s) => h('option', { value: s, selected: s === e.status }, STATUS_LABEL[s]))) : statusChip(e.status);
    return h('tr', { class: `${e.included ? '' : 'excluded'} ${e.conflicts.length && e.included ? 'has-warn' : ''}` },
      h('td', null, inc),
      h('td', null, h('span', { class: 'type-dot', style: { background: e.colour } }), h('span', { class: 'strong' }, e.title), e.reason ? h('div', { class: 'muted small' }, e.reason) : null,
        e.conflicts.length && e.included ? h('div', { class: 'warn-text small' }, `⚠ ${e.conflicts.map((c) => `${meta.staff.find((s) => s.id === c.staffId)?.name}: ${c.title}`).join('; ')}`) : null),
      h('td', { class: 'nowrap' }, date || h('span', { class: e.included ? '' : 'muted' }, fmtWhen(e)), date ? h('div', { class: 'muted small' }, fmtWhen(e)) : null),
      h('td', { class: 'nowrap' }, fmtDuration(e)),
      h('td', null, e.staffIds.length ? staffChips(e.staffIds, meta.staff) : h('span', { class: 'unassigned' }, e.included ? 'Unassigned' : '—')),
      h('td', null, statusSel),
      h('td', null, e.included && e.status !== 'cancelled' ? h('button', { class: 'btn small', on: { click: async () => { if (await openEventDialog(app, e)) load(); } } }, 'Edit') : null));
  }

  async function save(e, patch) {
    try { await put(`/api/events/${e.id}`, patch); } catch (err) { showError(err); }
    load();
  }

  async function recalc() {
    if (isDirty()) { toast('Save the job first so the rules use the latest areas and items.', 'error'); return; }
    const hasEdits = events.some((e) => e.status === 'proposed');
    if (hasEdits && !(await confirmDialog({ title: 'Recalculate schedule', message: 'Re-run the rules against the saved job? Unconfirmed proposals (and any edits to them) are replaced. Events already on the calendar are kept.', confirmLabel: 'Recalculate' }))) return;
    events = await post(`/api/jobs/${jobId}/schedule/propose`);
    render();
    toast('Schedule recalculated from the job.', 'success');
  }

  async function confirmAll() {
    const unassigned = events.filter((e) => e.status === 'proposed' && e.included && !e.staffIds.length).length;
    const ok = await confirmDialog({
      title: 'Confirm schedule',
      message: `Add the ticked events to the calendar as "Pending"?${unassigned ? `\n\n${unassigned} event${unassigned === 1 ? ' has' : 's have'} no staff yet. You can assign them later in the calendar.` : ''}\n\nMark them "Confirmed" once the client and staff have agreed the times.`,
      confirmLabel: 'Add to calendar',
    });
    if (!ok) return;
    try {
      events = await post(`/api/jobs/${jobId}/schedule/confirm`);
      render();
      toast('Events added to the calendar.', 'success');
    } catch (err) { showError(err); }
  }

  async function addEvent() {
    const start = D.at(D.nextBusinessDay(D.addDays(D.today(), 1)), '09:00');
    if (await openEventDialog(app, { jobId, typeKey: 'consultation', allDay: false, start, end: D.addMinutes(start, 60), staffIds: [], status: 'pending', location: job.siteAddress }, { isNew: true })) load();
  }

  await load();
}

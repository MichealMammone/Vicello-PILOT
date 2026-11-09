// Dashboard drill-down: the records behind a figure, loaded from the server only when the figure is clicked.
import { get } from '../api.js';
import { h, fill, fmt, modal, statusChip, showError } from '../ui.js';

const PERIODS = [['all', 'All time'], ['12m', 'Last 12 months'], ['year', 'This year'], ['month', 'This month']];
const pct = (v) => (v == null ? '—' : fmt.pct(v));
const date = (v) => (v ? fmt.date(v) : '—');

// Columns per kind of list. `v` is the sort value, `show` what is displayed.
const COLS = {
  jobs: [
    { label: 'Job', v: (r) => r.name, show: (r) => [h('div', { class: 'strong' }, r.name), h('div', { class: 'muted small' }, r.jobNumber)] },
    { label: 'Client', v: (r) => r.client },
    { label: 'Staff', v: (r) => r.staff },
    { label: 'Status', v: (r) => r.status, show: (r) => statusChip(r.status, r.statusDetail) },
    { label: 'Value', v: (r) => r.value, show: (r) => fmt.money(r.value), num: true },
    { label: 'Margin', v: (r) => r.marginPct, show: (r) => pct(r.marginPct), num: true },
    { label: 'Updated', v: (r) => r.updatedAt, show: (r) => date(r.updatedAt) },
  ],
  won: [
    { label: 'Job', v: (r) => r.name, show: (r) => [h('div', { class: 'strong' }, r.name), h('div', { class: 'muted small' }, r.jobNumber)] },
    { label: 'Client', v: (r) => r.client },
    { label: 'Staff', v: (r) => r.staff },
    { label: 'Quote value', v: (r) => r.value, show: (r) => [fmt.money(r.value), r.acceptedQuote ? h('div', { class: 'muted small' }, `accepted ${r.acceptedQuote}`) : null], num: true },
    { label: 'Award date', v: (r) => r.awardDate, show: (r) => date(r.awardDate) },
    { label: 'Status', v: (r) => r.status, show: (r) => statusChip(r.status, r.statusDetail) },
    { label: 'Notes', v: (r) => r.notes, show: (r) => h('span', { class: 'muted small clamp' }, r.notes || '—') },
  ],
  lost: [
    { label: 'Job', v: (r) => r.name, show: (r) => [h('div', { class: 'strong' }, r.name), h('div', { class: 'muted small' }, r.jobNumber)] },
    { label: 'Client', v: (r) => r.client },
    { label: 'Staff', v: (r) => r.staff },
    { label: 'Quote value', v: (r) => r.value, show: (r) => fmt.money(r.value), num: true },
    { label: 'Date missed', v: (r) => r.lostDate, show: (r) => date(r.lostDate) },
    { label: 'Reason / notes', v: (r) => r.lossReason, show: (r) => h('span', { class: 'muted small clamp' }, r.lossReason || '—') },
  ],
};

/** Sortable, filterable table. onRow(row) when a row is chosen. */
function recordTable(rows, cols, { onRow, total } = {}) {
  let sortIdx = -1, dir = 1, q = '';
  const tbody = h('tbody');
  const thead = h('thead');
  const foot = h('div', { class: 'muted small drill-foot' });
  const filter = h('input', { type: 'search', placeholder: 'Filter these records…', 'aria-label': 'Filter records', on: { input: (e) => { q = e.target.value.toLowerCase(); render(); } } });
  function render() {
    let list = rows.filter((r) => !q || cols.some((c) => String(c.v(r) ?? '').toLowerCase().includes(q)));
    if (sortIdx >= 0) {
      const c = cols[sortIdx];
      list = [...list].sort((a, b) => {
        const x = c.v(a), y = c.v(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
      });
    }
    fill(thead, h('tr', null, cols.map((c, i) => h('th', { class: c.num ? 'num' : '', 'aria-sort': i === sortIdx ? (dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { class: 'th-sort', on: { click: () => { dir = i === sortIdx ? -dir : 1; sortIdx = i; render(); } } }, c.label, i === sortIdx ? (dir > 0 ? ' ▲' : ' ▼') : '')))));
    fill(tbody, list.length ? list.map((r) => h('tr', { tabindex: onRow ? 0 : null, on: onRow ? { click: () => onRow(r), keydown: (e) => { if (e.key === 'Enter') onRow(r); } } : null },
      cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.show ? c.show(r) : (c.v(r) || '—')))))
      : h('tr', null, h('td', { colspan: cols.length, class: 'muted' }, rows.length ? 'No records match the filter.' : 'No records.')));
    fill(foot, `${list.length} record${list.length === 1 ? '' : 's'}${total ? ` · ${total(list)}` : ''}`);
  }
  render();
  return h('div', { class: 'drill-table' }, rows.length > 5 ? filter : null, h('div', { class: 'table-wrap' }, h('table', { class: `table compact ${onRow ? 'clickable' : ''}` }, thead, tbody)), foot);
}

export async function openDrill(app, metric, { period = 'all' } = {}) {
  const body = h('div', { class: 'drill' }, h('p', { class: 'muted' }, 'Loading…'));
  const status = /^status:(\w+)$/.exec(metric);
  const dlg = modal({
    title: 'Details', body, width: 1080,
    actions: [status ? { label: 'Open in Jobs list', onClick: () => app.navigate(`#/jobs?status=${status[1]}`) } : null, { label: 'Close', kind: 'primary' }].filter(Boolean),
  });
  const openJob = (r) => { dlg.close(); app.navigate(`#/jobs/${r.id}`); };
  async function load(p) {
    let d;
    try { d = await get(`/api/dashboard/drill?metric=${encodeURIComponent(metric)}&period=${p}`); } catch (err) { dlg.close(); showError(err); return; }
    dlg.el.querySelector('.modal-head h2').textContent = d.title;
    if (d.kind === 'performance') return fill(body, performanceView(app, d, (np) => load(np), dlg));
    const sum = (list) => `${fmt.money(list.reduce((s, r) => s + (r.value || 0), 0))} total value`;
    fill(body, recordTable(d.rows, COLS[d.kind] || COLS.jobs, { onRow: openJob, total: sum }), h('p', { class: 'muted small' }, 'Click a row to open the job.'));
  }
  load(period);
}

function performanceView(app, d, reload, dlg) {
  const t = d.team;
  const periodSel = h('select', { 'aria-label': 'Period', on: { change: (e) => reload(e.target.value) } }, PERIODS.map(([v, l]) => h('option', { value: v, selected: v === d.period }, l)));
  const kpi = (label, value, sub, onClick) => h(onClick ? 'button' : 'div', { class: `kpi ${onClick ? 'drill' : ''}`, type: onClick ? 'button' : null, on: onClick ? { click: onClick } : null },
    h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-sub' }, sub));
  const goList = (metric) => () => { dlg.close(); openDrill(app, metric, { period: d.period }); };
  // Counted in jobs only: "Jobs quoted" (no separate quote count, which repeated it).
  const staffCols = [
    { label: 'Staff member', v: (r) => r.staff },
    { label: 'Jobs quoted', v: (r) => r.jobsQuoted, num: true },
    { label: 'Won', v: (r) => r.jobsWon, num: true },
    { label: 'Missed', v: (r) => r.jobsLost, num: true },
    { label: 'Win %', v: (r) => r.winPct, show: (r) => pct(r.winPct), num: true },
    { label: 'Missed %', v: (r) => r.lossPct, show: (r) => pct(r.lossPct), num: true },
    { label: 'Revenue won', v: (r) => r.revenueWon, show: (r) => fmt.money(r.revenueWon), num: true },
    { label: 'Revenue missed', v: (r) => r.revenueLost, show: (r) => fmt.money(r.revenueLost), num: true },
    { label: 'Conversion %', v: (r) => r.conversionPct, show: (r) => pct(r.conversionPct), num: true },
    { label: 'Avg margin (won)', v: (r) => r.avgWonMarginPct, show: (r) => pct(r.avgWonMarginPct), num: true },
  ];
  return h('div', null,
    h('div', { class: 'drill-tools' }, h('label', null, h('span', { class: 'muted small' }, 'Period '), periodSel)),
    h('div', { class: 'kpis drill-kpis' },
      kpi('Jobs quoted', String(t.jobsQuoted), 'Jobs with at least one quote'),
      kpi('Jobs won', String(t.jobsWon), 'Click to see them', goList('won')),
      kpi('Jobs missed', String(t.jobsLost), 'Click to see them', goList('lost')),
      kpi('Win %', pct(t.winPct), 'Won ÷ (won + missed)'),
      kpi('Missed %', pct(t.lossPct), 'Missed ÷ (won + missed)'),
      kpi('Revenue won', fmt.money(t.revenueWon), 'Accepted quote value (or job value)'),
      kpi('Revenue missed', fmt.money(t.revenueLost), 'Latest quote value (or job value)'),
      kpi('Conversion %', pct(t.conversionPct), 'Quoted jobs that were won')),
    h('h3', null, 'Staff performance'),
    recordTable([...d.staff], staffCols),
    h('h3', null, 'Team'),
    recordTable([{ staff: 'Whole team', ...t }], staffCols),
    h('p', { class: 'muted small' }, 'Staff member is the job\'s designer. Won means the job\'s status is Won, In production, Installing or Complete; the award date is when its quote was accepted or its status was first set to Won. Missed means the job\'s status is Missed.'));
}

import { get } from '../api.js';
import { fmtWhen, statusChip as evStatusChip } from './event-dialog.js';
import { h, clear, fill, fmt, statusChip, STATUS_LABELS } from '../ui.js';
import { openDrill } from './drilldown.js';

export async function mount(el, _params, app) {
  const d = await get('/api/dashboard');
  const k = d.kpis;
  const floor = app.state.company?.floorMargin ?? 0.3;
  const maxSell = Math.max(1, ...d.pipeline.map((p) => p.sell));
  // Every figure opens the records behind it (loaded on click, see drilldown.js). The layout is unchanged.
  const drill = (metric) => ({ class: 'drill', role: 'button', tabindex: 0, title: 'Click to see the records behind this figure',
    on: { click: () => openDrill(app, metric), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrill(app, metric); } } } });
  const tile = (label, value, sub, cls = '', metric = null) => {
    const d = metric ? drill(metric) : {};
    return h('div', { ...d, class: `kpi ${cls} ${d.class || ''}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-sub' }, sub));
  };
  const open = (id) => app.navigate(`#/jobs/${id}`);

  fill(el, 
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, app.state.company?.name), h('h1', null, 'Dashboard')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', on: { click: () => app.run('file.open') } }, 'Open job…'), h('button', { class: 'btn primary', on: { click: () => app.run('file.new') } }, '+ New job'))),
    h('div', { class: 'kpis' },
      tile('Open quotes', fmt.money0(k.openSell), `${k.openCount} job${k.openCount === 1 ? '' : 's'} in enquiry, quoting or quoted`, '', 'open'),
      tile('Quoted margin', k.openSell ? fmt.pct(k.quotedMarginPct) : '—', `Floor is ${fmt.pct(floor, 0)}`, k.quotedMarginPct && k.quotedMarginPct < floor ? 'bad' : '', 'quoted'),
      tile('Won this month', fmt.money0(k.wonMonthSell), `${k.wonMonthCount} accepted quote${k.wonMonthCount === 1 ? '' : 's'}`, '', 'won-month'),
      tile('Active jobs', String(k.activeCount), `${fmt.hours(k.activeHours)} of estimated labour`, '', 'active'),
      tile('Win rate', k.winRate == null ? '—' : fmt.pct(k.winRate, 0), 'Won vs missed, all time', '', 'performance')),
    h('div', { class: 'grid-2' },
      h('section', { class: 'panel' },
        h('h2', null, 'Pipeline'),
        h('div', { class: 'bars' }, d.pipeline.map((p) => h('button', { class: 'bar-row', title: 'Click to see these jobs', on: { click: () => openDrill(app, `status:${p.status}`) } },
          h('span', null, STATUS_LABELS[p.status]),
          h('span', { class: 'bar-track' }, h('span', { class: `bar-fill st-${p.status}`, style: { width: `${(p.sell / maxSell) * 100}%` } })),
          h('span', { class: 'num' }, `${p.n} · ${fmt.money0(p.sell)}`))))),
      h('section', { class: 'panel' },
        h('h2', null, 'Recently updated'),
        d.recent.length ? h('table', { class: 'table compact clickable' }, h('tbody', null, d.recent.map((j) => h('tr', { tabindex: 0, on: { click: () => open(j.id), keydown: (e) => e.key === 'Enter' && open(j.id) } },
          h('td', null, h('div', { class: 'strong' }, j.name), h('div', { class: 'muted small' }, `${j.job_number} · ${j.client_name || 'No client'}`)),
          h('td', null, statusChip(j.status, j.status_detail)),
          h('td', { class: 'num' }, fmt.money0(j.total_sell), h('div', { class: 'muted small' }, fmt.ago(j.updated_at)))))))
          : h('div', { class: 'empty small' }, h('p', null, 'No jobs yet.'), h('button', { class: 'btn primary', on: { click: () => app.run('file.new') } }, 'Create the first job')))),
    h('section', { class: 'panel', style: { marginBottom: '16px' } },
      h('div', { class: 'panel-head' }, h('h2', null, 'Next 7 days'), h('a', { href: '#/calendar' }, 'Open calendar')),
      d.upcoming.length ? h('table', { class: 'table compact clickable' }, h('tbody', null, d.upcoming.slice(0, 12).map((e) => h('tr', { on: { click: () => app.navigate(`#/jobs/${e.jobId}/schedule`) } },
        h('td', { class: 'nowrap small' }, fmtWhen(e)),
        h('td', null, h('span', { class: 'type-dot', style: { background: e.colour } }), h('span', { class: 'strong' }, e.title), e.conflicts.length ? h('span', { class: 'warn-text small' }, ' ⚠ clash') : null),
        h('td', null, `${e.jobNumber} · ${e.jobName}`),
        h('td', { class: 'small' }, e.staffIds.length ? `${e.staffIds.length} staff` : h('span', { class: 'unassigned' }, 'Unassigned')),
        h('td', null, evStatusChip(e.status))))))
        : h('p', { class: 'muted' }, 'Nothing scheduled in the next 7 days. Confirm a job\'s schedule on its Schedule tab to see events here.')),
    h('div', { class: 'grid-2' },
      h('section', { class: 'panel' },
        h('h2', null, 'Budget vs actual – accepted jobs'),
        d.watch.length ? h('table', { class: 'table compact clickable' },
          h('thead', null, h('tr', null, h('th', null, 'Job'), h('th', { class: 'num' }, 'Budget'), h('th', { class: 'num' }, 'Actual'), h('th', null, 'Burn'))),
          h('tbody', null, d.watch.map((w) => h('tr', { on: { click: () => app.navigate(`#/jobs/${w.id}/costs`) } },
            h('td', null, h('div', { class: 'strong' }, w.name), h('div', { class: 'muted small' }, w.job_number)),
            h('td', { class: 'num' }, fmt.money0(w.budget)), h('td', { class: 'num' }, fmt.money0(w.actual)),
            h('td', null, h('div', { class: 'burn' }, h('span', { class: w.burn > 1 ? 'over' : w.burn > 0.8 ? 'warn' : '', style: { width: `${Math.min(100, w.burn * 100)}%` } })), h('div', { class: 'muted small' }, fmt.pct(w.burn, 0)))))))
          : h('p', { class: 'muted' }, 'Accepted jobs appear here once costs are recorded against them.')),
      h('section', { class: 'panel' },
        h('h2', null, 'Price book'),
        d.priceBook.current ? h('dl', { class: 'facts' },
          h('dt', null, 'Current version'), h('dd', null, h('a', { href: `#/price-books/${d.priceBook.current.id}` }, d.priceBook.current.label), h('span', { class: 'muted' }, ` · published ${fmt.date(d.priceBook.current.published_at)}`)),
          h('dt', null, 'Drafts in progress'), h('dd', null, String(d.priceBook.drafts)),
          h('dt', null, 'Open jobs on older prices'), h('dd', null, d.priceBook.staleJobs ? h('button', { class: 'chip warn as-btn', title: 'Click to see these jobs', on: { click: () => openDrill(app, 'stale') } }, `${d.priceBook.staleJobs} job${d.priceBook.staleJobs === 1 ? '' : 's'}`) : 'None'))
          : h('p', null, 'No published price book.'),
        d.byDesigner.length ? h('div', null, h('h3', null, 'Pipeline by designer'), h('table', { class: 'table compact clickable' }, h('tbody', null, d.byDesigner.map((r) => h('tr', { ...drill(`staff:${r.designer_id ?? 'none'}`), class: '' },
          h('td', null, r.designer), h('td', { class: 'num' }, `${r.n} jobs`), h('td', { class: 'num' }, fmt.money0(r.sell)), h('td', { class: 'num' }, r.sell ? fmt.pct((r.sell - r.cost) / r.sell) : '—')))))) : null)));
  app.setStatus('');
  return { title: () => 'Dashboard' };
}

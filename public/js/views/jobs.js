// Jobs list plus the File → New / Open / Import dialogs.
import { get, post, pickFile } from '../api.js';
import { h, clear, fill, fmt, statusChip, STATUS_LABELS, modal, formDialog, toast, showError } from '../ui.js';

export async function mount(el, _params, app) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { q: '', status: qs.get('status') || '', archived: false };
  const tbody = h('tbody');
  const count = h('span', { class: 'muted' });

  async function load() {
    const params = new URLSearchParams({ q: state.q, status: state.status, archived: state.archived ? '1' : '' });
    const rows = await get(`/api/jobs?${params}`);
    clear(tbody);
    count.textContent = `${rows.length} job${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      tbody.append(h('tr', null, h('td', { colspan: 8, class: 'empty-cell' }, state.q || state.status ? 'No jobs match these filters.' : 'No jobs yet. Use File → New job to create one.')));
      return;
    }
    for (const j of rows) {
      const margin = j.total_sell ? (j.total_sell - j.total_cost) / j.total_sell : null;
      const open = () => app.navigate(`#/jobs/${j.id}`);
      tbody.append(h('tr', { tabindex: 0, on: { dblclick: open, keydown: (e) => e.key === 'Enter' && open(), click: (e) => { if (e.target.closest('a')) return; open(); } } },
        h('td', { class: 'mono' }, j.job_number),
        h('td', null, h('a', { href: `#/jobs/${j.id}`, class: 'strong' }, j.name), h('div', { class: 'muted small' }, j.client_name || '—')),
        h('td', null, statusChip(j.status, j.status_detail)),
        h('td', { class: 'num' }, String(j.area_count)),
        h('td', { class: 'num' }, fmt.money0(j.total_sell)),
        h('td', { class: 'num' }, margin == null ? '—' : fmt.pct(margin)),
        h('td', null, h('span', { class: 'small' }, j.price_book_label)),
        h('td', null, h('div', { class: 'small' }, fmt.ago(j.updated_at)), h('div', { class: 'muted small' }, j.updated_by_name || ''))));
    }
  }

  let timer;
  const search = h('input', { type: 'search', placeholder: 'Search job number, name, client, address…', 'aria-label': 'Search jobs', value: state.q, on: { input: (e) => { state.q = e.target.value; clearTimeout(timer); timer = setTimeout(load, 200); } } });
  const statusSel = h('select', { 'aria-label': 'Status', on: { change: (e) => { state.status = e.target.value; load(); } } },
    h('option', { value: '' }, 'All statuses'), Object.entries(STATUS_LABELS).map(([v, l]) => h('option', { value: v, selected: v === state.status }, l)));
  const archivedChk = h('label', { class: 'check inline' }, h('input', { type: 'checkbox', on: { change: (e) => { state.archived = e.target.checked; load(); } } }), h('span', null, 'Show archived'));

  fill(el, 
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Jobs'), count),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', on: { click: () => app.run('file.import') } }, 'Import job file…'),
        h('button', { class: 'btn primary', on: { click: () => app.run('file.new') } }, '+ New job'))),
    h('div', { class: 'toolbar' }, search, statusSel, archivedChk),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table clickable' },
      h('thead', null, h('tr', null, h('th', null, 'Job no.'), h('th', null, 'Job / client'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Areas'),
        h('th', { class: 'num' }, 'Sell (ex GST)'), h('th', { class: 'num' }, 'Margin'), h('th', null, 'Price book'), h('th', null, 'Updated'))),
      tbody)));
  await load();
  search.focus();
  app.setStatus('Double-click or press Enter to open a job.');
  return { title: () => 'Jobs' };
}

export async function newJobDialog(app) {
  const [templates, book] = await Promise.all([get('/api/templates'), get('/api/price-books').then((r) => r.currentId && get(`/api/price-books/${r.currentId}`))]);
  if (!book) { toast('Publish a price book before creating jobs.', 'error'); return; }
  const values = await formDialog({
    title: 'New job', submitLabel: 'Create job', width: 560,
    fields: [
      { name: 'name', label: 'Job name', required: true, autofocus: true, placeholder: 'e.g. Nguyen residence – kitchen & robes' },
      { name: 'clientName', label: 'Client name' },
      { name: 'siteAddress', label: 'Site address' },
      { name: 'tierKey', label: 'Price tier', type: 'select', value: (book.tiers.find((t) => t.isDefault) || book.tiers[0]).key, options: book.tiers.map((t) => ({ value: t.key, label: `${t.name} (${t.markup}% markup)` })) },
      templates.length ? { name: 'templateIds', label: 'Start with these areas', type: 'checklist', value: [], options: templates.map((t) => ({ value: String(t.id), label: t.name })), help: 'Leave empty to start with one blank area. You can add any number of areas later.' } : null,
    ].filter(Boolean),
    intro: `Prices come from "${book.label}". The job keeps these prices even if the price book changes later.`,
  });
  if (!values) return;
  const { id } = await post('/api/jobs', { ...values, templateIds: (values.templateIds || []).map(Number) });
  toast('Job created.', 'success');
  app.navigate(`#/jobs/${id}`);
}

export async function openJobDialog(app) {
  const list = h('div', { class: 'open-list' });
  const input = h('input', { type: 'search', placeholder: 'Type to search jobs…', 'aria-label': 'Search jobs', autofocus: true });
  let rows = [];
  let sel = 0;
  const dlg = modal({ title: 'Open job', width: 640, body: h('div', null, input, list), actions: [{ label: 'Cancel' }, { label: 'Open', kind: 'primary', onClick: () => { if (rows[sel]) { go(rows[sel].id); } return false; } }] });
  const go = (id) => { dlg.close(); app.navigate(`#/jobs/${id}`); };
  function render() {
    clear(list);
    if (!rows.length) { list.append(h('p', { class: 'muted' }, 'No matching jobs.')); return; }
    rows.slice(0, 50).forEach((j, i) => list.append(h('button', { class: `open-row ${i === sel ? 'sel' : ''}`, on: { click: () => go(j.id), mousemove: () => { if (sel !== i) { sel = i; render(); } } } },
      h('span', { class: 'mono' }, j.job_number), h('span', { class: 'strong' }, j.name), h('span', { class: 'muted' }, j.client_name || ''), statusChip(j.status))));
  }
  async function load() { rows = await get(`/api/jobs?q=${encodeURIComponent(input.value)}`); sel = 0; render(); }
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 150); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(rows.length - 1, sel + 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    if (e.key === 'Enter' && rows[sel]) { e.preventDefault(); e.stopPropagation(); go(rows[sel].id); }
  });
  load();
}

export async function importJobFile(app) {
  const f = await pickFile('.json,.job.json,application/json');
  if (!f) return;
  let data;
  try { data = JSON.parse(f.text); } catch { toast('That file is not a valid job file.', 'error'); return; }
  try {
    const r = await post('/api/jobs/import', data);
    if (r.missingModules.length) toast(`Imported. ${r.missingModules.length} item type(s) are not in your price book and need replacing.`, 'error', 8000);
    else toast('Job imported and priced with your current price book.', 'success');
    app.navigate(`#/jobs/${r.id}`);
  } catch (err) { showError(err); }
}

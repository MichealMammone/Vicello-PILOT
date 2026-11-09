// Price book editor. Drafts are edited locally as a list of change operations; Save applies them in one transaction.
import { get, post, download } from '../api.js';
import { h, clear, fill, fmt, modal, formDialog, confirmDialog, toast, showError, popupMenu } from '../ui.js';
import { newDraft } from './pricebooks.js';
import { unitCostOf } from '/shared/pricing.js';

const TABS = [['modules', 'Modules & options'], ['labour', 'Labour rates'], ['tiers', 'Price tiers'], ['finishes', 'Finish groups'], ['materials', 'Material reference'], ['changes', 'Changes'], ['check', 'Spreadsheet check']];
const CHECK_STATUS = { ok: ['Match', 'ok'], price_mismatch: ['Price mismatch', 'bad'], missing: ['Missing from price book', 'bad'], extra: ['Not in spreadsheet', 'warn'], name_mismatch: ['Name differs', 'warn'], duplicate: ['Duplicate name', 'warn'], mapping: ['Mapping issue', 'warn'], sheet_conflict: ['Check spreadsheet row', 'warn'] };
const UOMS = { LM: 'Lineal metre', EA: 'Each', M2: 'Square metre', JOB: 'Per job', HR: 'Hour' };

export async function mount(el, params, app) {
  const bookId = Number(params[0]);
  let book = await get(`/api/price-books/${bookId}`);
  let work = structuredClone(book);
  let changes = [];
  let tab = TABS.some(([k]) => k === params[1]) ? params[1] : 'modules';
  let selKey = work.modules[0]?.key || null;
  let filter = { q: '', cat: '' };
  const editable = () => work.status === 'draft' && app.isManager();
  const isDirty = () => changes.length > 0;
  const trades = () => new Map(work.trades.map((t) => [t.key, t]));
  const defTier = () => work.tiers.find((t) => t.isDefault) || work.tiers[0];

  // ---------- change tracking ----------
  function record(key, makeOp, fields) {
    let op = changes.find((c) => c.__key === key);
    if (!op) { op = { __key: key, ...makeOp(), fields: {} }; changes.push(op); }
    Object.assign(op.fields, fields);
    touched();
  }
  function setOption(m, o, fields) {
    Object.assign(o, fields);
    if (o.__op) Object.assign(o.__op.option || o.__op, fields);
    else if (m.__op) syncNewModule(m);
    else record(`opt|${m.key}|${o.key}`, () => ({ op: 'option.update', moduleKey: m.key, optionKey: o.key }), fields);
  }
  function setModule(m, fields) {
    Object.assign(m, fields);
    if (m.__op) syncNewModule(m);
    else record(`mod|${m.key}`, () => ({ op: 'module.update', key: m.key }), fields);
  }
  function syncNewModule(m) {
    m.__op.module = { name: m.name, category: m.category, uom: m.uom, description: m.description, labour: m.labour, options: m.options.map((o) => ({ name: o.name, finishGroups: o.finishGroups, material: o.material, hardware: o.hardware, labourFactor: o.labourFactor, labourCost: o.labourCost, available: o.available, note: o.note })) };
    touched();
  }
  function push(op) { changes.push(op); touched(); return op; }
  function touched() { app.updateTitle(); renderHead(); }
  const payload = () => changes.map(({ __key, ...c }) => (c.fields && !Object.keys(c.fields).length ? { ...c, fields: undefined } : c));

  // ---------- costs (same engine as job pricing) ----------
  const idx = () => ({ trades: trades() });
  const labourCost = (m, o) => unitCostOf(m, o || { labourFactor: 1 }, idx()).labour;
  const unitCost = (m, o) => unitCostOf(m, o, idx()).unitCost;
  // Options imported from the Material + Labour spreadsheet carry labour in dollars per trade.
  const hasDollarLabour = (m) => m.options.some((o) => o.labourCost && Object.keys(o.labourCost).length);

  // ---------- layout ----------
  const headEl = h('div', { class: 'page-head pb-head' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const bodyEl = h('div', { class: 'pb-body' });
  fill(el, headEl, tabsEl, bodyEl);

  function renderHead() {
    const st = { draft: ['Draft', 'warn'], published: ['Published', 'ok'], archived: ['Archived', ''] }[work.status];
    fill(headEl, 
      h('div', null,
        h('div', { class: 'eyebrow' }, h('a', { href: '#/price-books' }, 'Price book'), ' / version ', String(work.id)),
        h('h1', null, work.label, ' ', h('span', { class: `chip ${st[1]}` }, st[0]), isDirty() ? h('span', { class: 'chip warn' }, `${changes.length} unsaved change${changes.length === 1 ? '' : 's'}`) : null),
        h('p', { class: 'muted small' }, work.status === 'draft' ? `Based on version ${work.basedOnId || '—'} · last saved ${fmt.ago(work.updatedAt)}` : `Published ${fmt.date(work.publishedAt)} · effective ${fmt.date(work.effectiveFrom)}`)),
      h('div', { class: 'actions' },
        app.isManager() ? h('button', { class: 'btn', on: { click: () => app.run('file.saveAs') } }, 'Save As new draft…') : null,
        editable() ? h('button', { class: 'btn', disabled: !isDirty(), on: { click: discard } }, 'Discard changes') : null,
        editable() ? h('button', { class: `btn ${isDirty() ? 'primary' : ''}`, disabled: !isDirty(), on: { click: () => app.run('file.save') } }, isDirty() ? 'Save draft' : 'Saved') : null,
        editable() ? h('button', { class: 'btn accent', on: { click: () => app.run('pb.publish') } }, 'Publish…') : null));
  }

  function renderTabs() {
    fill(tabsEl, ...TABS.map(([k, label]) => h('a', { role: 'tab', class: k === tab ? 'on' : '', 'aria-selected': String(k === tab), href: `#/price-books/${bookId}${k === 'modules' ? '' : `/${k}`}` }, label)));
  }

  function renderBody() {
    renderTabs();
    clear(bodyEl);
    if (!editable()) bodyEl.append(h('div', { class: 'banner' }, work.status === 'draft' ? 'Only owners and admins can edit prices.' : 'This version is published and locked so existing jobs and quotes never change. Use "Save As new draft" to prepare new prices.'));
    ({ modules: renderModules, labour: renderLabour, tiers: renderTiers, finishes: renderFinishes, materials: renderMaterials, changes: renderChanges, check: renderCheck })[tab]();
  }

  // Any decimal is accepted and kept exactly; whole numbers are shown with two decimals (9 → 9.00).
  const numIn = (value, onInput, attrs = {}) => {
    const i = h('input', { type: 'number', min: 0, class: 'num-in', value: fmt.dec2(value ?? ''), disabled: !editable(), ...attrs, step: 'any' });
    i.addEventListener('input', () => { if (i.value !== '' && Number(i.value) >= 0) onInput(Number(i.value)); });
    return i;
  };
  const txtIn = (value, onInput, attrs = {}) => {
    const i = h('input', { value: value ?? '', disabled: !editable(), ...attrs });
    i.addEventListener('input', () => onInput(i.value));
    return i;
  };

  // ---------- modules ----------
  function renderModules() {
    const cats = [...new Set(work.modules.map((m) => m.category))].sort();
    const list = h('div', { class: 'mod-list' });
    const detail = h('section', { class: 'mod-detail' });
    function renderList() {
      clear(list);
      const q = filter.q.toLowerCase();
      const items = work.modules.filter((m) => (!filter.cat || m.category === filter.cat) && (!q || `${m.name} ${m.options.map((o) => o.name).join(' ')}`.toLowerCase().includes(q)))
        .sort((a, b) => a.category.localeCompare(b.category) || (a.sort ?? 0) - (b.sort ?? 0));
      let lastCat = null;
      for (const m of items) {
        if (m.category !== lastCat) { list.append(h('div', { class: 'mod-cat' }, m.category)); lastCat = m.category; }
        const issues = m.options.filter((o) => o.available === false).length;
        list.append(h('button', { class: `mod-item ${m.key === selKey ? 'on' : ''} ${m.active === false ? 'inactive' : ''}`, on: { click: () => { selKey = m.key; renderList(); renderDetail(); } } },
          h('span', null, m.name), h('span', { class: 'muted small' }, `${m.options.length} · ${m.uom}${issues ? ` · ${issues} off` : ''}`)));
      }
      if (!items.length) list.append(h('p', { class: 'muted pad' }, 'No modules match.'));
    }
    function renderDetail() {
      clear(detail);
      const m = work.modules.find((x) => x.key === selKey);
      if (!m) { detail.append(h('div', { class: 'empty' }, h('p', null, 'Select a module.'))); return; }
      const dis = !editable();
      const t = trades();
      const tier = defTier();
      const rows = new Map();
      const refreshCosts = () => {
        for (const o of m.options) {
          const r = rows.get(o);
          if (!r) continue;
          const uc = unitCost(m, o);
          r.cost.textContent = fmt.money(uc);
          r.sell.textContent = fmt.money(uc * (1 + tier.markup / 100));
          r.row.classList.toggle('has-error', o.available !== false && uc <= 0);
        }
        if (!dollarLabour) labTotal.textContent = `${fmt.money(labourCost(m))} per ${m.uom === 'LM' ? 'metre' : 'unit'} at 100%`;
      };
      const labTotal = h('span', { class: 'muted small' });
      const dollarLabour = hasDollarLabour(m);
      const setLabour = (o, key, v) => { setOption(m, o, { labourCost: { ...(o.labourCost || {}), [key]: v } }); refreshCosts(); };
      detail.append(
        h('div', { class: 'mod-head' },
          h('label', { class: 'field grow' }, h('span', null, 'Module name'), txtIn(m.name, (v) => setModule(m, { name: v }))),
          h('label', { class: 'field' }, h('span', null, 'Category'), txtIn(m.category, (v) => setModule(m, { category: v }), { list: 'pb-cats' })),
          h('label', { class: 'field' }, h('span', null, 'Unit'), h('select', { disabled: dis, on: { change: (e) => setModule(m, { uom: e.target.value }) } }, Object.entries(UOMS).map(([k, l]) => h('option', { value: k, selected: k === m.uom }, l)))),
          h('label', { class: 'check inline' }, h('input', { type: 'checkbox', checked: m.active !== false, disabled: dis, on: { change: (e) => { setModule(m, { active: e.target.checked }); renderList(); } } }), h('span', null, 'Active')),
          editable() ? h('button', { class: 'icon-btn', 'aria-label': 'Module actions', on: { click: (e) => popupMenu(e.currentTarget, [{ label: 'Delete module', danger: true, onClick: () => deleteModule(m) }]) } }, '⋯') : null),
        h('label', { class: 'field' }, h('span', null, 'Description (inclusions, size limits — shown to designers and on quotes)'), txtIn(m.description, (v) => setModule(m, { description: v }))),
        h('datalist', { id: 'pb-cats' }, cats.map((c) => h('option', { value: c }))),
        dollarLabour
          ? h('p', { class: 'muted small' }, 'Labour for these options is priced in dollars per trade, exactly as in the imported spreadsheet. Edit it in the table below; hourly rates only estimate hours.')
          : [h('h3', null, 'Labour per ', m.uom === 'LM' ? 'lineal metre' : 'unit', ' ', labTotal),
            h('div', { class: 'labour-grid' }, work.trades.map((tr) => h('label', { class: 'field' }, h('span', null, `${tr.name} (h)`), numIn(m.labour?.[tr.key] ?? 0, (v) => {
              const lab = { ...(m.labour || {}) };
              if (v) lab[tr.key] = v; else delete lab[tr.key];
              setModule(m, { labour: lab });
              refreshCosts();
            }, { title: `${tr.name} at ${fmt.money(tr.rate)}/h` }))))],
        h('div', { class: 'panel-head' }, h('h3', null, `Options (${m.options.length})`), editable() ? h('button', { class: 'btn small', on: { click: () => addOption(m) } }, '+ Add option') : null),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table compact options-table' },
          h('thead', null, h('tr', null, h('th', null, 'Option / finish'), h('th', null, 'Finish groups'), h('th', { class: 'num' }, 'Material $'), h('th', { class: 'num' }, 'Hardware $'),
            dollarLabour ? work.trades.map((tr) => h('th', { class: 'num' }, `${tr.name} $`)) : h('th', { class: 'num', title: 'Multiplies the module labour hours' }, 'Labour ×'),
            h('th', { class: 'num' }, 'Unit cost'), h('th', { class: 'num' }, `${tier.name} sell`), h('th', null, 'On'), h('th'))),
          h('tbody', null, m.options.map((o) => {
            const cost = h('td', { class: 'num' });
            const sell = h('td', { class: 'num strong' });
            const fgCell = h('td', null);
            const renderFg = () => fill(fgCell, h('button', { class: 'fg-btn', disabled: dis, on: { click: (e) => pickFinishGroups(e.currentTarget, m, o, renderFg) } }, o.finishGroups.length ? o.finishGroups.join(', ') : h('span', { class: 'muted' }, 'none')));
            renderFg();
            const row = h('tr', null,
              h('td', null, txtIn(o.name, (v) => setOption(m, o, { name: v }), { class: 'wide-in' }), o.note || o.costBasis === 'legacy' ? h('div', { class: 'muted small' }, [o.costBasis === 'legacy' ? 'Legacy cost' : '', o.note].filter(Boolean).join(' · ')) : null),
              fgCell,
              h('td', { class: 'num' }, numIn(o.material, (v) => { setOption(m, o, { material: v }); refreshCosts(); })),
              h('td', { class: 'num' }, numIn(o.hardware, (v) => { setOption(m, o, { hardware: v }); refreshCosts(); })),
              dollarLabour
                ? work.trades.map((tr) => h('td', { class: 'num' }, numIn(o.labourCost?.[tr.key] ?? '', (v) => setLabour(o, tr.key, v), { 'aria-label': `${tr.name} labour $` })))
                : h('td', { class: 'num' }, numIn(o.labourFactor ?? 1, (v) => { setOption(m, o, { labourFactor: v }); refreshCosts(); })),
              cost, sell,
              h('td', null, h('input', { type: 'checkbox', checked: o.available !== false, disabled: dis, 'aria-label': 'Available', on: { change: (e) => { setOption(m, o, { available: e.target.checked }); refreshCosts(); } } })),
              h('td', null, editable() ? h('button', { class: 'icon-btn', 'aria-label': 'Delete option', on: { click: () => deleteOption(m, o) } }, '×') : null));
            rows.set(o, { cost, sell, row });
            return row;
          })))));
      refreshCosts();
    }
    const search = h('input', { type: 'search', placeholder: 'Search modules…', value: filter.q, 'aria-label': 'Search modules', on: { input: (e) => { filter.q = e.target.value; renderList(); } } });
    const catSel = h('select', { 'aria-label': 'Category', on: { change: (e) => { filter.cat = e.target.value; renderList(); } } }, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c, selected: c === filter.cat }, c)));
    bodyEl.append(h('div', { class: 'pb-modules' },
      h('aside', { class: 'mod-side' }, h('div', { class: 'mod-tools' }, search, catSel,
        editable() ? h('div', { class: 'row-actions' }, h('button', { class: 'btn small', on: { click: addModule } }, '+ Module'), h('button', { class: 'btn small', on: { click: upliftDialog } }, 'Bulk % change…')) : null), list),
      detail));
    renderList();
    renderDetail();
  }

  function pickFinishGroups(anchor, m, o, done) {
    const box = h('div', { class: 'checklist' }, work.finishGroups.map((f) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: f.key, checked: o.finishGroups.includes(f.key) }), h('span', null, `${f.key} · ${f.name}`))));
    modal({
      title: `Finish groups – ${o.name}`, width: 520,
      body: h('div', null, h('p', { class: 'muted small' }, 'Lines in an area with one of these default finishes pick this option automatically.'), box),
      actions: [{ label: 'Cancel' }, { label: 'Apply', kind: 'primary', onClick: () => { setOption(m, o, { finishGroups: [...box.querySelectorAll('input:checked')].map((i) => i.value) }); done(); } }],
    });
  }

  async function addModule() {
    const cats = [...new Set(work.modules.map((m) => m.category))].sort();
    const v = await formDialog({
      title: 'Add module', submitLabel: 'Add module',
      fields: [
        { name: 'name', label: 'Name', required: true, autofocus: true },
        { name: 'category', label: 'Category', type: 'select', value: cats[0], options: cats.map((c) => ({ value: c, label: c })) },
        { name: 'uom', label: 'Unit', type: 'select', value: 'EA', options: Object.entries(UOMS).map(([k, l]) => ({ value: k, label: l })) },
        { name: 'description', label: 'Description' },
      ],
    });
    if (!v) return;
    const m = { key: `new-${Date.now()}`, ...v, sort: 9999, active: true, labour: {}, options: [{ key: 'standard', name: 'Standard', finishGroups: [], material: 0, hardware: 0, labourFactor: 1, available: true, note: '' }] };
    m.__op = push({ op: 'module.add', module: {} });
    work.modules.push(m);
    syncNewModule(m);
    selKey = m.key;
    renderBody();
  }

  async function deleteModule(m) {
    if (!(await confirmDialog({ title: 'Delete module', message: `Delete "${m.name}" and its ${m.options.length} option(s) from this draft? Jobs on older versions are not affected.`, confirmLabel: 'Delete', danger: true }))) return;
    work.modules = work.modules.filter((x) => x !== m);
    if (m.__op) changes = changes.filter((c) => c !== m.__op);
    else { changes = changes.filter((c) => !(c.moduleKey === m.key || c.key === m.key)); push({ op: 'module.delete', key: m.key }); }
    selKey = work.modules[0]?.key;
    touched();
    renderBody();
  }

  async function addOption(m) {
    const v = await formDialog({ title: `Add option to ${m.name}`, submitLabel: 'Add', fields: [{ name: 'name', label: 'Option / finish name', required: true, autofocus: true }, { name: 'material', label: 'Material $ per unit', type: 'number', value: 0, step: 'any' }] });
    if (!v) return;
    const o = { key: `new-${Date.now()}`, name: v.name, finishGroups: [], material: Number(v.material) || 0, hardware: 0, labourFactor: 1, available: true, note: '' };
    m.options.push(o);
    if (m.__op) syncNewModule(m);
    else o.__op = push({ op: 'option.add', moduleKey: m.key, option: { name: o.name, material: o.material, hardware: 0, labourFactor: 1, finishGroups: [], available: true } });
    renderBody();
  }

  async function deleteOption(m, o) {
    if (m.options.length === 1) { toast('A module needs at least one option. Delete the module instead.', 'error'); return; }
    if (!(await confirmDialog({ title: 'Delete option', message: `Delete "${o.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    m.options = m.options.filter((x) => x !== o);
    if (m.__op) syncNewModule(m);
    else if (o.__op) changes = changes.filter((c) => c !== o.__op);
    else { changes = changes.filter((c) => c.__key !== `opt|${m.key}|${o.key}`); push({ op: 'option.delete', moduleKey: m.key, optionKey: o.key }); }
    touched();
    renderBody();
  }

  async function upliftDialog() {
    const cats = [...new Set(work.modules.map((m) => m.category))].sort();
    const v = await formDialog({
      title: 'Bulk % change', submitLabel: 'Apply to draft',
      intro: 'Adjusts material and/or hardware costs. Nothing is saved until you choose Save draft, and you can review every change on the Changes tab.',
      fields: [
        { name: 'pct', label: 'Change %', type: 'number', step: 'any', value: 3, required: true, help: 'Use a negative number to reduce. Decimals are fine, e.g. 2.75.' },
        { name: 'cat', label: 'Category', type: 'select', value: '', options: [{ value: '', label: 'All categories' }, ...cats.map((c) => ({ value: c, label: c }))] },
        { name: 'fg', label: 'Finish group', type: 'select', value: '', options: [{ value: '', label: 'Any finish group' }, ...work.finishGroups.map((f) => ({ value: f.key, label: `${f.key} · ${f.name}` }))] },
        { name: 'field', label: 'Apply to', type: 'select', value: 'material', options: [{ value: 'material', label: 'Material cost' }, { value: 'hardware', label: 'Hardware cost' }, { value: 'both', label: 'Material and hardware' }] },
      ],
    });
    if (!v) return;
    const f = 1 + Number(v.pct) / 100;
    let n = 0;
    for (const m of work.modules) {
      if (v.cat && m.category !== v.cat) continue;
      for (const o of m.options) {
        if (v.fg && !o.finishGroups.includes(v.fg)) continue;
        const fields = {};
        // Keep full precision (only binary float noise beyond 6 decimals is dropped); no rounding to cents.
        if ((v.field === 'material' || v.field === 'both') && o.material) fields.material = Math.round(o.material * f * 1e6) / 1e6;
        if ((v.field === 'hardware' || v.field === 'both') && o.hardware) fields.hardware = Math.round(o.hardware * f * 1e6) / 1e6;
        if (Object.keys(fields).length) { setOption(m, o, fields); n++; }
      }
    }
    toast(n ? `${n} option${n === 1 ? '' : 's'} adjusted. Review, then Save draft.` : 'No options matched (only non-zero costs are changed).', n ? 'success' : 'info');
    renderBody();
  }

  // ---------- labour / tiers / finishes ----------
  function renderLabour() {
    bodyEl.append(h('section', { class: 'panel narrow-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Trade cost rates'), editable() ? h('button', { class: 'btn small', on: { click: async () => {
        const v = await formDialog({ title: 'Add trade', fields: [{ name: 'name', label: 'Trade name', required: true }, { name: 'rate', label: 'Cost per hour', type: 'number', value: 0, step: 'any' }], submitLabel: 'Add' });
        if (!v) return;
        push({ op: 'trade.add', trade: v });
        work.trades.push({ key: v.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), name: v.name, rate: Number(v.rate) || 0, __new: true });
        toast('Trade added. Save the draft to start using it in modules.', 'info');
        renderBody();
      } } }, '+ Trade') : null),
      h('p', { class: 'muted small' }, 'Loaded cost per hour (wages plus on-costs). Module labour hours × these rates give each option\'s labour cost.'),
      h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Trade'), h('th', { class: 'num' }, 'Cost / hour'), h('th', { class: 'num' }, 'Modules using'))),
        h('tbody', null, work.trades.map((t) => h('tr', null,
          h('td', null, t.__new ? t.name : txtIn(t.name, (v) => { t.name = v; record(`trade|${t.key}`, () => ({ op: 'trade.update', key: t.key }), { name: v }); })),
          h('td', { class: 'num' }, t.__new ? fmt.money(t.rate) : numIn(t.rate, (v) => { t.rate = v; record(`trade|${t.key}`, () => ({ op: 'trade.update', key: t.key }), { rate: v }); }, { step: '0.5' })),
          h('td', { class: 'num' }, String(work.modules.filter((m) => m.labour?.[t.key]).length))))))));
  }

  function renderTiers() {
    const rowsEl = work.tiers.map((t) => {
      const margin = h('td', { class: 'num' }, fmt.pct(1 - 1 / (1 + t.markup / 100)));
      return h('tr', null,
        h('td', null, t.__new ? t.name : txtIn(t.name, (v) => { t.name = v; record(`tier|${t.key}`, () => ({ op: 'tier.update', key: t.key }), { name: v }); })),
        h('td', { class: 'num' }, t.__new ? `${t.markup}%` : numIn(t.markup, (v) => { t.markup = v; margin.textContent = fmt.pct(1 - 1 / (1 + v / 100)); record(`tier|${t.key}`, () => ({ op: 'tier.update', key: t.key }), { markup: v }); }, { step: '0.5' })),
        margin,
        h('td', null, h('input', { type: 'radio', name: 'deftier', checked: t.isDefault, disabled: !editable() || t.__new, 'aria-label': 'Default tier', on: { change: () => { work.tiers.forEach((x) => { x.isDefault = x === t; }); record(`tierdef`, () => ({ op: 'tier.update', key: t.key }), { isDefault: true }); changes.find((c) => c.__key === 'tierdef').key = t.key; } } })),
        h('td', null, editable() && !t.isDefault && !t.__new ? h('button', { class: 'icon-btn', 'aria-label': 'Delete tier', on: { click: () => { work.tiers = work.tiers.filter((x) => x !== t); push({ op: 'tier.delete', key: t.key }); renderBody(); } } }, '×') : null));
    });
    bodyEl.append(h('section', { class: 'panel narrow-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Price tiers'), editable() ? h('button', { class: 'btn small', on: { click: async () => {
        const v = await formDialog({ title: 'Add price tier', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'markup', label: 'Markup % on cost', type: 'number', value: 50, step: 'any' }], submitLabel: 'Add' });
        if (!v) return;
        push({ op: 'tier.add', tier: v });
        work.tiers.push({ key: v.name, name: v.name, markup: Number(v.markup), isDefault: false, __new: true });
        renderBody();
      } } }, '+ Tier') : null),
      h('p', { class: 'muted small' }, 'Markup is applied once to cost. Margin is profit as a share of the sell price. The workbook\'s "Retail +50%" was really 57.5% because it stacked on the +5% RAW price; the imported tiers keep the real figures so prices did not change.'),
      h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Tier'), h('th', { class: 'num' }, 'Markup %'), h('th', { class: 'num' }, 'Margin on sell'), h('th', null, 'Default'), h('th'))), h('tbody', null, rowsEl))));
  }

  function renderFinishes() {
    bodyEl.append(h('section', { class: 'panel narrow-panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Finish groups'), editable() ? h('button', { class: 'btn small', on: { click: async () => {
        const v = await formDialog({ title: 'Add finish group', fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'e.g. 18mm Polytec Venette' }], submitLabel: 'Add' });
        if (!v) return;
        push({ op: 'finish.add', finish: v });
        work.finishGroups.push({ key: '(new)', name: v.name, __new: true });
        renderBody();
      } } }, '+ Finish group') : null),
      h('p', { class: 'muted small' }, 'Finish groups are the price tiers of board and door finishes. Setting an area\'s default finish picks the matching option on every item in that area.'),
      h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Code'), h('th', null, 'Name'), h('th', { class: 'num' }, 'Options'))),
        h('tbody', null, work.finishGroups.map((f) => h('tr', null, h('td', { class: 'mono' }, f.key),
          h('td', null, f.__new ? f.name : txtIn(f.name, (v) => { f.name = v; record(`fg|${f.key}`, () => ({ op: 'finish.update', key: f.key }), { name: v }); }, { class: 'wide-in' })),
          h('td', { class: 'num' }, String(work.modules.reduce((s, m) => s + m.options.filter((o) => o.finishGroups.includes(f.key)).length, 0)))))))));
  }

  // ---------- materials ----------
  function renderMaterials() {
    const sheetM2 = (s) => { const m = /(\d{3,4})\s*[x×]\s*(\d{3,4})/i.exec(s || ''); return m ? (Number(m[1]) * Number(m[2])) / 1e6 : null; };
    let lastSup = null;
    const body = h('tbody');
    for (const m of work.materials) {
      if (m.supplier !== lastSup) { body.append(h('tr', { class: 'group-row' }, h('td', { colspan: 8 }, m.supplier))); lastSup = m.supplier; }
      const area = sheetM2(m.sheetSize);
      const check = h('td', { class: 'num small' });
      const refresh = () => {
        if (area && m.sheetRate && m.m2Rate) {
          const implied = m.sheetRate / area;
          const off = Math.abs(implied - m.m2Rate) / m.m2Rate;
          fill(check, off > 0.02 ? h('span', { class: 'chip warn', title: `Sheet price ÷ ${area.toFixed(2)} m² = ${fmt.money(implied)}/m²` }, `${fmt.money(implied)}/m²`) : h('span', { class: 'muted' }, '✓'));
        } else fill(check, h('span', { class: 'muted' }, m.m2Rate == null && m.sheetRate == null ? 'no price' : ''));
      };
      const upd = (field) => (v) => { m[field] = v; m.id && record(`mat|${m.id}`, () => ({ op: 'material.update', id: m.id }), { [field]: v }); refresh(); };
      body.append(h('tr', null,
        h('td', null, txtIn(m.product, upd('product'), { class: 'wide-in' })),
        h('td', null, txtIn(m.thickness, upd('thickness'), { size: 5 })),
        h('td', null, txtIn(m.sheetSize, upd('sheetSize'), { size: 11 })),
        h('td', { class: 'num' }, area ? area.toFixed(2) : '—'),
        h('td', { class: 'num' }, numIn(m.m2Rate, upd('m2Rate'), { step: '0.01' })),
        h('td', { class: 'num' }, numIn(m.sheetRate, upd('sheetRate'), { step: '0.01' })),
        check,
        h('td', { class: 'small muted' }, m.note || '')));
      refresh();
    }
    bodyEl.append(h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Material reference (board prices)'), editable() ? h('button', { class: 'btn small', on: { click: async () => {
        const v = await formDialog({ title: 'Add material', fields: [{ name: 'supplier', label: 'Supplier', required: true }, { name: 'product', label: 'Product', required: true }, { name: 'thickness', label: 'Thickness' }, { name: 'sheetSize', label: 'Sheet size', placeholder: '2400 x 1200' }, { name: 'm2Rate', label: '$ per m²', type: 'number', step: 'any' }, { name: 'sheetRate', label: '$ per sheet', type: 'number', step: 'any' }], submitLabel: 'Add' });
        if (!v) return;
        push({ op: 'material.add', material: v });
        work.materials.push({ ...v });
        renderBody();
      } } }, '+ Material') : null),
      h('p', { class: 'muted small' }, 'Supplier board prices for reference and future automatic costing. The check column flags rows where the sheet price does not match the m² rate for the sheet size.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table compact' },
        h('thead', null, h('tr', null, h('th', null, 'Product'), h('th', null, 'Thick.'), h('th', null, 'Sheet'), h('th', { class: 'num' }, 'm²'), h('th', { class: 'num' }, '$/m²'), h('th', { class: 'num' }, '$/sheet'), h('th', { class: 'num' }, 'Check'), h('th', null, 'Note'))),
        body))));
  }

  // ---------- changes ----------
  async function renderChanges() {
    const panel = h('section', { class: 'panel' });
    bodyEl.append(panel);
    if (isDirty()) {
      panel.append(h('h2', null, 'Unsaved changes'), h('ul', { class: 'change-list' }, changes.map((c) => h('li', null, describeOp(c)))));
    }
    if (!work.basedOnId) { panel.append(h('p', { class: 'muted' }, 'This version was not copied from another, so there is nothing to compare against.')); return; }
    const d = await get(`/api/price-books/${bookId}/diff`);
    panel.append(h('h2', null, `Saved differences from "${d.from.label}"`));
    if (!d.changes.length) { panel.append(h('p', { class: 'muted' }, 'No saved differences yet.')); return; }
    panel.append(h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Change'), h('th', null, 'Item'), h('th', { class: 'num' }, 'Before'), h('th', { class: 'num' }, 'After'), h('th', { class: 'num' }, 'Change'))),
      h('tbody', null, d.changes.map((c) => {
        const isMoney = c.kind === 'option_cost' || c.kind === 'trade_rate';
        const f = (v) => (v == null ? '' : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k} ${x}`).join(', ') : isMoney ? fmt.money(v) : c.kind === 'tier_markup' ? `${v}%` : String(v));
        const pct = typeof c.from === 'number' && typeof c.to === 'number' && c.from ? (c.to - c.from) / c.from : null;
        return h('tr', null, h('td', null, c.kind.replace(/_/g, ' ')), h('td', null, c.name), h('td', { class: 'num' }, f(c.from)), h('td', { class: 'num' }, f(c.to)), h('td', { class: 'num' }, pct == null ? '' : `${pct > 0 ? '+' : ''}${fmt.pct(pct)}`));
      }))));
  }
  function describeOp(c) {
    const where = c.moduleKey ? work.modules.find((m) => m.key === c.moduleKey)?.name || c.moduleKey : '';
    const f = c.fields ? Object.entries(c.fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '';
    return `${c.op.replace('.', ' ')} ${where} ${c.optionKey || c.key || ''} ${f}`.replace(/\s+/g, ' ');
  }

  // ---------- spreadsheet check (price integrity) ----------
  // Compares, product by product: spreadsheet price vs this price book's stored price vs the quote price the pricing
  // engine calculates (1 unit and 5 units, no markup). Runs on the server only when asked.
  let lastCheck = null;
  function renderCheck() {
    const panel = h('section', { class: 'panel' });
    bodyEl.append(panel);
    if (!app.isManager()) { panel.append(h('p', { class: 'muted' }, 'Only owners and admins can run the spreadsheet check.')); return; }
    const out = h('div');
    const run = async (file) => {
      fill(out, h('p', { class: 'muted' }, 'Checking every product…'));
      try {
        lastCheck = await post(`/api/price-books/${bookId}/price-check`, file || {});
        showCheck(out, lastCheck);
      } catch (err) { fill(out, h('p', { class: 'form-error' }, err.message)); }
    };
    const pickXlsx = () => {
      const input = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        run({ file: btoa(bin), fileName: f.name });
      });
      input.click();
    };
    panel.append(
      h('div', { class: 'panel-head' }, h('h2', null, 'Spreadsheet check'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn primary', on: { click: () => run() } }, 'Check against the price book spreadsheet'),
          h('button', { class: 'btn', on: { click: pickXlsx } }, 'Check a different spreadsheet…'))),
      h('p', { class: 'muted small' }, `For every product: the spreadsheet price (TOTAL column), this price book's price, and the price the program calculates on a quote for 1 and 5 units with no markup. They must all agree. Also lists products missing from either side, duplicate names and mapping problems. Price book: "${work.label}".`),
      out);
    if (lastCheck) showCheck(out, lastCheck); else run();
  }

  function showCheck(out, r) {
    const s = r.summary;
    const problems = r.rows.filter((x) => x.status !== 'ok');
    let showAll = !problems.length, q = '';
    const tbody = h('tbody');
    const draw = () => {
      const list = (showAll ? r.rows : problems).filter((x) => !q || `${x.name} ${x.row} ${x.notes.join(' ')}`.toLowerCase().includes(q));
      fill(tbody, list.length ? list.map((x) => h('tr', { class: x.status === 'ok' ? '' : CHECK_STATUS[x.status][1] === 'bad' ? 'has-error' : '' },
        h('td', { class: 'mono small' }, x.row ?? '—'),
        h('td', null, x.name, x.product && x.product.available === false ? h('span', { class: 'chip small' }, 'off') : null),
        h('td', { class: 'num' }, x.spreadsheetPrice == null ? '—' : fmt.money(x.spreadsheetPrice)),
        h('td', { class: 'num' }, x.bookPrice == null ? '—' : fmt.money(x.bookPrice)),
        h('td', { class: 'num' }, x.quote1 == null ? '—' : fmt.money(x.quote1)),
        h('td', { class: 'num' }, x.quote5 == null ? '—' : fmt.money(x.quote5), x.expected5 != null && x.quote5 !== x.expected5 ? h('div', { class: 'bad-text small' }, `expected ${fmt.money(x.expected5)}`) : null),
        h('td', null, h('span', { class: `chip ${CHECK_STATUS[x.status][1]}` }, CHECK_STATUS[x.status][0])),
        h('td', { class: 'muted small' }, x.notes.join(' · '))))
        : h('tr', null, h('td', { colspan: 8, class: 'muted' }, 'Nothing to show.')));
    };
    const stat = (label, value, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, String(value)));
    fill(out,
      h('p', { class: 'small' }, `Checked ${fmt.datetime(r.checkedAt)} against "${r.source}".`),
      r.warnings.length ? h('div', { class: 'banner warn' }, r.warnings.map((w) => h('div', null, w))) : null,
      h('div', { class: 'kpis small' },
        stat('Spreadsheet products', s.spreadsheetProducts), stat('Exact matches', s.ok, s.ok === s.spreadsheetProducts ? 'ok' : ''),
        stat('Price mismatches', s.priceMismatches, s.priceMismatches ? 'bad' : 'ok'), stat('Missing from price book', s.missing, s.missing ? 'bad' : 'ok'),
        stat('Not in spreadsheet', s.extra, s.extra ? 'warn' : 'ok'), stat('Duplicate names', s.duplicates, s.duplicates ? 'warn' : 'ok'),
        stat('Mapping / name issues', s.mapping + s.nameMismatches, s.mapping + s.nameMismatches ? 'warn' : 'ok'),
        stat('Rows to check in spreadsheet', s.spreadsheetConflicts || 0, s.spreadsheetConflicts ? 'warn' : 'ok')),
      h('p', { class: 'muted small' }, `Markups are applied only on top, by price tier, and shown on every job line: ${r.tiers.map((t) => `${t.name} ${t.markup}%${t.isDefault ? ' (default)' : ''}`).join(' · ')}.`),
      h('div', { class: 'inline-fields' },
        h('label', { class: 'check inline' }, h('input', { type: 'checkbox', checked: showAll, on: { change: (e) => { showAll = e.target.checked; draw(); } } }), h('span', null, `Show all ${r.rows.length} products (not only the ${problems.length} to look at)`)),
        h('input', { type: 'search', class: 'grow', placeholder: 'Find a product or row…', 'aria-label': 'Find a product', on: { input: (e) => { q = e.target.value.toLowerCase(); draw(); } } }),
        h('button', { class: 'btn', on: { click: () => downloadCheck(r) } }, 'Download report (CSV)')),
      h('div', { class: 'table-wrap', style: { maxHeight: '60vh' } }, h('table', { class: 'table compact' },
        h('thead', null, h('tr', null, h('th', null, 'Row'), h('th', null, 'Product'), h('th', { class: 'num' }, 'Spreadsheet price'), h('th', { class: 'num' }, 'Price book price'),
          h('th', { class: 'num' }, 'Quote, 1 unit'), h('th', { class: 'num' }, `Quote, ${r.testQty} units`), h('th', null, 'Result'), h('th', null, 'Notes'))),
        tbody)));
    draw();
  }

  function downloadCheck(r) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Spreadsheet row', 'Product', 'Spreadsheet price', 'Price book price', 'Quote 1 unit', `Quote ${r.testQty} units`, `Expected ${r.testQty} units`, 'Result', 'Notes'].map(cell).join(',')];
    for (const x of r.rows) lines.push([x.row, x.name, x.spreadsheetPrice, x.bookPrice, x.quote1, x.quote5, x.expected5, CHECK_STATUS[x.status][0], x.notes.join(' · ')].map(cell).join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv' })), download: `price-check-${work.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${r.checkedAt.slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- commands ----------
  async function save() {
    if (!isDirty()) return true;
    try {
      book = await post(`/api/price-books/${bookId}/changes`, { changes: payload() });
      work = structuredClone(book);
      changes = [];
      renderHead();
      renderBody();
      app.updateTitle();
      toast('Draft saved.', 'success', 1800);
      app.setStatus(`Draft saved at ${new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`);
      return true;
    } catch (err) { showError(err); return false; }
  }

  async function discard() {
    if (!(await confirmDialog({ title: 'Discard changes', message: `Discard ${changes.length} unsaved change(s)?`, confirmLabel: 'Discard', danger: true }))) return;
    work = structuredClone(book);
    changes = [];
    renderHead();
    renderBody();
    app.updateTitle();
  }

  async function saveAs() {
    const pending = editable() ? payload() : [];
    const id = await newDraft(app, bookId, pending);
    if (id) { changes = []; }
  }

  async function publish() {
    if (isDirty() && !(await save())) return;
    const [{ problems }, impact, diff] = await Promise.all([get(`/api/price-books/${bookId}/validate`), get(`/api/price-books/${bookId}/impact`), get(`/api/price-books/${bookId}/diff`)]);
    const today = new Date().toISOString().slice(0, 10);
    const dateIn = h('input', { type: 'date', value: today, min: today, 'aria-label': 'Effective from' });
    // Apply Updated Pricing To Existing Jobs: nothing is ticked to start with; only ticked jobs move to these prices.
    const chosen = new Set();
    const boxes = new Map();
    const count = h('span', { class: 'muted small' });
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all open jobs' });
    let applyBtn = null;
    const refresh = () => {
      for (const [jid, b] of boxes) b.checked = chosen.has(jid);
      allBox.checked = impact.length > 0 && chosen.size === impact.length;
      allBox.indeterminate = chosen.size > 0 && chosen.size < impact.length;
      count.textContent = `${chosen.size} of ${impact.length} selected · ${impact.length - chosen.size} will keep their current prices`;
      if (applyBtn) applyBtn.textContent = chosen.size ? `Apply Selected (${chosen.size}) and Publish` : 'Publish – leave all jobs unchanged';
    };
    const setAll = (on) => { chosen.clear(); if (on) impact.forEach((r) => chosen.add(r.id)); refresh(); };
    allBox.addEventListener('change', () => setAll(allBox.checked));
    const jobRows = impact.map((r) => {
      const b = h('input', { type: 'checkbox', 'aria-label': `Apply new prices to ${r.jobNumber} ${r.name}`, on: { change: (e) => { if (e.target.checked) chosen.add(r.id); else chosen.delete(r.id); refresh(); } } });
      boxes.set(r.id, b);
      return h('tr', { class: 'pick-row', on: { click: (e) => { if (e.target !== b) { b.checked = !b.checked; b.dispatchEvent(new Event('change')); } } } },
        h('td', null, b), h('td', { class: 'mono' }, r.jobNumber), h('td', null, r.name, r.client ? h('div', { class: 'muted small' }, r.client) : null),
        h('td', { class: 'num' }, fmt.money(r.before)), h('td', { class: 'num' }, fmt.money(r.after)), h('td', { class: 'num' }, `${r.change >= 0 ? '+' : ''}${fmt.pct(r.changePct)}`));
    });
    const dlg = modal({
      title: `Publish "${work.label}"`, width: 760,
      body: h('div', null,
        problems.length ? h('div', { class: 'banner bad' }, h('strong', null, `${problems.length} problem(s) must be fixed first:`), h('ul', { class: 'problem-list' }, problems.slice(0, 12).map((p) => h('li', null, p)))) : null,
        h('p', null, `${diff.changes.length} change(s) compared with "${diff.from?.label || 'previous version'}". After publishing, this version is locked and becomes the price list for new jobs from the effective date.`),
        h('label', { class: 'field' }, h('span', null, 'Effective from'), dateIn),
        h('h3', null, 'Apply Updated Pricing To Existing Jobs'),
        impact.length ? h('div', null,
          h('p', { class: 'muted small' }, 'Tick the open jobs that should move to these prices now. Jobs you leave unticked keep their current prices, so prices already agreed with clients are protected. (A job can still be moved later with Job → Update to latest prices.) Won, in-production, installing and complete jobs are locked and never change.'),
          h('div', { class: 'inline-fields pick-tools' },
            h('label', { class: 'check inline' }, allBox, h('span', null, 'Select all open jobs')),
            h('button', { class: 'btn small', type: 'button', on: { click: () => setAll(false) } }, 'Deselect all'),
            count),
          h('div', { class: 'table-wrap', style: { maxHeight: '260px' } }, h('table', { class: 'table compact' },
            h('thead', null, h('tr', null, h('th'), h('th', null, 'Job'), h('th', null, 'Name / client'), h('th', { class: 'num' }, 'Current price'), h('th', { class: 'num' }, 'New price'), h('th', { class: 'num' }, 'Change'))),
            h('tbody', null, jobRows))))
          : h('p', { class: 'muted small' }, 'There are no open jobs on older prices, so no existing job is affected.')),
      actions: [{ label: 'Cancel' }, problems.length ? null : { label: 'Publish', kind: 'primary', onClick: async () => {
        const res = await post(`/api/price-books/${bookId}/publish`, { effectiveFrom: dateIn.value, applyToJobIds: [...chosen] });
        const { publishResult: pr, ...published } = res;
        book = published;
        work = structuredClone(book);
        renderHead(); renderBody(); app.refreshChrome();
        toast(`Published. ${pr.applied.length} job${pr.applied.length === 1 ? '' : 's'} updated to the new prices; ${pr.kept.length} kept their existing prices.`, 'success', 6000);
      } }].filter(Boolean),
    });
    applyBtn = dlg.el.querySelector('.modal-actions .btn.primary');
    refresh();
  }

  renderHead();
  renderBody();
  app.setStatus(editable() ? 'Editing a draft. Changes are kept until you Save draft.' : 'Read-only.');

  return {
    title: () => `Price book: ${work.label}`,
    isDirty,
    save,
    handlesHash: (hash) => new RegExp(`^#/price-books/${bookId}(/\\w+)?$`).test(hash),
    onHash: (hash) => { const m = hash.match(/\/(\w+)$/); tab = m && TABS.some(([k]) => k === m[1]) ? m[1] : 'modules'; renderBody(); },
    commands: {
      'file.save': { label: 'Save draft', run: save, when: () => editable() },
      'file.saveAs': { label: 'Save As new draft…', run: saveAs, when: () => app.isManager() },
      'file.close': { label: 'Close price book', run: () => app.navigate('#/price-books') },
      'pb.newDraft': { run: saveAs, when: () => app.isManager() },
      'pb.publish': { run: publish, when: () => editable() },
      'pb.export': { run: () => download(`/api/price-books/${bookId}/export`).then((n) => toast(`Exported ${n}`, 'success')), when: () => app.isManager() },
    },
  };
}

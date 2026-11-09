// Job builder: the platform's document editor (one job = one "file").
import { get, put, post, del, download } from '../api.js';
import { h, clear, fill, fmt, statusChip, STATUS_LABELS, STATUS_OPTIONS, CLOSED_STATUSES, statusLabel, marginChip, modal, formDialog, confirmDialog, toast, showError, popupMenu } from '../ui.js';
import { priceJob, CUSTOM_MODULE, OVERRIDE_TYPES, unitCostOf } from '/shared/pricing.js';
import { renderSchedule } from './job-schedule.js';

const AREA_TYPES = { kitchen: 'Kitchen', butlers: "Butler's pantry", wardrobe: 'Wardrobe / robe', linen: 'Linen press', laundry: 'Laundry', vanity: 'Vanity', alfresco: 'Alfresco', study: 'Study', entertainment: 'Entertainment', services: 'Job services', other: 'Other' };
const UOM_LABEL = { LM: 'LM', EA: 'ea', M2: 'm²', JOB: 'job', HR: 'hr' };
const TABS = [['builder', 'Builder'], ['details', 'Details'], ['schedule', 'Schedule'], ['quotes', 'Quotes'], ['costs', 'Budget & costs'], ['history', 'History']];
const QUOTE_STATUS = { issued: 'Issued', accepted: 'Accepted', declined: 'Declined', superseded: 'Superseded' };
const bookCache = new Map();

async function loadBook(id) {
  if (!bookCache.has(id)) bookCache.set(id, await get(`/api/price-books/${id}`));
  return bookCache.get(id);
}

export async function mount(el, params, app) {
  const jobId = Number(params[0]);
  let payload = await get(`/api/jobs/${jobId}`);
  let book = await loadBook(payload.job.priceBookId);
  let doc = structuredClone(payload.job);
  let savedSig = sig(doc);
  let pricing = null;
  let tab = TABS.some(([k]) => k === params[1]) ? params[1] : 'builder';
  let areaIdx = 0;
  let newId = 0;
  const openCats = new Set(); // Full Price Book categories the user has opened
  let fullBookOpen = true; // the Full Price Book list itself (folds away under its heading)
  const undo = [], redo = [];
  const settings = () => ({ gstRate: app.state.company.gstRate, floorMargin: app.state.company.floorMargin });
  const floor = () => app.state.company.floorMargin;
  const locked = () => doc.locked;
  const modules = () => book.modules.filter((m) => m.active !== false);
  const modByKey = (k) => book.modules.find((m) => m.key === k);
  const currentTier = () => book.tiers.find((t) => t.key === doc.tierKey) || book.tiers.find((t) => t.isDefault) || book.tiers[0];
  const tierMarkup = () => currentTier().markup / 100;
  // The markup is always stated where the sell price is shown.
  const sellLabel = () => { const t = currentTier(); return Number(t.markup) ? `Sell (${t.name} +${t.markup}%)` : `Sell (${t.name}, no markup)`; };

  function sig(d) { return JSON.stringify({ ...d, revision: 0, updatedAt: 0, updatedByName: 0 }); }
  const isDirty = () => sig(doc) !== savedSig;

  // ---------- undo ----------
  function snapshot() {
    undo.push(JSON.stringify(doc));
    if (undo.length > 150) undo.shift();
    redo.length = 0;
  }
  function restore(json) {
    doc = JSON.parse(json);
    areaIdx = Math.min(areaIdx, doc.areas.length - 1);
    changed(true);
  }
  /** Bind a text/number input: one undo step per focus session, live update on input. */
  function bind(input, set, { structural = false } = {}) {
    let armed = false;
    input.addEventListener('focus', () => { armed = true; });
    input.addEventListener('input', () => {
      if (armed) { snapshot(); armed = false; }
      set(input.type === 'number' ? (input.value === '' ? 0 : Number(input.value)) : input.value);
      changed(structural);
    });
    return input;
  }
  function mutate(fn, structural = true) { snapshot(); fn(); changed(structural); }

  // ---------- skeleton ----------
  const headEl = h('div', { class: 'job-head' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const bodyEl = h('div', { class: 'job-body' });
  fill(el, headEl, tabsEl, bodyEl);

  function recalc() { pricing = priceJob(doc, book, settings()); }

  function changed(structural) {
    recalc();
    if (structural) { renderTab(); renderHead(); } else { updateLive(); updateHead(); }
    app.updateTitle();
  }

  // ---------- header ----------
  const headRefs = {};
  function updateHead() {
    const t = pricing.totals;
    const dirty = isDirty();
    headRefs.dirty.hidden = !dirty;
    fill(headRefs.total, h('div', { class: 'muted small' }, 'Sell ex GST'), h('div', { class: 'big num' }, fmt.money(t.sell)), marginChip(t.marginPct, floor()));
    headRefs.save.disabled = !dirty;
    headRefs.save.classList.toggle('primary', dirty);
    headRefs.save.textContent = dirty ? 'Save' : 'Saved';
  }

  function renderHead() {
    headRefs.dirty = h('span', { class: 'dirty-dot', title: 'Unsaved changes' }, ' ●');
    headRefs.total = h('div', { class: 'job-total' });
    headRefs.save = h('button', { class: 'btn', title: 'Save (Ctrl+S)', on: { click: () => app.run('file.save') } });
    fill(headEl, 
      h('div', { class: 'job-id' },
        h('div', { class: 'eyebrow mono' }, doc.jobNumber, headRefs.dirty),
        h('input', { class: 'title-input', value: doc.name, 'aria-label': 'Job name' })),
      h('div', { class: 'job-meta' },
        h('label', null, h('span', null, 'Status'), statusSelect()),
        h('label', null, h('span', null, 'Price tier'), h('select', { 'aria-label': 'Price tier', disabled: locked(), on: { change: (e) => mutate(() => { doc.tierKey = e.target.value; }, true) } },
          book.tiers.map((tr) => h('option', { value: tr.key, selected: tr.key === doc.tierKey }, `${tr.name} (${tr.markup}%)`)))),
        h('div', { class: 'pb-chip' }, h('span', { class: 'muted small' }, 'Prices from'), h('a', { href: `#/price-books/${book.id}` }, book.label),
          payload.newerBook && !locked() ? h('button', { class: 'chip warn as-btn', on: { click: () => app.run('job.reprice') } }, 'Newer prices available') : null)),
      headRefs.total,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', title: 'Save As (Ctrl+Shift+S)', on: { click: () => app.run('file.saveAs') } }, 'Save As…'),
        headRefs.save,
        h('button', { class: 'btn accent', disabled: locked(), on: { click: () => app.run('job.quote') } }, 'Create quote…')));
    bind(headEl.querySelector('.title-input'), (v) => { doc.name = v; });
    updateHead();
  }

  // Status: the company's statuses (main statuses and their variations, Settings → Job statuses). Moving a closed job
  // (Complete or Missed) back to any other status is reopening it, and needs a reason that goes in the job's history.
  function statusSelect() {
    const current = doc.statusDetail || doc.status;
    const opts = STATUS_OPTIONS.length ? STATUS_OPTIONS.filter((o) => o.active || o.key === current)
      : Object.entries(STATUS_LABELS).map(([key, label]) => ({ key, label, baseStatus: key, builtin: true }));
    const sel = h('select', { 'aria-label': 'Status', on: { change: async (e) => {
      const o = opts.find((x) => x.key === e.target.value);
      const saved = payload.job.status;
      const reopening = CLOSED_STATUSES.includes(saved) && !CLOSED_STATUSES.includes(o.baseStatus);
      let reason = doc.reopenReason || '';
      if (reopening && !reason) {
        const v = await formDialog({
          title: 'Reopen job', submitLabel: 'Reopen',
          intro: `This job is ${statusLabel(saved, payload.job.statusDetail)}. Moving it to ${o.label} reopens it. The reason is recorded in the job's history with your name and the time.`,
          fields: [{ name: 'reason', label: 'Reason for reopening', type: 'textarea', required: true, autofocus: true }],
        });
        if (!v || !v.reason.trim()) { e.target.value = current; return; }
        reason = v.reason.trim();
      }
      mutate(() => {
        doc.status = o.baseStatus;
        doc.statusDetail = o.builtin ? null : o.key;
        if (reopening) doc.reopenReason = reason; else delete doc.reopenReason;
      }, false);
      if (reopening) toast('Save the job to reopen it.', 'info');
    } } },
    opts.map((o) => h('option', { value: o.key, selected: o.key === current }, `${o.builtin ? '' : '   – '}${o.label}${o.active === false ? ' (turned off)' : ''}`)));
    return sel;
  }

  function renderTabs() {
    fill(tabsEl, ...TABS.map(([k, label]) => h('a', { role: 'tab', 'aria-selected': String(k === tab), class: k === tab ? 'on' : '', href: `#/jobs/${jobId}${k === 'builder' ? '' : `/${k}`}` }, label,
      k === 'builder' && pricing.warnings.some((w) => w.level === 'error') ? h('span', { class: 'badge bad' }, String(pricing.warnings.filter((w) => w.level === 'error').length)) : null)));
  }

  function renderTab() {
    renderTabs();
    clear(bodyEl);
    if (tab === 'builder') renderBuilder();
    else if (tab === 'details') renderDetails();
    else if (tab === 'schedule') renderSchedule(bodyEl, { app, jobId, job: doc, isDirty });
    else if (tab === 'quotes') renderQuotes();
    else if (tab === 'costs') renderCosts();
    else if (tab === 'history') renderHistory();
  }

  // ---------- builder ----------
  let liveCells = new Map();
  let summaryEl, railEl;

  function renderBuilder() {
    if (!doc.areas.length) areaIdx = -1;
    railEl = h('aside', { class: 'area-rail', 'aria-label': 'Areas' });
    summaryEl = h('aside', { class: 'summary' });
    const main = h('section', { class: 'area-main' });
    bodyEl.append(h('div', { class: 'builder' }, railEl, main, summaryEl));
    if (locked()) main.append(h('div', { class: 'banner warn' }, 'This job\'s status is Won or later, so its areas and prices are locked. Use File → Save As to price a variation as a new job, or change the status back to unlock it.'));
    renderRail();
    renderArea(main);
    renderSummary();
  }

  function renderRail() {
    fill(railEl, h('div', { class: 'rail-head' }, h('span', null, 'Areas'), h('span', { class: 'muted small' }, String(doc.areas.length))));
    doc.areas.forEach((a, i) => {
      const at = pricing.areas[i]?.totals;
      railEl.append(h('button', { class: `area-item ${i === areaIdx ? 'on' : ''}`, title: locked() ? '' : 'Double-click to rename', on: { click: () => { areaIdx = i; renderTab(); }, dblclick: () => { if (!locked()) { areaIdx = i; renameArea(); } } } },
        h('span', { class: 'area-name' }, a.name, a.optional ? h('span', { class: 'chip small warn' }, 'Option') : null, a.quoteLabel === 'provisional' ? h('span', { class: 'chip small' }, 'Prov. sum') : null),
        h('span', { class: 'area-sub num', dataset: { areaTotal: i } }, fmt.money0(at?.sell)),
        h('span', { class: 'muted small' }, `${at?.lineCount || 0} item${at?.lineCount === 1 ? '' : 's'} · ${AREA_TYPES[a.type] || 'Other'}`)));
    });
    railEl.append(h('button', { class: 'btn block dashed', disabled: locked(), on: { click: (e) => addAreaMenu(e.currentTarget) } }, '+ Add area'));
  }

  function renderArea(main) {
    const a = doc.areas[areaIdx];
    if (!a) {
      main.append(h('div', { class: 'empty' }, h('h2', null, 'No areas yet'), h('p', null, 'A job can hold any number of areas: kitchen, robes, laundry, vanities and more.'), h('button', { class: 'btn primary', on: { click: (e) => addAreaMenu(e.currentTarget) } }, '+ Add area')));
      return;
    }
    const dis = locked();
    const nameIn = bind(h('input', { class: 'area-title', value: a.name, 'aria-label': 'Area name', disabled: dis }), (v) => { a.name = v; const btn = railEl.querySelectorAll('.area-item .area-name')[areaIdx]; if (btn) btn.firstChild.textContent = v; });
    main.append(
      h('div', { class: 'area-head' },
        nameIn,
        h('label', null, h('span', null, 'Type'), h('select', { disabled: dis, on: { change: (e) => mutate(() => { a.type = e.target.value; }) } }, Object.entries(AREA_TYPES).map(([v, l]) => h('option', { value: v, selected: v === a.type }, l)))),
        h('label', { class: 'grow' }, h('span', null, 'Default finish for this area'), h('select', { disabled: dis, on: { change: (e) => mutate(() => { a.defaultFinish = e.target.value || ''; }) } },
          h('option', { value: '' }, '— None (choose per item) —'), book.finishGroups.map((f) => h('option', { value: f.key, selected: f.key === a.defaultFinish }, `${f.key} · ${f.name}`)))),
        h('label', { title: 'How this area is shown on the quote. A provisional sum is included in the total and marked "Provisional sum"; it is numbered after the area before it (e.g. 2A).' },
          h('span', null, 'On the quote'), h('select', { disabled: dis, on: { change: (e) => mutate(() => { a.quoteLabel = e.target.value; }) } },
            h('option', { value: '', selected: !a.quoteLabel }, 'Priced area'), h('option', { value: 'provisional', selected: a.quoteLabel === 'provisional' }, 'Provisional sum'))),
        h('label', { class: 'check inline', title: 'Optional areas are quoted as add-ons and excluded from the total ("Not included in total")' }, h('input', { type: 'checkbox', checked: a.optional, disabled: dis, on: { change: (e) => mutate(() => { a.optional = e.target.checked; }) } }), h('span', null, 'Optional')),
        h('button', { class: 'icon-btn', 'aria-label': 'Area actions', disabled: dis, on: { click: (e) => areaMenu(e.currentTarget) } }, '⋯')));

    liveCells = new Map();
    const tbody = h('tbody');
    a.lines.forEach((l, li) => tbody.append(lineRow(a, l, li)));
    main.append(h('div', { class: 'table-wrap lines-wrap' }, h('table', { class: 'table lines' },
      h('thead', null, h('tr', null, h('th', { style: { width: '26%' } }, 'Item'), h('th', null, 'Finish / option'), h('th', { class: 'num', style: { width: '120px' } }, 'Qty'),
        h('th', { class: 'num', title: 'The price book (spreadsheet) price for one unit, with no markup' }, 'Book price'),
        h('th', { class: 'num', title: 'Quantity × book price' }, 'Book total'),
        h('th', { class: 'num', title: 'What the client is quoted: book total plus the price tier markup' }, sellLabel()),
        h('th', { class: 'num' }, 'Margin'), h('th', { style: { width: '40px' } }))),
      tbody)));
    if (!a.lines.length) main.append(h('p', { class: 'muted center' }, 'No items in this area yet. Search below to add cabinetry, panels, hardware or services.'));
    if (!dis) main.append(addItemBar(a));
    if (a.notes || !dis) {
      main.append(h('label', { class: 'field area-notes' }, h('span', null, 'Area inclusions & notes (printed on the quote under the area name)'),
        bind(h('textarea', { rows: Math.min(14, Math.max(4, (a.notes || '').split('\n').length + 1)), disabled: dis, placeholder: '*Doors finished in 16mm Laminex … \n# Elevation 01 Inclusions – approx. 5030mm wide\n*1x single door tall cabinet …\n! *No allowance for LED extrusions' }, a.notes || ''), (v) => { a.notes = v; }),
        h('small', { class: 'muted' }, 'Formatting on the quote: "# " underlined heading · "! " red line (exclusions; "*No allowance…" lines are red automatically) · "~ " blue line · [red]…[/red] or [blue]…[/blue] for part of a line · **bold** · ***bold italic*** · "- " bullet.')));
    }
  }

  function lineRow(a, l, li) {
    const mod = l.moduleKey === CUSTOM_MODULE ? null : modByKey(l.moduleKey);
    const r = pricing.areas[areaIdx].lines[li];
    const dis = locked();
    const bookCell = h('td', { class: 'num' });
    const bookTotalCell = h('td', { class: 'num' });
    const totalCell = h('td', { class: 'num strong' });
    const marginCell = h('td', { class: 'num' });
    const row = h('tr', { class: r.warnings.some((w) => w.level === 'error') ? 'has-error' : '' });
    liveCells.set(l.id, { bookCell, bookTotalCell, totalCell, marginCell, row, li });

    let itemCell;
    let optionCell;
    if (l.moduleKey === CUSTOM_MODULE) {
      itemCell = h('td', null, h('div', { class: 'muted small' }, 'Custom item'), bind(h('input', { value: l.description, placeholder: 'Describe the item (printed on the quote)', disabled: dis, 'aria-label': 'Custom item description' }), (v) => { l.description = v; }));
      optionCell = h('td', null, h('div', { class: 'inline-fields' },
        h('label', null, h('span', { class: 'muted small' }, 'Unit cost'), bind(h('input', { type: 'number', min: 0, step: 'any', value: fmt.dec2(l.custom?.unitCost ?? 0), disabled: dis, class: 'num-in' }), (v) => { l.custom = { ...(l.custom || {}), unitCost: v }; })),
        h('select', { disabled: dis, 'aria-label': 'Unit', on: { change: (e) => mutate(() => { l.custom = { ...(l.custom || {}), uom: e.target.value }; }, false) } }, Object.keys(UOM_LABEL).map((u) => h('option', { value: u, selected: u === (l.custom?.uom || 'EA') }, UOM_LABEL[u])))));
    } else if (!mod) {
      itemCell = h('td', null, h('span', { class: 'chip bad' }, 'Missing'), ` ${l.moduleKey}`);
      optionCell = h('td');
    } else {
      itemCell = h('td', null, h('div', { class: 'strong' }, mod.name), h('div', { class: 'muted small clamp' }, l.description || mod.description || mod.category));
      const usable = mod.options;
      if (usable.length === 1) {
        optionCell = h('td', null, h('span', { class: usable[0].available === false ? 'chip bad' : 'muted' }, usable[0].name === 'Standard' ? '—' : usable[0].name));
      } else {
        const inherit = r.optionInherited && !l.optionKey;
        const area = doc.areas[areaIdx];
        const sel = h('select', { class: 'opt-select', disabled: dis, 'aria-label': `Finish for ${mod.name}`, on: { change: (e) => mutate(() => { l.optionKey = e.target.value || null; }) } },
          h('option', { value: '' }, area.defaultFinish ? (inherit ? `Area finish → ${r.optionName}` : 'Area finish (no match – choose)') : '— Choose —'),
          usable.map((o) => h('option', { value: o.key, selected: o.key === l.optionKey, disabled: o.available === false }, `${o.name}${o.available === false ? ' (unavailable)' : ''}`)));
        optionCell = h('td', null, sel);
      }
    }
    const qty = bind(h('input', { type: 'number', class: 'num-in', step: 'any', min: 0, value: fmt.dec2(l.qty), disabled: dis, 'aria-label': 'Quantity', dataset: { lineId: l.id } }), (v) => { l.qty = v; });
    qty.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.querySelector('.add-item input')?.focus(); } });
    const uom = l.moduleKey === CUSTOM_MODULE ? (l.custom?.uom || 'EA') : mod?.uom || 'EA';
    row.append(itemCell, optionCell,
      h('td', { class: 'num' }, h('div', { class: 'qty-cell' }, qty, h('span', { class: 'muted small' }, UOM_LABEL[uom]))),
      bookCell, bookTotalCell, totalCell, marginCell,
      h('td', null, h('button', { class: 'icon-btn', 'aria-label': 'Item actions', disabled: dis, on: { click: (e) => lineMenu(e.currentTarget, a, l, li) } }, '⋯')));
    fillLive(l.id, r);
    return row;
  }

  function fillLive(id, r) {
    const c = liveCells.get(id);
    if (!c) return;
    fill(c.bookCell, fmt.money(r.unitCost));
    fill(c.bookTotalCell, fmt.money(r.lineCost));
    fill(c.totalCell, fmt.money(r.lineSell), r.overridden ? h('span', { class: 'ovr', title: 'Price overridden' }, ' ✎') : null,
      h('div', { class: 'muted small' }, `${fmt.money(r.unitSell)}/${UOM_LABEL[r.uom] || r.uom}`));
    fill(c.marginCell, r.qty ? marginChip(r.marginPct, floor()) : h('span', { class: 'muted' }, '—'));
    c.row.classList.toggle('has-error', r.warnings.some((w) => w.level === 'error'));
    c.row.title = r.warnings.map((w) => w.message).join('\n');
  }

  function updateLive() {
    if (tab !== 'builder') { renderTabs(); return; }
    const a = doc.areas[areaIdx];
    if (a) a.lines.forEach((l, li) => fillLive(l.id, pricing.areas[areaIdx].lines[li]));
    railEl?.querySelectorAll('[data-area-total]').forEach((s) => { s.textContent = fmt.money0(pricing.areas[Number(s.dataset.areaTotal)]?.totals.sell); });
    renderSummary();
    renderTabs();
  }

  function renderSummary() {
    if (!summaryEl) return;
    const t = pricing.totals;
    const errors = pricing.warnings.filter((w) => w.level === 'error');
    const others = pricing.warnings.filter((w) => w.level !== 'error');
    const trades = new Map(book.trades.map((x) => [x.key, x.name]));
    const row = (k, v, cls = '') => h('div', { class: `sum-row ${cls}` }, h('span', null, k), h('span', { class: 'num' }, v));
    fill(summaryEl, 
      h('h2', null, 'Job summary'),
      row('Sell ex GST', fmt.money(t.sell), 'big'),
      t.discount ? row(`Discount ${doc.adjustments.discountPct}%`, `−${fmt.money(t.discount)}`) : null,
      row('Cost', fmt.money(t.cost)),
      row('Margin', h('span', null, fmt.money(t.margin), ' ', marginChip(t.marginPct, floor()))),
      row(`GST`, fmt.money(t.gst)),
      row('Total inc GST', fmt.money(t.totalInc), 'strong'),
      t.optionalSell ? row('Optional areas', fmt.money(t.optionalSell), 'muted') : null,
      h('h3', null, 'Estimated hours'),
      Object.keys(t.hours).length ? Object.entries(t.hours).map(([k, v]) => row(trades.get(k) || k, fmt.hours(v), 'small')) : h('p', { class: 'muted small' }, 'None yet.'),
      Object.keys(t.hours).length ? row('Total', fmt.hours(t.hoursTotal), 'small strong') : null,
      errors.length || others.length ? h('h3', null, 'Checks') : null,
      h('ul', { class: 'checks' },
        errors.map((w) => h('li', { class: 'bad' }, h('button', { class: 'link', on: { click: () => jumpTo(w) } }, w.message))),
        others.map((w) => h('li', { class: w.level }, w.message))),
      !errors.length && t.sell ? h('p', { class: 'ok small' }, '✓ Ready to quote') : null);
  }

  function jumpTo(w) {
    const ai = doc.areas.findIndex((a) => String(a.id) === String(w.areaId));
    if (ai >= 0 && ai !== areaIdx) { areaIdx = ai; renderTab(); }
    if (w.code === 'discount_reason' || w.code === 'job_below_floor') { app.navigate(`#/jobs/${jobId}/details`); return; }
    const c = liveCells.get(w.lineId);
    if (c) { c.row.scrollIntoView({ block: 'center' }); c.row.querySelector('input,select')?.focus(); }
  }

  function addItemBar(a) {
    const results = h('div', { class: 'add-results', role: 'listbox', hidden: true });
    let matches = [];
    let sel = 0;
    const entries = priceBookEntries();
    const input = h('input', { type: 'search', placeholder: `Add item – type to search ${entries.filter((e) => e.o).length} products (Alt+L)`, 'aria-label': 'Add item', autocomplete: 'off' });
    // One entry's text, shared by search results and the Full Price Book so both offer the same thing.
    // A product shows its book (spreadsheet) price; a family entry adds the product in this area's finish.
    const entryContent = (e) => (e.o
      ? [h('span', { class: 'strong' }, e.label), h('span', { class: 'muted small' }, e.m.options.length > 1 ? `${e.m.category} · ${e.m.name}` : e.m.category),
        h('span', { class: 'num small', title: 'Book price from the price book (spreadsheet), before any markup' }, `${fmt.money(e.price)}/${UOM_LABEL[e.m.uom]}`)]
      : [h('span', { class: 'strong' }, `${e.m.name} – this area's finish`), h('span', { class: 'muted small' }, `${e.m.category} · ${e.m.options.length} finishes · uses the default finish set for the area`),
        h('span', { class: 'num small', title: 'Lowest book price in this family' }, e.price == null ? 'not priced' : `from ${fmt.money(e.price)}/${UOM_LABEL[e.m.uom]}`)]);
    function search() {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.hidden = true; return; }
      const terms = q.split(/\s+/);
      matches = entries.map((e) => {
        if (!terms.every((t) => e.hay.includes(t))) return null;
        const name = e.label.toLowerCase();
        const score = (name.startsWith(terms[0]) ? 0 : 1) + (name.includes(q) ? 0 : 1) + (e.o ? 0 : 0.5);
        return { e, score };
      }).filter(Boolean).sort((x, y) => x.score - y.score || x.e.order - y.e.order).slice(0, 15).map((x) => x.e);
      sel = 0;
      render();
    }
    function render() {
      clear(results);
      results.hidden = false;
      if (!matches.length) { results.append(h('div', { class: 'muted pad' }, 'No matching items. Use "Custom item" for one-offs.'), h('button', { class: 'add-row', on: { mousedown: (e) => { e.preventDefault(); addLine(a, CUSTOM_MODULE); } } }, '+ Custom item')); return; }
      matches.forEach((m, i) => {
        results.append(h('button', { class: `add-row ${i === sel ? 'sel' : ''}`, role: 'option', on: { mousedown: (ev) => { ev.preventDefault(); addEntry(a, m); } } }, ...entryContent(m)));
      });
    }
    input.addEventListener('input', search);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(matches.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (matches[sel]) addEntry(a, matches[sel]); }
      else if (e.key === 'Escape') { input.value = ''; results.hidden = true; }
    });
    input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
    return h('div', null,
      h('div', { class: 'add-item' }, input, results,
        h('button', { class: 'btn ghost', on: { click: () => addLine(a, CUSTOM_MODULE) } }, '+ Custom item')),
      fullPriceBook(a, entries, entryContent));
  }

  /**
   * Every product in the price book as its own entry (one per spreadsheet row) with its exact book price, plus one
   * "this area's finish" entry per product family (the existing area-finish way of adding). Built once per price book.
   */
  let entriesCache = null;
  function priceBookEntries() {
    if (entriesCache && entriesCache.book === book) return entriesCache.list;
    const idx = { trades: new Map(book.trades.map((t) => [t.key, t])) };
    const list = [];
    let order = 0;
    for (const m of modules()) {
      const usable = m.options.filter((o) => o.available !== false);
      const prices = usable.map((o) => unitCostOf(m, o, idx).unitCost);
      if (m.options.length > 1) list.push({ m, o: null, label: m.name, price: prices.length ? Math.min(...prices) : null, order: order++, hay: `${m.name} ${m.category} ${m.description} finish`.toLowerCase() });
      usable.forEach((o, i) => {
        const label = o.fullName ? o.name.trim() : o.name && o.name !== 'Standard' ? `${m.name} – ${o.name}` : m.name;
        list.push({ m, o, label, price: prices[i], order: order++, hay: `${label} ${m.name} ${m.category}`.toLowerCase() });
      });
    }
    entriesCache = { book, list };
    return list;
  }

  // Full Price Book: every product grouped by category, collapsed by default. A category's rows are only built when it
  // is first opened, so large price books stay quick. Open categories stay open after an item is added.
  function fullPriceBook(a, entries, entryContent) {
    const cats = new Map();
    for (const e of entries) {
      if (!cats.has(e.m.category)) cats.set(e.m.category, []);
      cats.get(e.m.category).push(e);
    }
    const products = entries.filter((e) => e.o).length;
    const sorted = [...cats.entries()].sort(([x], [y]) => x.localeCompare(y));
    const catEls = sorted.map(([cat, list]) => {
      const items = h('div', { class: 'full-book-items', role: 'list' });
      const build = () => { if (!items.childElementCount) fill(items, list.map((e) => h('button', { class: `add-row ${e.o && e.m.options.length > 1 ? 'sub' : ''}`, role: 'listitem', on: { click: () => addEntry(a, e) } }, ...entryContent(e)))); };
      const n = list.filter((e) => e.o).length;
      const d = h('details', { class: 'full-book-cat', open: openCats.has(cat), on: { toggle: () => { if (d.open) { openCats.add(cat); build(); } else openCats.delete(cat); } } },
        h('summary', null, h('span', { class: 'strong' }, cat), h('span', { class: 'muted small' }, `${n} product${n === 1 ? '' : 's'}`)), items);
      if (d.open) build();
      return d;
    });
    const setAll = (open) => { catEls.forEach((d) => { d.open = open; }); };
    // The whole list folds away under its heading; inside, each category opens and closes on its own.
    const box = h('details', { class: 'full-book', open: fullBookOpen, 'aria-label': 'Full price book', on: { toggle: () => { fullBookOpen = box.open; } } },
      h('summary', { class: 'full-book-head' }, h('h3', null, 'Full Price Book'),
        h('span', { class: 'muted small' }, `${products} products in ${sorted.length} categories, at their book prices. Open a category and click a product to add exactly that product to "${a.name}".`)),
      h('div', { class: 'full-book-tools' },
        h('button', { type: 'button', class: 'btn small ghost', on: { click: () => setAll(true) } }, 'Expand all categories'),
        h('button', { type: 'button', class: 'btn small ghost', on: { click: () => setAll(false) } }, 'Collapse all')),
      catEls);
    return box;
  }

  // A product entry adds exactly that product (its option is fixed, so no area finish can replace it).
  const addEntry = (a, e) => addLine(a, e.m.key, e.o ? e.o.key : null);

  function addLine(a, moduleKey, optionKey = null) {
    const mod = modByKey(moduleKey);
    const qty = moduleKey === CUSTOM_MODULE ? 1 : (mod.uom === 'LM' || mod.uom === 'M2' ? 0 : 1);
    const line = { id: `n${++newId}`, moduleKey, optionKey, qty, description: '', custom: moduleKey === CUSTOM_MODULE ? { unitCost: 0, uom: 'EA' } : null, override: null };
    mutate(() => a.lines.push(line));
    setTimeout(() => {
      const target = moduleKey === CUSTOM_MODULE ? liveCells.get(line.id)?.row.querySelector('input') : document.querySelector(`input[data-line-id="${line.id}"]`);
      target?.focus(); target?.select?.();
    }, 0);
  }

  function lineMenu(anchor, a, l, li) {
    popupMenu(anchor, [
      { label: l.override ? 'Edit price override…' : 'Override price…', onClick: () => overrideDialog(l, li) },
      l.override ? { label: 'Remove override', onClick: () => mutate(() => { l.override = null; }) } : null,
      l.moduleKey !== CUSTOM_MODULE ? { label: 'Edit quote wording…', onClick: () => wordingDialog(l, li) } : null,
      '-',
      { label: 'Duplicate', onClick: () => mutate(() => a.lines.splice(li + 1, 0, { ...structuredClone(l), id: `n${++newId}`, override: l.override ? { ...l.override, approvedBy: null } : null })) },
      { label: 'Move up', disabled: li === 0, onClick: () => mutate(() => a.lines.splice(li - 1, 0, a.lines.splice(li, 1)[0])) },
      { label: 'Move down', disabled: li === a.lines.length - 1, onClick: () => mutate(() => a.lines.splice(li + 1, 0, a.lines.splice(li, 1)[0])) },
      doc.areas.length > 1 ? { label: 'Move to another area…', onClick: () => moveLineDialog(a, li) } : null,
      '-',
      { label: 'Delete item', danger: true, onClick: () => mutate(() => a.lines.splice(li, 1)) },
    ].filter(Boolean));
  }

  async function wordingDialog(l, li) {
    const r = pricing.areas[areaIdx].lines[li];
    const v = await formDialog({ title: 'Quote wording', fields: [{ name: 'description', label: 'Description printed on the quote', type: 'textarea', value: l.description || r.description, help: 'Clear the box to use the standard wording.' }], submitLabel: 'Apply' });
    if (v) mutate(() => { l.description = v.description === r.description && !l.description ? '' : v.description; });
  }

  async function moveLineDialog(a, li) {
    const v = await formDialog({ title: 'Move item', fields: [{ name: 'to', label: 'Move to area', type: 'select', options: doc.areas.map((x, i) => ({ value: String(i), label: x.name })).filter((o) => Number(o.value) !== areaIdx) }], submitLabel: 'Move' });
    if (v) mutate(() => { doc.areas[Number(v.to)].lines.push(a.lines.splice(li, 1)[0]); });
  }

  async function overrideDialog(l, li) {
    const r = pricing.areas[areaIdx].lines[li];
    const base = r.unitCost * (1 + tierMarkup());
    const v = await formDialog({
      title: 'Override price', width: 520,
      intro: `Standard unit sell is ${fmt.money(base)} (cost ${fmt.money(r.unitCost)}). Overrides are recorded with your name and reason. Below the ${fmt.pct(floor(), 0)} margin floor they need an owner or admin to approve.`,
      fields: [
        { name: 'type', label: 'Override', type: 'select', value: l.override?.type || 'unit_sell', options: Object.entries(OVERRIDE_TYPES).map(([k, label]) => ({ value: k, label })) },
        { name: 'value', label: 'Value', type: 'number', step: 'any', value: l.override?.value ?? Math.round(base * 100) / 100, required: true, help: 'Dollars, except Markup % which is a percentage of cost.' },
        { name: 'reason', label: 'Reason', type: 'select', value: l.override?.reason || '', required: true, options: [{ value: '', label: '— Choose —' }, ...['Competitor match', 'Goodwill / repeat client', 'Bundle discount', 'Supplier quote', 'Correction', 'Other'].map((x) => ({ value: x, label: x }))] },
      ],
      submitLabel: 'Apply override',
    });
    if (v) mutate(() => { l.override = { type: v.type, value: Number(v.value), reason: v.reason }; });
  }

  async function addAreaMenu(anchor) {
    const templates = await get('/api/templates');
    popupMenu(anchor, [
      { label: 'Blank area', onClick: () => addArea({ name: `Area ${doc.areas.length + 1}`, type: 'other', defaultFinish: '', lines: [] }) },
      doc.areas[areaIdx] ? { label: `Duplicate "${doc.areas[areaIdx].name}"`, onClick: () => duplicateArea() } : null,
      templates.length ? '-' : null,
      ...templates.map((t) => ({ label: `From template: ${t.name}`, onClick: () => addArea({ name: uniqueAreaName(t.name.replace(/ – standard$/i, '')), type: t.areaType, defaultFinish: t.defaultFinish || '', lines: t.lines.map((x) => ({ id: `n${++newId}`, moduleKey: x.moduleKey, optionKey: x.optionKey || null, qty: x.qty || 0, description: '', custom: null, override: null })).filter((x) => modByKey(x.moduleKey)) }) })),
    ].filter(Boolean));
  }

  function uniqueAreaName(base) {
    if (!doc.areas.some((a) => a.name === base)) return base;
    let i = 2;
    while (doc.areas.some((a) => a.name === `${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  function addArea(area) {
    mutate(() => { doc.areas.push({ id: `n${++newId}`, optional: false, notes: '', ...area }); areaIdx = doc.areas.length - 1; });
    setTimeout(() => { const t = document.querySelector('.area-title'); t?.focus(); t?.select(); }, 0);
  }

  function duplicateArea() {
    const src = doc.areas[areaIdx];
    if (!src) return;
    const copy = structuredClone(src);
    copy.id = `n${++newId}`;
    copy.name = uniqueAreaName(src.name.replace(/ \d+$/, ''));
    copy.lines.forEach((l) => { l.id = `n${++newId}`; if (l.override) l.override.approvedBy = null; });
    mutate(() => { doc.areas.splice(areaIdx + 1, 0, copy); areaIdx++; });
    toast(`Created "${copy.name}".`, 'success');
  }

  async function deleteArea() {
    const a = doc.areas[areaIdx];
    if (!a) return;
    if (a.lines.length && !(await confirmDialog({ title: 'Delete area', message: `Delete "${a.name}" and its ${a.lines.length} item(s)? You can undo this with Ctrl+Z until you save.`, confirmLabel: 'Delete area', danger: true }))) return;
    mutate(() => { doc.areas.splice(areaIdx, 1); areaIdx = Math.max(0, areaIdx - 1); });
  }

  async function renameArea() {
    const a = doc.areas[areaIdx];
    if (!a) return;
    const v = await formDialog({ title: 'Rename area', fields: [{ name: 'name', label: 'Area name (printed on the quote)', value: a.name, required: true, autofocus: true }], submitLabel: 'Rename' });
    if (v && v.name.trim() && v.name.trim() !== a.name) mutate(() => { a.name = v.name.trim(); });
  }

  function areaMenu(anchor) {
    popupMenu(anchor, [
      { label: 'Rename area…', onClick: renameArea },
      { label: 'Duplicate area', onClick: duplicateArea },
      { label: 'Move up', disabled: areaIdx === 0, onClick: () => mutate(() => { doc.areas.splice(areaIdx - 1, 0, doc.areas.splice(areaIdx, 1)[0]); areaIdx--; }) },
      { label: 'Move down', disabled: areaIdx === doc.areas.length - 1, onClick: () => mutate(() => { doc.areas.splice(areaIdx + 1, 0, doc.areas.splice(areaIdx, 1)[0]); areaIdx++; }) },
      { label: 'Save as template…', disabled: !app.isManager(), onClick: saveAsTemplate },
      '-',
      { label: 'Delete area', danger: true, onClick: deleteArea },
    ]);
  }

  async function saveAsTemplate() {
    const a = doc.areas[areaIdx];
    const v = await formDialog({ title: 'Save area as template', fields: [{ name: 'name', label: 'Template name', value: a.name, required: true }, { name: 'keepQty', label: 'Keep quantities', type: 'checkbox', value: false }], submitLabel: 'Save template' });
    if (!v) return;
    await post('/api/templates', { name: v.name, areaType: a.type, defaultFinish: a.defaultFinish, lines: a.lines.filter((l) => l.moduleKey !== CUSTOM_MODULE).map((l) => ({ moduleKey: l.moduleKey, optionKey: l.optionKey, qty: v.keepQty ? l.qty : 0 })) });
    toast('Template saved. It now appears under + Add area.', 'success');
  }

  // ---------- details ----------
  function renderDetails() {
    const dis = false;
    const f = (label, key, attrs = {}) => h('label', { class: 'field' }, h('span', null, label), bind(h('input', { value: doc[key] || '', disabled: dis, ...attrs }), (v) => { doc[key] = v; }));
    const adj = doc.adjustments;
    bodyEl.append(h('div', { class: 'details-grid' },
      h('section', { class: 'panel' }, h('h2', null, 'Client & site'),
        f('Client name', 'clientName', { autocomplete: 'off' }), f('Client email', 'clientEmail', { type: 'email' }), f('Client phone', 'clientPhone', { type: 'tel' }), f('Site address', 'siteAddress'),
        h('h3', null, 'Printed at the top of the quote'),
        f('Builder', 'builderName', { autocomplete: 'off', placeholder: 'e.g. Levon Construction' }),
        f('Contact # (name and phone)', 'contactDetails', { autocomplete: 'off', placeholder: 'e.g. Levon Setrakian – 0432 881 678' }),
        h('label', { class: 'field' }, h('span', null, 'Quote is based on (first line of the quote)'),
          bind(h('textarea', { rows: 2, placeholder: 'e.g. Quote is based off client provided joinery plans Revision Dated 08.09.2026 and quote presentation 08.09.2026' }, doc.quoteBasis || ''), (v) => { doc.quoteBasis = v; })),
        h('p', { class: 'muted small' }, `Consultant on the quote: the job's designer (${doc.designerName || 'not set'}). If Contact # is empty, the client phone and email are shown.`),
        h('label', { class: 'field' }, h('span', null, 'Internal notes (not printed)'), bind(h('textarea', { rows: 5 }, doc.notes || ''), (v) => { doc.notes = v; }))),
      h('section', { class: 'panel' }, h('h2', null, 'Job discount'),
        h('p', { class: 'muted small' }, `Applied to the whole job after line prices. Needs a reason. If the job margin falls below ${fmt.pct(floor(), 0)}, an owner or admin must approve it.`),
        h('div', { class: 'inline-fields' },
          h('label', { class: 'field' }, h('span', null, 'Discount %'), bind(h('input', { type: 'number', min: 0, max: 100, step: 'any', value: adj.discountPct || 0, disabled: locked(), class: 'num-in' }), (v) => { adj.discountPct = v; delete adj.discountApprovedBy; })),
          h('label', { class: 'field grow' }, h('span', null, 'Reason'), bind(h('input', { value: adj.discountReason || '', disabled: locked() }), (v) => { adj.discountReason = v; delete adj.discountApprovedBy; }))),
        adj.discountPct && adj.discountApprovedByName ? h('p', { class: 'ok small' }, `Approved by ${adj.discountApprovedByName}.`) : null,
        h('h2', null, 'Record'),
        h('dl', { class: 'facts' },
          h('dt', null, 'Job number'), h('dd', { class: 'mono' }, doc.jobNumber),
          h('dt', null, 'Designer'), h('dd', null, doc.designerName || '—'),
          h('dt', null, 'Created'), h('dd', null, fmt.datetime(doc.createdAt)),
          h('dt', null, 'Last saved'), h('dd', null, `${fmt.datetime(doc.updatedAt)} by ${doc.updatedByName || '—'}`),
          h('dt', null, 'Revision'), h('dd', null, String(doc.revision)),
          h('dt', null, 'Price book'), h('dd', null, book.label)))));
  }

  // ---------- quotes ----------
  async function renderQuotes() {
    const wrap = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Quote revisions'), h('button', { class: 'btn accent', disabled: locked(), on: { click: () => app.run('job.quote') } }, 'Create quote…')));
    bodyEl.append(wrap);
    const rows = await get(`/api/jobs/${jobId}/quotes`);
    if (!rows.length) { wrap.append(h('p', { class: 'muted' }, 'No quotes yet. Each quote you create is a frozen revision that cannot change later.')); return; }
    wrap.append(h('p', { class: 'muted small' }, 'Quotes are never emailed or sent from here: open one, then print or save it as a PDF. Set each quote\'s status by hand. Changing a quote\'s status does not change the job; set the job\'s status at the top of the page.'));
    wrap.append(h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Rev'), h('th', null, 'Issued'), h('th', null, 'By'), h('th', { class: 'num' }, 'Ex GST'), h('th', { class: 'num' }, 'Inc GST'), h('th', { class: 'num' }, 'Margin'), h('th', null, 'Status'), h('th'))),
      h('tbody', null, rows.map((q) => h('tr', null,
        h('td', { class: 'mono' }, `R${q.rev}`), h('td', null, fmt.datetime(q.created_at)), h('td', null, q.created_by_name),
        h('td', { class: 'num' }, fmt.money(q.subtotal)), h('td', { class: 'num' }, fmt.money(q.total)), h('td', { class: 'num' }, marginChip((q.subtotal - q.cost) / q.subtotal, floor())),
        h('td', null, h('select', { class: `q-status chip q-${q.status}`, 'aria-label': `Status of quote R${q.rev}`, on: { change: (e) => setQuote(q, e.target.value, e.target) } },
          Object.entries(QUOTE_STATUS).map(([v, l]) => h('option', { value: v, selected: v === q.status }, l)))),
        h('td', { class: 'row-actions' },
          h('a', { class: 'btn small', href: `/quotes/${q.id}`, target: '_blank', rel: 'noopener' }, 'Open')))))));
  }

  async function setQuote(q, status, select) {
    try {
      await post(`/api/quotes/${q.id}/status`, { status });
      q.status = status;
      select.className = `q-status chip q-${status}`;
      toast(`Quote R${q.rev} marked ${QUOTE_STATUS[status].toLowerCase()}. The job's status is unchanged.`, 'success');
    } catch (err) {
      select.value = q.status;
      showError(err);
    }
  }

  // ---------- costs ----------
  async function renderCosts() {
    const data = await get(`/api/jobs/${jobId}/costs`);
    const b = data.budget;
    const statusLabel = { awaiting: ['Awaiting costs', ''], on_track: ['On track', 'ok'], watch: ['Watch', 'warn'], over: ['Over budget', 'bad'], loss: ['Loss', 'bad'] }[b.status];
    const maxV = Math.max(1, ...b.rows.map((r) => Math.max(r.budget, r.actual)));
    const codeOptions = [...Object.entries(data.codes).map(([v, l]) => ({ value: v, label: l })), ...b.tradeCodes.map((t) => ({ value: t.code, label: t.label }))];
    bodyEl.append(
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'Contract (ex GST)'), h('div', { class: 'kpi-value' }, fmt.money0(b.sell)), h('div', { class: 'kpi-sub' }, b.basis)),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'Budget cost'), h('div', { class: 'kpi-value' }, fmt.money0(b.totals.budget)), h('div', { class: 'kpi-sub' }, 'Material + hardware + labour')),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'Actual to date'), h('div', { class: 'kpi-value' }, fmt.money0(b.totals.actual)), h('div', { class: 'kpi-sub' }, `${b.totals.variance >= 0 ? '+' : ''}${fmt.money0(b.totals.variance)} vs budget`)),
        h('div', { class: `kpi ${statusLabel[1]}` }, h('div', { class: 'kpi-label' }, 'Status'), h('div', { class: 'kpi-value' }, statusLabel[0]), h('div', { class: 'kpi-sub' }, b.totals.actual ? `Margin so far ${fmt.pct(b.totals.actualMarginPct)}` : 'Record costs below'))),
      h('div', { class: 'grid-2' },
        h('section', { class: 'panel' }, h('h2', null, 'Budget vs actual by cost code'),
          b.rows.length ? h('table', { class: 'table compact' },
            h('thead', null, h('tr', null, h('th', null, 'Cost code'), h('th', { class: 'num' }, 'Budget'), h('th', { class: 'num' }, 'Actual'), h('th', null, ''), h('th', { class: 'num' }, 'Variance'))),
            h('tbody', null, b.rows.map((r) => h('tr', null,
              h('td', null, r.label, r.budgetHours ? h('div', { class: 'muted small' }, `${fmt.hours(r.budgetHours)} budget · ${fmt.hours(r.actualHours)} actual`) : null),
              h('td', { class: 'num' }, fmt.money0(r.budget)), h('td', { class: 'num' }, fmt.money0(r.actual)),
              h('td', { style: { width: '28%' } }, h('div', { class: 'bva' }, h('span', { class: 'b', style: { width: `${(r.budget / maxV) * 100}%` } }), h('span', { class: `a ${r.actual > r.budget ? 'over' : ''}`, style: { width: `${(r.actual / maxV) * 100}%` } }))),
              h('td', { class: `num ${r.variance > 0 ? 'bad-text' : ''}` }, `${r.variance > 0 ? '+' : ''}${fmt.money0(r.variance)}`)))))
            : h('p', { class: 'muted' }, 'Add items to the job to build a budget.')),
        h('section', { class: 'panel' }, h('h2', null, 'Record a cost'), costForm(codeOptions))),
      h('section', { class: 'panel' }, h('h2', null, 'Recorded costs'),
        data.costs.length ? h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Code'), h('th', null, 'Description'), h('th', null, 'Area'), h('th', { class: 'num' }, 'Hours'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'By'), h('th'))),
          h('tbody', null, data.costs.map((c) => h('tr', null, h('td', null, fmt.date(c.incurred_on)), h('td', { class: 'small' }, codeOptions.find((o) => o.value === c.cost_code)?.label || c.cost_code),
            h('td', null, c.description, c.supplier ? h('div', { class: 'muted small' }, c.supplier) : null), h('td', null, c.area_name || '—'), h('td', { class: 'num' }, c.hours ? fmt.hours(c.hours) : ''),
            h('td', { class: 'num' }, fmt.money(c.amount)), h('td', { class: 'small' }, c.created_by_name),
            h('td', null, h('button', { class: 'icon-btn', 'aria-label': 'Delete cost', on: { click: async () => { if (await confirmDialog({ title: 'Delete cost', message: `Delete "${c.description}" (${fmt.money(c.amount)})?`, confirmLabel: 'Delete', danger: true })) { await del(`/api/jobs/${jobId}/costs/${c.id}`); renderTab(); } } } }, '×'))))))
          : h('p', { class: 'muted' }, 'No costs recorded yet. Supplier bills and labour hours entered here are compared with the budget.')));
  }

  function costForm(codeOptions) {
    const today = new Date().toISOString().slice(0, 10);
    const form = h('form', { class: 'form compact', on: { submit: async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      const code = fd.costCode;
      const trade = code.startsWith('LAB:') ? book.trades.find((t) => `LAB:${t.key}` === code) : null;
      if (trade && !fd.amount && fd.hours) fd.amount = (Number(fd.hours) * trade.rate).toFixed(2);
      try {
        await post(`/api/jobs/${jobId}/costs`, fd);
        toast('Cost recorded.', 'success');
        renderTab();
      } catch (err) { showError(err); }
    } } },
    h('div', { class: 'inline-fields' },
      h('label', { class: 'field' }, h('span', null, 'Date'), h('input', { type: 'date', name: 'incurredOn', value: today })),
      h('label', { class: 'field grow' }, h('span', null, 'Cost code'), h('select', { name: 'costCode' }, codeOptions.map((o) => h('option', { value: o.value }, o.label))))),
    h('label', { class: 'field' }, h('span', null, 'Description'), h('input', { name: 'description', required: true, placeholder: 'e.g. Polytec board order #4471' })),
    h('div', { class: 'inline-fields' },
      h('label', { class: 'field grow' }, h('span', null, 'Supplier'), h('input', { name: 'supplier' })),
      h('label', { class: 'field grow' }, h('span', null, 'Area'), h('select', { name: 'areaId' }, h('option', { value: '' }, 'Whole job'), doc.areas.filter((a) => typeof a.id === 'number').map((a) => h('option', { value: a.id }, a.name))))),
    h('div', { class: 'inline-fields' },
      h('label', { class: 'field' }, h('span', null, 'Amount ex GST'), h('input', { name: 'amount', type: 'number', step: '0.01', min: 0, class: 'num-in' })),
      h('label', { class: 'field' }, h('span', null, 'Hours'), h('input', { name: 'hours', type: 'number', step: 'any', min: 0, class: 'num-in' })),
      h('div', { class: 'field end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add cost'))),
    h('small', { class: 'muted' }, 'For labour codes you can enter hours only; the amount is calculated at the trade rate.'));
    return form;
  }

  // ---------- history ----------
  async function renderHistory() {
    const rows = await get(`/api/jobs/${jobId}/history`);
    const label = { create: 'Created', save: 'Saved', save_as: 'Created with Save As', import: 'Imported from file', export: 'Exported to file', quote_issued: 'Quote issued', quote_accepted: 'Quote accepted', quote_declined: 'Quote declined', quote_status: 'Quote status changed', reprice: 'Price book update applied', reprice_kept: 'Price book update not applied', archive: 'Archived', restore: 'Restored', cost_add: 'Cost recorded', cost_delete: 'Cost deleted',
      schedule_proposed: 'Schedule proposed by the system', schedule_confirmed: 'Schedule confirmed to calendar', schedule_cancelled: 'Open events cancelled',
      event_added: 'Event added', event_updated: 'Event changed', event_cancelled: 'Event removed', job_reopened: 'Job reopened' };
    const kinds = { all: 'Everything', save: 'Saves and changes', status: 'Status changes and reopening', quote: 'Quotes', price: 'Price book updates', schedule: 'Schedule', cost: 'Costs' };
    const kindOf = (r) => (r.action === 'job_reopened' || (r.action === 'save' && r.detail?.status) ? 'status' : r.action === 'save' ? 'save' : r.action.startsWith('quote') ? 'quote'
      : r.action.startsWith('reprice') ? 'price' : r.action.startsWith('cost') ? 'cost' : /^(schedule|event)_/.test(r.action) ? 'schedule' : 'save');
    let filter = 'all';
    const list = h('div');
    const draw = () => fill(list, h('table', { class: 'table compact history' },
      h('thead', null, h('tr', null, h('th', null, 'Date & time'), h('th', null, 'User'), h('th', null, 'Action'), h('th', null, 'Details: previous → new'))),
      h('tbody', null, rows.filter((r) => filter === 'all' || kindOf(r) === filter || (filter === 'save' && r.action === 'save')).map((r) => h('tr', { class: r.action === 'job_reopened' ? 'hl' : '' },
        h('td', { class: 'small nowrap' }, fmt.datetime(r.at)), h('td', null, r.user_name || '—'), h('td', { class: 'nowrap' }, label[r.action] || r.action.replace(/_/g, ' ')),
        h('td', { class: 'small' }, describe(r)))))));
    bodyEl.append(h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'History'),
        h('select', { 'aria-label': 'Show', on: { change: (e) => { filter = e.target.value; draw(); } } }, Object.entries(kinds).map(([k, l]) => h('option', { value: k }, l)))),
      h('p', { class: 'muted small' }, 'Every change to this job: who, when, what, and the previous and new values. Nothing here can be edited or deleted.'),
      list));
    draw();
  }
  const arrow = (from, to) => h('span', null, h('span', { class: 'was' }, from === '' || from == null ? '(empty)' : String(from)), ' → ', h('span', { class: 'now' }, to === '' || to == null ? '(empty)' : String(to)));
  function changeItem(c) {
    if (c.kind === 'more') return h('li', { class: 'muted' }, `…and ${c.count} more changes`);
    const where = [c.area, c.item].filter(Boolean).join(' › ');
    if (c.action === 'added') return h('li', null, h('span', { class: 'chip small ok' }, 'Added'), ' ', c.kind === 'area' ? `Area "${c.area}"` : `${c.item} in ${c.area}`, c.to ? ` (${c.to})` : '');
    if (c.action === 'removed') return h('li', null, h('span', { class: 'chip small bad' }, 'Deleted'), ' ', c.kind === 'area' ? `Area "${c.area}"` : `${c.item} in ${c.area}`, c.from ? ` (was ${c.from})` : '');
    return h('li', null, where ? h('span', { class: 'muted' }, `${where}: `) : null, h('strong', null, c.field), ' ', arrow(c.from, c.to));
  }
  function describe(r) {
    const d = r.detail || {};
    if (r.action === 'save') {
      const head = [d.revision ? `Revision ${d.revision}` : '', d.sell != null ? `${fmt.money(d.sell)} ex GST` : ''].filter(Boolean).join(' · ');
      if (!d.changes) return [head, d.status || ''].filter(Boolean).join(' · ');
      return h('div', null, h('div', { class: 'muted' }, head, d.changes.length ? '' : ' · no changes'), d.changes.length ? h('ul', { class: 'changes' }, d.changes.map(changeItem)) : null);
    }
    if (r.action === 'job_reopened') return h('div', null, h('div', null, h('strong', null, 'Status '), arrow(d.fromLabel || d.from, d.toLabel || d.to)), h('div', null, h('strong', null, 'Reason: '), d.reason));
    if (r.action === 'quote_issued') return `R${d.rev} · ${fmt.money(d.total)} inc GST`;
    if (r.action === 'reprice') return h('div', null, d.via ? `When ${d.via}. ` : 'Update to latest prices. ', d.fromLabel ? h('span', null, h('strong', null, 'Price book '), arrow(d.fromLabel, d.toLabel)) : null,
      d.sellBefore != null ? h('span', null, ' · ', h('strong', null, 'Sell ex GST '), arrow(fmt.money(d.sellBefore), fmt.money(d.sellAfter))) : null);
    if (r.action === 'reprice_kept') return `"${d.book}" was published; this job was not selected, so its prices did not change`;
    if (r.action === 'quote_status') return h('span', null, `R${d.rev}: `, arrow(QUOTE_STATUS[d.from] || d.from, QUOTE_STATUS[d.to] || d.to));
    if (r.action === 'cost_add') return [d.code, d.description, fmt.money(d.amount), d.hours ? `${fmt.hours(d.hours)} h` : ''].filter(Boolean).join(' · ');
    if (r.action === 'cost_delete') return d.description ? `Deleted: ${[d.code, d.description, fmt.money(d.amount), d.incurredOn ? fmt.date(d.incurredOn) : ''].filter(Boolean).join(' · ')}` : '';
    if (r.action === 'event_updated') return `${d.title}: ${d.changes}`;
    if (r.action === 'event_added' || r.action === 'event_cancelled') return d.title || '';
    if (r.action === 'schedule_confirmed' || r.action === 'schedule_cancelled') return `${d.events} event${d.events === 1 ? '' : 's'}`;
    if (d.from) return `from ${d.from}`;
    return '';
  }

  // ---------- file commands ----------
  async function save() {
    if (!isDirty()) { app.setStatus('No changes to save.'); return true; }
    try {
      payload = await put(`/api/jobs/${jobId}`, { ...doc, revision: doc.revision });
      const keepArea = areaIdx;
      doc = structuredClone(payload.job);
      savedSig = sig(doc);
      areaIdx = Math.min(keepArea, doc.areas.length - 1);
      recalc();
      renderHead();
      renderTab();
      app.updateTitle();
      app.setStatus(`Saved at ${new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })} · revision ${doc.revision}`);
      toast('Saved.', 'success', 1800);
      return true;
    } catch (err) {
      if (err.status === 409 && err.details?.reason === 'revision') {
        const again = await confirmDialog({ title: 'Saved elsewhere', message: `${err.message}\n\nSave your version as a new job now?`, confirmLabel: 'Save As new job' });
        if (again) await saveAs();
        return false;
      }
      showError(err);
      return false;
    }
  }

  async function saveAs() {
    const v = await formDialog({
      title: 'Save As', submitLabel: 'Save as new job',
      intro: 'Creates a new job with its own job number. The original job is left as it was last saved.',
      fields: [
        { name: 'name', label: 'New job name', value: `${doc.name} (copy)`, required: true, autofocus: true },
        { name: 'clientName', label: 'Client name', value: doc.clientName },
        { name: 'useLatestPrices', label: 'Use the latest published prices', type: 'checkbox', value: false, help: `Unticked keeps "${book.label}".` },
      ],
    });
    if (!v) return false;
    const { id } = await post(`/api/jobs/${jobId}/save-as`, { doc, ...v });
    savedSig = sig(doc); // unsaved edits went into the new job; the original stays as last saved
    toast('Saved as a new job.', 'success');
    app.navigate(`#/jobs/${id}`);
    return true;
  }

  async function exportFile() {
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'Save first?', message: 'The job file contains the last saved version. Save your changes now?', confirmLabel: 'Save and export' });
      if (!ok || !(await save())) return;
    }
    const name = await download(`/api/jobs/${jobId}/export`);
    toast(`Exported ${name}`, 'success');
  }

  async function createQuote() {
    if (locked()) return;
    if (isDirty()) {
      const ok = await confirmDialog({ title: 'Save before quoting', message: 'Quotes are created from the saved job. Save your changes now?', confirmLabel: 'Save' });
      if (!ok || !(await save())) return;
    }
    const errors = pricing.warnings.filter((w) => w.level === 'error');
    if (errors.length) {
      modal({ title: 'Resolve these before quoting', body: h('ul', { class: 'problem-list' }, errors.map((w) => h('li', null, w.message))), actions: [{ label: 'OK', kind: 'primary' }] });
      return;
    }
    const v = await formDialog({
      title: 'Create quote', submitLabel: 'Create quote',
      intro: `Total ${fmt.money(pricing.totals.totalInc)} inc GST. The quote is saved as a new revision; later changes need a new revision. Nothing is sent to the client, and the job's status stays as it is.`,
      fields: [
        { name: 'showItems', label: 'List the items under each area ("*1x …")', type: 'checkbox', value: true, help: 'Untick to show only each area\'s inclusions & notes, as on hand-written Vicello quotes.' },
        { name: 'showUnitPrices', label: 'Show item prices on the quote', type: 'checkbox', value: false },
      ],
    });
    if (!v) return;
    const q = await post(`/api/jobs/${jobId}/quotes`, { revision: doc.revision, ...v });
    await reload();
    window.open(`/quotes/${q.id}`, '_blank', 'noopener');
    toast(`Quote R${q.rev} created.`, 'success');
    if (tab !== 'quotes') app.navigate(`#/jobs/${jobId}/quotes`);
  }

  async function reprice() {
    if (!payload.newerBook) { toast('This job already uses the latest published prices.'); return; }
    if (isDirty()) { toast('Save your changes before updating prices.', 'error'); return; }
    const p = await get(`/api/jobs/${jobId}/reprice?to=${payload.newerBook.id}`);
    const diff = p.to.totals.sell - p.from.totals.sell;
    modal({
      title: 'Update to latest prices', width: 680,
      body: h('div', null,
        h('p', null, `Move this job from "${p.from.label}" to "${p.to.label}".`),
        h('div', { class: 'kpis small' },
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'Current sell'), h('div', { class: 'kpi-value' }, fmt.money0(p.from.totals.sell))),
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'New sell'), h('div', { class: 'kpi-value' }, fmt.money0(p.to.totals.sell))),
          h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, 'Change'), h('div', { class: 'kpi-value' }, `${diff >= 0 ? '+' : ''}${fmt.money0(diff)}`))),
        p.lines.length ? h('div', { class: 'table-wrap', style: { maxHeight: '280px' } }, h('table', { class: 'table compact' },
          h('thead', null, h('tr', null, h('th', null, 'Area'), h('th', null, 'Item'), h('th', { class: 'num' }, 'Before'), h('th', { class: 'num' }, 'After'))),
          h('tbody', null, p.lines.map((l) => h('tr', null, h('td', null, l.area), h('td', null, l.description), h('td', { class: 'num' }, fmt.money(l.fromSell)), h('td', { class: 'num' }, fmt.money(l.toSell)))))))
          : h('p', { class: 'muted' }, 'No line prices change.'),
        p.warnings.length ? h('ul', { class: 'problem-list' }, p.warnings.map((w) => h('li', null, w.message))) : null),
      actions: [{ label: 'Cancel' }, { label: 'Update prices', kind: 'primary', onClick: async () => {
        payload = await post(`/api/jobs/${jobId}/reprice`, { to: payload.newerBook.id, revision: doc.revision });
        book = await loadBook(payload.job.priceBookId);
        doc = structuredClone(payload.job); savedSig = sig(doc); recalc(); renderHead(); renderTab(); app.updateTitle();
        toast('Job moved to the latest prices.', 'success');
      } }],
    });
  }

  async function archive() {
    if (!(await confirmDialog({ title: doc.archivedAt ? 'Restore job' : 'Archive job', message: doc.archivedAt ? 'Restore this job to the active list?' : 'Archived jobs are hidden from lists but kept with their history. Archive this job?', confirmLabel: doc.archivedAt ? 'Restore' : 'Archive' }))) return;
    await post(`/api/jobs/${jobId}/${doc.archivedAt ? 'restore' : 'archive'}`);
    savedSig = sig(doc);
    toast(doc.archivedAt ? 'Job restored.' : 'Job archived.', 'success');
    app.navigate('#/jobs');
  }

  async function reload() {
    payload = await get(`/api/jobs/${jobId}`);
    book = await loadBook(payload.job.priceBookId);
    doc = structuredClone(payload.job);
    savedSig = sig(doc);
    recalc(); renderHead(); renderTab(); app.updateTitle();
  }

  // ---------- boot ----------
  recalc();
  renderHead();
  renderTab();
  app.setStatus(`${doc.areas.length} area${doc.areas.length === 1 ? '' : 's'} · last saved ${fmt.ago(doc.updatedAt)}${doc.updatedByName ? ` by ${doc.updatedByName}` : ''}`);
  if (doc.archivedAt) toast('This job is archived. Use Job → Restore to edit it.', 'info', 5000);

  const editing = () => !locked() && tab === 'builder';
  return {
    title: () => `${doc.jobNumber} ${doc.name}`,
    isDirty,
    save,
    handlesHash: (hash) => new RegExp(`^#/jobs/${jobId}(/\\w+)?$`).test(hash),
    onHash: (hash) => { const m = hash.match(/^#\/jobs\/\d+\/(\w+)$/); tab = m && TABS.some(([k]) => k === m[1]) ? m[1] : 'builder'; renderTab(); },
    commands: {
      'file.save': { run: save, when: () => true },
      'file.saveAs': { run: saveAs },
      'file.export': { run: exportFile },
      'file.close': { label: 'Close job', run: () => app.navigate('#/jobs') },
      'edit.undo': { run: () => { if (undo.length) { redo.push(JSON.stringify(doc)); restore(undo.pop()); } }, when: () => undo.length > 0 },
      'edit.redo': { run: () => { if (redo.length) { undo.push(JSON.stringify(doc)); restore(redo.pop()); } }, when: () => redo.length > 0 },
      'edit.addArea': { run: () => { if (tab !== 'builder') app.navigate(`#/jobs/${jobId}`); setTimeout(() => addAreaMenu(document.querySelector('.area-rail .btn.dashed')), 50); }, when: () => !locked() },
      'edit.duplicateArea': { run: duplicateArea, when: () => editing() && doc.areas.length > 0 },
      'edit.deleteArea': { run: deleteArea, when: () => editing() && doc.areas.length > 0 },
      'edit.addLine': { run: () => document.querySelector('.add-item input')?.focus(), when: () => editing() && doc.areas.length > 0 },
      'edit.addCustom': { run: () => addLine(doc.areas[areaIdx], CUSTOM_MODULE), when: () => editing() && doc.areas.length > 0 },
      'job.details': { run: () => app.navigate(`#/jobs/${jobId}/details`) },
      'job.quote': { run: createQuote, when: () => !locked() },
      'job.quotes': { run: () => app.navigate(`#/jobs/${jobId}/quotes`) },
      'job.schedule': { run: () => app.navigate(`#/jobs/${jobId}/schedule`) },
      'job.costs': { run: () => app.navigate(`#/jobs/${jobId}/costs`) },
      'job.history': { run: () => app.navigate(`#/jobs/${jobId}/history`) },
      'job.reprice': { run: reprice, when: () => !!payload.newerBook && !locked() },
      'job.archive': { label: doc.archivedAt ? 'Restore job' : 'Archive job', run: archive, when: () => app.isManager() },
    },
  };
}

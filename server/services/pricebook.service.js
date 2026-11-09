// Versioned price books. A version is a draft until published; published versions are immutable
// (enforced here and by database triggers). Jobs pin a version and keep snapshots of what they used.
import { badRequest, conflict, notFound } from '../http/http.js';
import { diffBooks, indexBook, priceJob, round2, unitCostOf } from '../../shared/pricing.js';
import { slug } from '../seed/legacy-import.js';
import { audit } from './audit.service.js';

const UOMS = ['LM', 'EA', 'M2', 'JOB', 'HR'];
const now = () => new Date().toISOString();
const publishedCache = new Map();

export function listBooks(db, companyId) {
  return db.all(`SELECT p.id, p.label, p.status, p.based_on_id, p.effective_from, p.note, p.created_at, p.updated_at, p.published_at,
                        cu.name AS created_by_name, pu.name AS published_by_name,
                        (SELECT COUNT(*) FROM jobs j WHERE j.price_book_id = p.id AND j.archived_at IS NULL) AS job_count
                 FROM price_books p
                 LEFT JOIN users cu ON cu.id = p.created_by
                 LEFT JOIN users pu ON pu.id = p.published_by
                 WHERE p.company_id = ? ORDER BY p.id DESC`, companyId);
}

export function currentPublished(db, companyId) {
  const today = now().slice(0, 10);
  return db.get(`SELECT id FROM price_books WHERE company_id = ? AND status = 'published'
                 AND (effective_from IS NULL OR effective_from <= ?)
                 ORDER BY effective_from DESC, published_at DESC LIMIT 1`, companyId, today)
    || db.get(`SELECT id FROM price_books WHERE company_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1`, companyId);
}

function bookRow(db, companyId, id) {
  const row = db.get('SELECT * FROM price_books WHERE id = ? AND company_id = ?', id, companyId);
  if (!row) throw notFound('Price book not found.');
  return row;
}

/** Full snapshot of a version in the shape the pricing engine expects. Published snapshots are cached. */
export function loadBook(db, companyId, id) {
  const row = bookRow(db, companyId, id);
  const cacheKey = `${db.file}|${id}`; // one cache per database file
  if (row.status !== 'draft' && publishedCache.has(cacheKey)) return publishedCache.get(cacheKey);
  const labour = new Map();
  for (const l of db.all('SELECT module_key, trade_key, hours FROM pb_module_labour WHERE price_book_id = ?', id)) {
    if (!labour.has(l.module_key)) labour.set(l.module_key, {});
    labour.get(l.module_key)[l.trade_key] = l.hours;
  }
  const options = new Map();
  for (const o of db.all('SELECT * FROM pb_options WHERE price_book_id = ? ORDER BY sort, id', id)) {
    if (!options.has(o.module_key)) options.set(o.module_key, []);
    const opt = {
      key: o.key, name: o.name, finishGroups: o.finish_groups ? o.finish_groups.split(',') : [],
      material: o.material, hardware: o.hardware, labourFactor: o.labour_factor, available: !!o.available,
      costBasis: o.cost_basis, note: o.note || '', source: o.source || '', sort: o.sort,
    };
    if (o.labour_cost) opt.labourCost = JSON.parse(o.labour_cost);
    if (o.full_name) opt.fullName = true;
    options.get(o.module_key).push(opt);
  }
  const book = {
    id: row.id, label: row.label, status: row.status, basedOnId: row.based_on_id, effectiveFrom: row.effective_from,
    note: row.note || '', publishedAt: row.published_at, updatedAt: row.updated_at,
    trades: db.all('SELECT key, name, rate, sort FROM pb_trades WHERE price_book_id = ? ORDER BY sort, id', id),
    finishGroups: db.all('SELECT key, name, sort FROM pb_finish_groups WHERE price_book_id = ? ORDER BY sort, id', id),
    tiers: db.all('SELECT key, name, markup, is_default, sort FROM pb_tiers WHERE price_book_id = ? ORDER BY sort, id', id)
      .map((t) => ({ key: t.key, name: t.name, markup: t.markup, isDefault: !!t.is_default, sort: t.sort })),
    modules: db.all('SELECT * FROM pb_modules WHERE price_book_id = ? ORDER BY sort, id', id).map((m) => ({
      key: m.key, name: m.name, category: m.category, uom: m.uom, description: m.description || '', sort: m.sort,
      active: !!m.active, labour: labour.get(m.key) || {}, options: options.get(m.key) || [],
    })),
    materials: db.all('SELECT id, supplier, product, thickness, sheet_size, m2_rate, sheet_rate, note, sort FROM pb_materials WHERE price_book_id = ? ORDER BY sort, id', id)
      .map((m) => ({ id: m.id, supplier: m.supplier, product: m.product, thickness: m.thickness, sheetSize: m.sheet_size, m2Rate: m.m2_rate, sheetRate: m.sheet_rate, note: m.note || '', sort: m.sort })),
  };
  if (row.status !== 'draft') {
    Object.defineProperty(book, '__idx', { value: indexBook(book), enumerable: false });
    publishedCache.set(cacheKey, book);
  }
  return book;
}

/** Insert a whole price book (used by setup, import and clone). */
export function insertBook(db, companyId, data, { userId, status = 'draft', basedOnId = null }) {
  return db.tx(() => {
    const ts = now();
    const { lastInsertRowid } = db.run(
      `INSERT INTO price_books (company_id, label, status, based_on_id, effective_from, note, created_by, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      companyId, data.label, basedOnId, data.effectiveFrom || null, data.note || null, userId ?? null, ts, ts);
    const id = Number(lastInsertRowid);
    for (const t of data.trades) db.run('INSERT INTO pb_trades (price_book_id, key, name, rate, sort) VALUES (?, ?, ?, ?, ?)', id, t.key, t.name, t.rate, t.sort ?? 0);
    for (const f of data.finishGroups) db.run('INSERT INTO pb_finish_groups (price_book_id, key, name, sort) VALUES (?, ?, ?, ?)', id, f.key, f.name, f.sort ?? 0);
    for (const t of data.tiers) db.run('INSERT INTO pb_tiers (price_book_id, key, name, markup, is_default, sort) VALUES (?, ?, ?, ?, ?, ?)', id, t.key, t.name, t.markup, t.isDefault ? 1 : 0, t.sort ?? 0);
    for (const m of data.modules) {
      db.run('INSERT INTO pb_modules (price_book_id, key, name, category, uom, description, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, m.key, m.name, m.category, m.uom, m.description || null, m.sort ?? 0, m.active === false ? 0 : 1);
      for (const [trade, hours] of Object.entries(m.labour || {})) {
        if (hours) db.run('INSERT INTO pb_module_labour (price_book_id, module_key, trade_key, hours) VALUES (?, ?, ?, ?)', id, m.key, trade, hours);
      }
      for (const o of m.options) insertOption(db, id, m.key, o);
    }
    for (const mt of data.materials || []) {
      db.run('INSERT INTO pb_materials (price_book_id, supplier, product, thickness, sheet_size, m2_rate, sheet_rate, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, mt.supplier, mt.product, mt.thickness || null, mt.sheetSize || null, mt.m2Rate ?? null, mt.sheetRate ?? null, mt.note || null, mt.sort ?? 0);
    }
    if (status === 'published') publishRow(db, companyId, id, userId);
    audit(db, { companyId, userId, entity: 'price_book', entityId: id, action: basedOnId ? 'clone' : 'create', detail: { label: data.label, basedOnId } });
    return id;
  });
}

/** Validate labour dollars per trade: { TRADE_KEY: dollars ≥ 0 }. Returns JSON text, or null when there is none. */
function labourCostJson(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('Labour costs must be dollars per trade.');
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!/^[A-Z0-9_]{1,40}$/.test(k)) throw badRequest(`Unknown trade "${k}".`);
    if (raw === '' || raw == null) continue;
    out[k] = num(raw, `${k} labour`);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Unit rates are stored exactly as entered (no rounding); only line and job totals are rounded to cents.
function insertOption(db, bookId, moduleKey, o) {
  db.run(`INSERT INTO pb_options (price_book_id, module_key, key, name, finish_groups, material, hardware, labour_factor, available, cost_basis, note, source, sort, labour_cost, full_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bookId, moduleKey, o.key, o.name, (o.finishGroups || []).join(','), num(o.material || 0, 'Material'), num(o.hardware || 0, 'Hardware'),
    o.labourFactor ?? 1, o.available === false ? 0 : 1, o.costBasis || 'component', o.note || null, o.source || null, o.sort ?? 0,
    labourCostJson(o.labourCost), o.fullName ? 1 : 0);
}

function publishRow(db, companyId, id, userId) {
  const ts = now();
  db.run(`UPDATE price_books SET status = 'published', published_at = ?, published_by = ?, updated_at = ?,
          effective_from = COALESCE(effective_from, ?) WHERE id = ?`, ts, userId ?? null, ts, ts.slice(0, 10), id);
}

/** "Save As": copy any version into a new draft. */
export function cloneBook(db, companyId, id, { userId, label }) {
  const src = loadBook(db, companyId, id);
  return insertBook(db, companyId, { ...src, label: label || `${src.label} (copy)`, effectiveFrom: null, note: src.note }, { userId, basedOnId: id });
}

export function validateBook(book) {
  const problems = [];
  if (!book.tiers.length) problems.push('Add at least one price tier.');
  if (!book.tiers.some((t) => t.isDefault)) problems.push('Mark one price tier as the default.');
  const idx = indexBook(book);
  for (const m of book.modules) {
    if (!m.options.length) problems.push(`"${m.name}" has no options.`);
    for (const t of Object.keys(m.labour || {})) if (!idx.trades.has(t)) problems.push(`"${m.name}" uses unknown trade ${t}.`);
    for (const o of m.options) {
      for (const t of Object.keys(o.labourCost || {})) if (!idx.trades.has(t)) problems.push(`"${m.name} – ${o.name}" uses unknown trade ${t}.`);
      if (o.available === false) continue;
      if (unitCostOf(m, o, idx).unitCost <= 0) problems.push(`"${m.name} – ${o.name}" is available but has zero cost.`);
      for (const fg of o.finishGroups) if (!idx.finishGroups.has(fg)) problems.push(`"${m.name} – ${o.name}" uses unknown finish group ${fg}.`);
    }
  }
  return problems;
}

/** Sell value of open jobs under their current version vs. this version. */
export function publishImpact(db, companyId, id, settings) {
  const target = loadBook(db, companyId, id);
  const jobs = db.all(`SELECT id, job_number, name, client_name, status, price_book_id, tier_key FROM jobs
                       WHERE company_id = ? AND archived_at IS NULL AND status IN ('enquiry','quoting','quoted') AND price_book_id <> ? ORDER BY job_number`, companyId, id);
  const rows = [];
  for (const j of jobs) {
    const doc = loadJobLinesForPricing(db, j);
    const before = priceJob(doc, loadBook(db, companyId, j.price_book_id), settings).totals.sell;
    const after = priceJob(doc, target, settings).totals.sell;
    rows.push({ id: j.id, jobNumber: j.job_number, name: j.name, client: j.client_name || '', status: j.status, before, after, change: round2(after - before), changePct: before ? (after - before) / before : 0 });
  }
  return rows;
}

export function loadJobLinesForPricing(db, job) {
  const areas = db.all('SELECT id, name, default_finish, optional FROM job_areas WHERE job_id = ? ORDER BY sort, id', job.id);
  const lines = db.all('SELECT * FROM job_lines WHERE job_id = ? ORDER BY sort, id', job.id);
  return {
    tierKey: job.tier_key,
    areas: areas.map((a) => ({
      id: a.id, name: a.name, defaultFinish: a.default_finish, optional: !!a.optional,
      lines: lines.filter((l) => l.area_id === a.id).map((l) => ({
        id: l.id, moduleKey: l.module_key, optionKey: l.option_key, qty: l.qty, description: l.description || '',
        custom: l.custom_unit_cost != null ? { unitCost: l.custom_unit_cost, uom: l.custom_uom } : undefined,
        override: l.override_type ? { type: l.override_type, value: l.override_value, reason: l.override_reason, approvedBy: l.override_approved_by } : null,
      })),
    })),
  };
}

export function publishBook(db, companyId, id, { userId, effectiveFrom }) {
  const row = bookRow(db, companyId, id);
  if (row.status !== 'draft') throw conflict('Only drafts can be published.');
  const problems = validateBook(loadBook(db, companyId, id));
  if (problems.length) throw badRequest('This draft cannot be published yet.', { problems });
  db.tx(() => {
    if (effectiveFrom) db.run('UPDATE price_books SET effective_from = ? WHERE id = ?', effectiveFrom, id);
    publishRow(db, companyId, id, userId);
    audit(db, { companyId, userId, entity: 'price_book', entityId: id, action: 'publish', detail: { label: row.label, effectiveFrom } });
  });
  return loadBook(db, companyId, id);
}

export function archiveBook(db, companyId, id, { userId }) {
  const row = bookRow(db, companyId, id);
  if (row.status !== 'published') throw conflict('Only published versions can be archived.');
  db.run("UPDATE price_books SET status = 'archived', updated_at = ? WHERE id = ?", now(), id);
  publishedCache.delete(`${db.file}|${id}`);
  audit(db, { companyId, userId, entity: 'price_book', entityId: id, action: 'archive' });
}

export function deleteDraft(db, companyId, id, { userId }) {
  const row = bookRow(db, companyId, id);
  if (row.status !== 'draft') throw conflict('Published versions cannot be deleted. Archive them instead.');
  if (db.get('SELECT 1 FROM jobs WHERE price_book_id = ? LIMIT 1', id)) throw conflict('Jobs use this draft.');
  db.run('DELETE FROM price_books WHERE id = ?', id);
  audit(db, { companyId, userId, entity: 'price_book', entityId: id, action: 'delete_draft', detail: { label: row.label } });
}

export function diff(db, companyId, id, againstId) {
  const to = loadBook(db, companyId, id);
  const fromId = againstId || to.basedOnId;
  if (!fromId) return { from: null, changes: [] };
  const from = loadBook(db, companyId, fromId);
  return { from: { id: from.id, label: from.label }, changes: diffBooks(from, to) };
}

// ---- Draft editing: a batch of change operations applied in one transaction ("Save") ----

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${name} must be a number of 0 or more.`);
  return n;
};
const text = (v, name, max = 300) => {
  const s = String(v ?? '').trim();
  if (!s) throw badRequest(`${name} is required.`);
  if (s.length > max) throw badRequest(`${name} is too long.`);
  return s;
};

export function applyChanges(db, companyId, id, changes, { userId }) {
  const row = bookRow(db, companyId, id);
  if (row.status !== 'draft') throw conflict('This version is published and locked. Use "Save As new draft" to make changes.');
  if (!Array.isArray(changes) || !changes.length) return loadBook(db, companyId, id);
  db.tx(() => {
    for (const c of changes) applyOne(db, id, c);
    db.run('UPDATE price_books SET updated_at = ? WHERE id = ?', now(), id);
    audit(db, { companyId, userId, entity: 'price_book', entityId: id, action: 'save', detail: { count: changes.length, ops: summarize(changes) } });
  });
  return loadBook(db, companyId, id);
}

function summarize(changes) {
  const out = {};
  for (const c of changes) out[c.op] = (out[c.op] || 0) + 1;
  return out;
}

function uniqueKey(db, table, bookId, base, extraWhere = '', ...extra) {
  let k = base || 'item', i = 2;
  while (db.get(`SELECT 1 FROM ${table} WHERE price_book_id = ? AND key = ? ${extraWhere}`, bookId, k, ...extra)) k = `${base}-${i++}`;
  return k;
}

function applyOne(db, id, c) {
  const f = c.fields || {};
  switch (c.op) {
    case 'book.update': {
      if ('label' in f) db.run('UPDATE price_books SET label = ? WHERE id = ?', text(f.label, 'Label', 120), id);
      if ('note' in f) db.run('UPDATE price_books SET note = ? WHERE id = ?', String(f.note || ''), id);
      if ('effectiveFrom' in f) db.run('UPDATE price_books SET effective_from = ? WHERE id = ?', f.effectiveFrom || null, id);
      return;
    }
    case 'option.update': {
      const o = db.get('SELECT id FROM pb_options WHERE price_book_id = ? AND module_key = ? AND key = ?', id, c.moduleKey, c.optionKey);
      if (!o) throw badRequest(`Option ${c.moduleKey}/${c.optionKey} not found.`);
      const sets = [], vals = [];
      if ('name' in f) { sets.push('name = ?'); vals.push(text(f.name, 'Option name')); }
      if ('material' in f) { sets.push('material = ?'); vals.push(num(f.material, 'Material')); }
      if ('hardware' in f) { sets.push('hardware = ?'); vals.push(num(f.hardware, 'Hardware')); }
      if ('labourCost' in f) { sets.push('labour_cost = ?'); vals.push(labourCostJson(f.labourCost)); }
      if ('labourFactor' in f) { sets.push('labour_factor = ?'); vals.push(num(f.labourFactor, 'Labour factor')); }
      if ('available' in f) { sets.push('available = ?'); vals.push(f.available ? 1 : 0); }
      if ('finishGroups' in f) { sets.push('finish_groups = ?'); vals.push((f.finishGroups || []).join(',')); }
      if ('note' in f) { sets.push('note = ?'); vals.push(String(f.note || '')); }
      if ('costBasis' in f) { sets.push('cost_basis = ?'); vals.push(f.costBasis); }
      if (sets.length) db.run(`UPDATE pb_options SET ${sets.join(', ')} WHERE id = ?`, ...vals, o.id);
      return;
    }
    case 'option.add': {
      const o = c.option || {};
      const name = text(o.name, 'Option name');
      const max = db.get('SELECT COALESCE(MAX(sort), -1) AS s FROM pb_options WHERE price_book_id = ? AND module_key = ?', id, c.moduleKey).s;
      const key = uniqueKey(db, 'pb_options', id, slug(name), 'AND module_key = ?', c.moduleKey);
      insertOption(db, id, c.moduleKey, { ...o, key, name, material: num(o.material || 0, 'Material'), hardware: num(o.hardware || 0, 'Hardware'), labourFactor: num(o.labourFactor ?? 1, 'Labour factor'), costBasis: 'component', sort: max + 1 });
      return;
    }
    case 'option.delete': {
      db.run('DELETE FROM pb_options WHERE price_book_id = ? AND module_key = ? AND key = ?', id, c.moduleKey, c.optionKey);
      return;
    }
    case 'module.add': {
      const m = c.module || {};
      const name = text(m.name, 'Module name');
      if (!UOMS.includes(m.uom)) throw badRequest('Choose a unit of measure.');
      const key = uniqueKey(db, 'pb_modules', id, slug(name));
      const max = db.get('SELECT COALESCE(MAX(sort), -1) AS s FROM pb_modules WHERE price_book_id = ?', id).s;
      db.run('INSERT INTO pb_modules (price_book_id, key, name, category, uom, description, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        id, key, name, text(m.category, 'Category', 60), m.uom, m.description || null, max + 1);
      for (const [trade, hours] of Object.entries(m.labour || {})) {
        if (Number(hours) > 0) db.run('INSERT INTO pb_module_labour (price_book_id, module_key, trade_key, hours) VALUES (?, ?, ?, ?)', id, key, trade, num(hours, 'Hours'));
      }
      const opts = m.options && m.options.length ? m.options : [{ name: 'Standard', material: 0 }];
      opts.forEach((o, i) => insertOption(db, id, key, { ...o, key: slug(o.name) || `opt-${i}`, costBasis: 'component', sort: i }));
      return;
    }
    case 'module.update': {
      const exists = db.get('SELECT id FROM pb_modules WHERE price_book_id = ? AND key = ?', id, c.key);
      if (!exists) throw badRequest(`Module ${c.key} not found.`);
      const sets = [], vals = [];
      if ('name' in f) { sets.push('name = ?'); vals.push(text(f.name, 'Module name')); }
      if ('category' in f) { sets.push('category = ?'); vals.push(text(f.category, 'Category', 60)); }
      if ('uom' in f) { if (!UOMS.includes(f.uom)) throw badRequest('Unknown unit of measure.'); sets.push('uom = ?'); vals.push(f.uom); }
      if ('description' in f) { sets.push('description = ?'); vals.push(String(f.description || '')); }
      if ('active' in f) { sets.push('active = ?'); vals.push(f.active ? 1 : 0); }
      if (sets.length) db.run(`UPDATE pb_modules SET ${sets.join(', ')} WHERE id = ?`, ...vals, exists.id);
      if (f.labour) {
        db.run('DELETE FROM pb_module_labour WHERE price_book_id = ? AND module_key = ?', id, c.key);
        for (const [trade, hours] of Object.entries(f.labour)) {
          if (Number(hours) > 0) db.run('INSERT INTO pb_module_labour (price_book_id, module_key, trade_key, hours) VALUES (?, ?, ?, ?)', id, c.key, trade, num(hours, 'Hours'));
        }
      }
      return;
    }
    case 'module.delete': {
      db.run('DELETE FROM pb_options WHERE price_book_id = ? AND module_key = ?', id, c.key);
      db.run('DELETE FROM pb_module_labour WHERE price_book_id = ? AND module_key = ?', id, c.key);
      db.run('DELETE FROM pb_modules WHERE price_book_id = ? AND key = ?', id, c.key);
      return;
    }
    case 'trade.update': {
      if ('rate' in f) db.run('UPDATE pb_trades SET rate = ? WHERE price_book_id = ? AND key = ?', num(f.rate, 'Rate'), id, c.key);
      if ('name' in f) db.run('UPDATE pb_trades SET name = ? WHERE price_book_id = ? AND key = ?', text(f.name, 'Trade name', 60), id, c.key);
      return;
    }
    case 'trade.add': {
      const name = text(c.trade?.name, 'Trade name', 60);
      const key = uniqueKey(db, 'pb_trades', id, slug(name).toUpperCase().replace(/-/g, '_'));
      const max = db.get('SELECT COALESCE(MAX(sort), -1) AS s FROM pb_trades WHERE price_book_id = ?', id).s;
      db.run('INSERT INTO pb_trades (price_book_id, key, name, rate, sort) VALUES (?, ?, ?, ?, ?)', id, key, name, num(c.trade.rate || 0, 'Rate'), max + 1);
      return;
    }
    case 'tier.update': {
      if ('markup' in f) db.run('UPDATE pb_tiers SET markup = ? WHERE price_book_id = ? AND key = ?', num(f.markup, 'Markup'), id, c.key);
      if ('name' in f) db.run('UPDATE pb_tiers SET name = ? WHERE price_book_id = ? AND key = ?', text(f.name, 'Tier name', 60), id, c.key);
      if (f.isDefault) {
        db.run('UPDATE pb_tiers SET is_default = 0 WHERE price_book_id = ?', id);
        db.run('UPDATE pb_tiers SET is_default = 1 WHERE price_book_id = ? AND key = ?', id, c.key);
      }
      return;
    }
    case 'tier.add': {
      const name = text(c.tier?.name, 'Tier name', 60);
      const key = uniqueKey(db, 'pb_tiers', id, slug(name));
      const max = db.get('SELECT COALESCE(MAX(sort), -1) AS s FROM pb_tiers WHERE price_book_id = ?', id).s;
      db.run('INSERT INTO pb_tiers (price_book_id, key, name, markup, is_default, sort) VALUES (?, ?, ?, ?, 0, ?)', id, key, name, num(c.tier.markup || 0, 'Markup'), max + 1);
      return;
    }
    case 'tier.delete': {
      db.run('DELETE FROM pb_tiers WHERE price_book_id = ? AND key = ? AND is_default = 0', id, c.key);
      return;
    }
    case 'finish.update': {
      db.run('UPDATE pb_finish_groups SET name = ? WHERE price_book_id = ? AND key = ?', text(f.name, 'Finish group name', 120), id, c.key);
      return;
    }
    case 'finish.add': {
      const name = text(c.finish?.name, 'Finish group name', 120);
      const max = db.get('SELECT COUNT(*) AS n FROM pb_finish_groups WHERE price_book_id = ?', id).n;
      const key = uniqueKey(db, 'pb_finish_groups', id, `FG${String(max + 1).padStart(2, '0')}`);
      db.run('INSERT INTO pb_finish_groups (price_book_id, key, name, sort) VALUES (?, ?, ?, ?)', id, key, name, max);
      return;
    }
    case 'material.update': {
      const cols = { supplier: 'supplier', product: 'product', thickness: 'thickness', sheetSize: 'sheet_size', m2Rate: 'm2_rate', sheetRate: 'sheet_rate', note: 'note' };
      for (const [k, col] of Object.entries(cols)) {
        if (!(k in f)) continue;
        const v = (k === 'm2Rate' || k === 'sheetRate') ? (f[k] === '' || f[k] == null ? null : num(f[k], 'Rate')) : String(f[k] ?? '');
        db.run(`UPDATE pb_materials SET ${col} = ? WHERE price_book_id = ? AND id = ?`, v, id, c.id);
      }
      return;
    }
    case 'material.add': {
      const m = c.material || {};
      const max = db.get('SELECT COALESCE(MAX(sort), -1) AS s FROM pb_materials WHERE price_book_id = ?', id).s;
      db.run('INSERT INTO pb_materials (price_book_id, supplier, product, thickness, sheet_size, m2_rate, sheet_rate, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, text(m.supplier, 'Supplier'), text(m.product, 'Product'), m.thickness || null, m.sheetSize || null,
        m.m2Rate === '' || m.m2Rate == null ? null : num(m.m2Rate, 'm² rate'), m.sheetRate === '' || m.sheetRate == null ? null : num(m.sheetRate, 'Sheet rate'), m.note || null, max + 1);
      return;
    }
    case 'material.delete': {
      db.run('DELETE FROM pb_materials WHERE price_book_id = ? AND id = ?', id, c.id);
      return;
    }
    default:
      throw badRequest(`Unknown change "${c.op}".`);
  }
}

/** Starter price book for a new company that is not importing the legacy workbook. */
export function starterBook() {
  const trades = [
    { key: 'DESIGN', name: 'Design & drafting', rate: 80 }, { key: 'MACHINING', name: 'Machining', rate: 70 },
    { key: 'ASSEMBLY', name: 'Assembly', rate: 60 }, { key: 'INSTALL', name: 'Install', rate: 85 }, { key: 'DELIVERY', name: 'Delivery', rate: 90 },
  ].map((t, i) => ({ ...t, sort: i }));
  return {
    label: 'Starter price book', note: 'Example structure. Replace the rates with your own before publishing.',
    trades,
    finishGroups: [{ key: 'FG01', name: 'White melamine', sort: 0 }, { key: 'FG02', name: 'Coloured melamine', sort: 1 }, { key: 'FG03', name: 'Polyurethane', sort: 2 }],
    tiers: [{ key: 'retail', name: 'Retail', markup: 55, isDefault: true, sort: 0 }, { key: 'builder', name: 'Builder', markup: 40, isDefault: false, sort: 1 }],
    modules: [
      { key: 'base-cabinet', name: 'Base cabinet', category: 'Cabinetry', uom: 'LM', description: 'Up to 650mm deep × 900mm high.', sort: 0,
        labour: { DESIGN: 0.3, MACHINING: 0.6, ASSEMBLY: 0.8, INSTALL: 0.7, DELIVERY: 0.2 },
        options: [{ key: 'white', name: 'White melamine', finishGroups: ['FG01'], material: 140 }, { key: 'coloured', name: 'Coloured melamine', finishGroups: ['FG02'], material: 175 }, { key: 'poly', name: 'Polyurethane', finishGroups: ['FG03'], material: 290 }] },
      { key: 'wall-cabinet', name: 'Wall cabinet', category: 'Cabinetry', uom: 'LM', description: 'Up to 370mm deep.', sort: 1,
        labour: { DESIGN: 0.2, MACHINING: 0.5, ASSEMBLY: 0.6, INSTALL: 0.6, DELIVERY: 0.2 },
        options: [{ key: 'white', name: 'White melamine', finishGroups: ['FG01'], material: 150 }, { key: 'coloured', name: 'Coloured melamine', finishGroups: ['FG02'], material: 185 }, { key: 'poly', name: 'Polyurethane', finishGroups: ['FG03'], material: 300 }] },
      { key: 'drawer', name: 'Drawer', category: 'Hardware & accessories', uom: 'EA', description: '', sort: 2,
        labour: { ASSEMBLY: 0.3, INSTALL: 0.2 }, options: [{ key: 'standard', name: 'Standard soft-close', material: 0, hardware: 85 }] },
      { key: 'delivery', name: 'Delivery', category: 'Services', uom: 'JOB', description: '', sort: 3,
        labour: { DELIVERY: 3 }, options: [{ key: 'local', name: 'Local', material: 0 }] },
    ],
    materials: [],
  };
}

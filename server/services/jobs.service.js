// Jobs are the platform's "documents": New, Open, Save (optimistic concurrency), Save As, Export/Import.
// The server always re-prices with the job's pinned price book version and stores per-line snapshots.
import { badRequest, conflict, forbidden, notFound } from '../http/http.js';
import { CUSTOM_MODULE, OVERRIDE_TYPES, priceJob, round2 } from '../../shared/pricing.js';
import { audit } from './audit.service.js';
import { currentPublished, loadBook, publishBook, publishImpact } from './pricebook.service.js';
import { companySettings, listTemplates } from './account.service.js';
import { CLOSED_STATUSES, checkStatusDetail, statusLabel } from './statuses.service.js';

export const JOB_STATUSES = ['enquiry', 'quoting', 'quoted', 'won', 'in_production', 'installing', 'complete', 'lost'];
export const AREA_QUOTE_LABELS = ['provisional'];
export const LOCKED_STATUSES = ['won', 'in_production', 'installing', 'complete'];
export const AREA_TYPES = ['kitchen', 'butlers', 'wardrobe', 'linen', 'laundry', 'vanity', 'alfresco', 'study', 'entertainment', 'services', 'other'];
const now = () => new Date().toISOString();
const isManager = (u) => u.role === 'owner' || u.role === 'admin';

export function pricingSettings(company) {
  return { gstRate: company.gst_rate, floorMargin: company.floor_margin };
}

function jobRow(db, companyId, id) {
  const j = db.get('SELECT * FROM jobs WHERE id = ? AND company_id = ?', id, companyId);
  if (!j) throw notFound('Job not found.');
  return j;
}

export function listJobs(db, companyId, { q = '', status = '', archived = false } = {}) {
  const where = ['j.company_id = ?', archived ? 'j.archived_at IS NOT NULL' : 'j.archived_at IS NULL'];
  const params = [companyId];
  if (status) { where.push('j.status = ?'); params.push(status); }
  if (q) {
    where.push('(j.job_number LIKE ? OR j.name LIKE ? OR j.client_name LIKE ? OR j.site_address LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  return db.all(`SELECT j.id, j.job_number, j.name, j.client_name, j.site_address, j.status, j.status_detail, j.tier_key, j.total_cost, j.total_sell, j.total_hours,
                        j.updated_at, j.created_at, j.price_book_id, p.label AS price_book_label, d.name AS designer_name, ub.name AS updated_by_name,
                        (SELECT COUNT(*) FROM job_areas a WHERE a.job_id = j.id) AS area_count,
                        (SELECT MAX(rev) FROM quotes q WHERE q.job_id = j.id) AS quote_rev
                 FROM jobs j
                 JOIN price_books p ON p.id = j.price_book_id
                 LEFT JOIN users d ON d.id = j.designer_id
                 LEFT JOIN users ub ON ub.id = j.updated_by
                 WHERE ${where.join(' AND ')} ORDER BY j.updated_at DESC LIMIT 500`, ...params);
}

/** Load the full job document as the editor uses it. */
export function getJobDoc(db, companyId, id) {
  const j = jobRow(db, companyId, id);
  const areas = db.all('SELECT * FROM job_areas WHERE job_id = ? ORDER BY sort, id', id);
  const lines = db.all(`SELECT l.*, ub.name AS override_by_name, ab.name AS approved_by_name FROM job_lines l
                        LEFT JOIN users ub ON ub.id = l.override_by LEFT JOIN users ab ON ab.id = l.override_approved_by
                        WHERE l.job_id = ? ORDER BY l.sort, l.id`, id);
  const names = db.get(`SELECT p.label AS book_label, p.status AS book_status, d.name AS designer_name, ub.name AS updated_by_name, da.name AS discount_approved_by_name
                        FROM jobs j JOIN price_books p ON p.id = j.price_book_id LEFT JOIN users d ON d.id = j.designer_id
                        LEFT JOIN users ub ON ub.id = j.updated_by LEFT JOIN users da ON da.id = j.discount_approved_by WHERE j.id = ?`, id);
  return {
    id: j.id, jobNumber: j.job_number, name: j.name, clientName: j.client_name || '', clientEmail: j.client_email || '', clientPhone: j.client_phone || '',
    siteAddress: j.site_address || '', builderName: j.builder_name || '', contactDetails: j.contact_details || '', quoteBasis: j.quote_basis || '',
    status: j.status, statusDetail: j.status_detail || null, tierKey: j.tier_key, priceBookId: j.price_book_id, priceBookLabel: names.book_label,
    designerId: j.designer_id, designerName: names.designer_name || '', notes: j.notes || '', revision: j.revision,
    adjustments: { discountPct: j.discount_pct, discountReason: j.discount_reason || '', discountApprovedBy: j.discount_approved_by, discountApprovedByName: names.discount_approved_by_name || '' },
    createdAt: j.created_at, updatedAt: j.updated_at, updatedByName: names.updated_by_name || '', archivedAt: j.archived_at,
    locked: LOCKED_STATUSES.includes(j.status),
    areas: areas.map((a) => ({
      id: a.id, name: a.name, type: a.area_type, defaultFinish: a.default_finish || '', optional: !!a.optional, notes: a.notes || '',
      quoteLabel: a.quote_label || '',
      lines: lines.filter((l) => l.area_id === a.id).map(lineToDoc),
    })),
  };
}

function lineToDoc(l) {
  return {
    id: l.id, moduleKey: l.module_key, optionKey: l.option_key || null, qty: l.qty, description: l.description || '',
    custom: l.module_key === CUSTOM_MODULE ? { unitCost: l.custom_unit_cost ?? 0, uom: l.custom_uom || 'EA' } : null,
    override: l.override_type ? {
      type: l.override_type, value: l.override_value, reason: l.override_reason || '',
      by: l.override_by, byName: l.override_by_name || '', approvedBy: l.override_approved_by, approvedByName: l.approved_by_name || '',
    } : null,
  };
}

export function newerBookFor(db, companyId, job) {
  const cur = currentPublished(db, companyId);
  if (!cur || cur.id === job.priceBookId) return null;
  const row = db.get('SELECT id, label, published_at FROM price_books WHERE id = ?', cur.id);
  const mine = db.get('SELECT published_at FROM price_books WHERE id = ?', job.priceBookId);
  if (mine && mine.published_at && row.published_at < mine.published_at) return null;
  return { id: row.id, label: row.label };
}

/** Job document + server pricing, as returned to the editor. */
export function jobPayload(db, company, id) {
  const doc = getJobDoc(db, company.id, id);
  const book = loadBook(db, company.id, doc.priceBookId);
  return { job: doc, pricing: priceJob(doc, book, pricingSettings(company)), newerBook: newerBookFor(db, company.id, doc) };
}

// ---------------- validation ----------------

function cleanStr(v, max = 500) { return String(v ?? '').trim().slice(0, max); }

function normaliseDoc(doc) {
  if (!doc || typeof doc !== 'object') throw badRequest('Job data is missing.');
  const name = cleanStr(doc.name, 160);
  if (!name) throw badRequest('Give the job a name.');
  if (doc.status && !JOB_STATUSES.includes(doc.status)) throw badRequest('Unknown job status.');
  const areas = Array.isArray(doc.areas) ? doc.areas : [];
  if (areas.length > 500) throw badRequest('Too many areas.');
  return {
    ...doc, name,
    clientName: cleanStr(doc.clientName, 160), clientEmail: cleanStr(doc.clientEmail, 160), clientPhone: cleanStr(doc.clientPhone, 60),
    siteAddress: cleanStr(doc.siteAddress, 300), notes: cleanStr(doc.notes, 5000),
    builderName: cleanStr(doc.builderName, 160), contactDetails: cleanStr(doc.contactDetails, 200), quoteBasis: cleanStr(doc.quoteBasis, 1000),
    statusDetail: cleanStr(doc.statusDetail, 80) || null, reopenReason: cleanStr(doc.reopenReason, 500),
    adjustments: {
      discountPct: Math.max(0, Math.min(100, Number(doc.adjustments?.discountPct) || 0)),
      discountReason: cleanStr(doc.adjustments?.discountReason, 300),
      approve: !!doc.adjustments?.approve,
    },
    areas: areas.map((a, ai) => {
      const lines = Array.isArray(a.lines) ? a.lines : [];
      if (lines.length > 2000) throw badRequest('Too many lines in one area.');
      return {
        id: a.id, name: cleanStr(a.name, 120) || `Area ${ai + 1}`, type: AREA_TYPES.includes(a.type) ? a.type : 'other',
        defaultFinish: cleanStr(a.defaultFinish, 40) || null, optional: !!a.optional, notes: cleanStr(a.notes, 10000),
        quoteLabel: AREA_QUOTE_LABELS.includes(a.quoteLabel) ? a.quoteLabel : '',
        lines: lines.map((l) => {
          const qty = Number(l.qty);
          if (!Number.isFinite(qty)) throw badRequest('Quantities must be numbers.');
          const ov = l.override && l.override.type ? l.override : null;
          if (ov && !OVERRIDE_TYPES[ov.type]) throw badRequest('Unknown override type.');
          if (ov && !Number.isFinite(Number(ov.value))) throw badRequest('Override value must be a number.');
          return {
            id: l.id, moduleKey: cleanStr(l.moduleKey, 80), optionKey: cleanStr(l.optionKey, 80) || null, qty,
            description: cleanStr(l.description, 500),
            custom: l.moduleKey === CUSTOM_MODULE ? { unitCost: Math.max(0, Number(l.custom?.unitCost) || 0), uom: cleanStr(l.custom?.uom, 6) || 'EA' } : null,
            override: ov ? { type: ov.type, value: Number(ov.value), reason: cleanStr(ov.reason, 300), approve: !!ov.approve } : null,
          };
        }),
      };
    }),
  };
}

const areasSignature = (areas) => JSON.stringify(areas.map((a) => ({
  n: a.name, o: !!a.optional, f: a.defaultFinish || null,
  l: a.lines.map((l) => [l.moduleKey, l.optionKey || null, Number(l.qty), l.description || '', l.custom ? Number(l.custom.unitCost) : null, l.override ? [l.override.type, Number(l.override.value)] : null]),
})));

// ---------------- persistence ----------------

function nextJobNumber(db, company) {
  const year = new Date().getFullYear();
  const prefix = `${company.job_prefix}-${year}-`;
  const last = db.get('SELECT job_number FROM jobs WHERE company_id = ? AND job_number LIKE ? ORDER BY job_number DESC LIMIT 1', company.id, `${prefix}%`);
  const n = last ? Number(last.job_number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** Write areas/lines (upsert by id so cost entries keep their area links) and snapshot prices. */
function writeAreas(db, jobId, areas, pricing, actor, existingLines) {
  const keepAreaIds = [];
  const keepLineIds = [];
  const existingAreaIds = new Set(db.all('SELECT id FROM job_areas WHERE job_id = ?', jobId).map((r) => r.id));
  areas.forEach((a, ai) => {
    let areaId = Number(a.id);
    if (Number.isInteger(areaId) && existingAreaIds.has(areaId)) {
      db.run('UPDATE job_areas SET name = ?, area_type = ?, default_finish = ?, optional = ?, notes = ?, quote_label = ?, sort = ? WHERE id = ?',
        a.name, a.type, a.defaultFinish, a.optional ? 1 : 0, a.notes || null, a.quoteLabel || null, ai, areaId);
    } else {
      areaId = Number(db.run('INSERT INTO job_areas (job_id, name, area_type, default_finish, optional, notes, quote_label, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        jobId, a.name, a.type, a.defaultFinish, a.optional ? 1 : 0, a.notes || null, a.quoteLabel || null, ai).lastInsertRowid);
    }
    keepAreaIds.push(areaId);
    const priced = pricing.areas[ai];
    a.lines.forEach((l, li) => {
      const r = priced.lines[li];
      const prev = existingLines.get(Number(l.id));
      const ov = l.override;
      let overrideBy = null, approvedBy = null;
      if (ov) {
        const same = prev && prev.override_type === ov.type && Number(prev.override_value) === ov.value && (prev.override_reason || '') === ov.reason;
        overrideBy = same ? prev.override_by : actor.id;
        if (isManager(actor) && (!same || ov.approve)) approvedBy = actor.id;
        else if (same) approvedBy = prev.override_approved_by;
      }
      const snap = JSON.stringify({ unitMaterial: r.unitMaterial, unitHardware: r.unitHardware, unitLabour: r.unitLabour, hoursPerUnit: r.hoursPerUnit, optionKey: r.optionKey, markup: r.markup });
      const vals = [areaId, l.moduleKey, l.optionKey, l.qty, l.description || null, l.custom ? l.custom.unitCost : null, l.custom ? l.custom.uom : null,
        ov ? ov.type : null, ov ? ov.value : null, ov ? ov.reason : null, overrideBy, approvedBy, li,
        r.unitCost, r.unitSell, r.lineCost, r.lineSell, snap];
      if (prev && prev.job_id === jobId) {
        db.run(`UPDATE job_lines SET area_id = ?, module_key = ?, option_key = ?, qty = ?, description = ?, custom_unit_cost = ?, custom_uom = ?,
                override_type = ?, override_value = ?, override_reason = ?, override_by = ?, override_approved_by = ?, sort = ?,
                snap_unit_cost = ?, snap_unit_sell = ?, snap_line_cost = ?, snap_line_sell = ?, snap_json = ? WHERE id = ?`, ...vals, prev.id);
        keepLineIds.push(prev.id);
      } else {
        const id = Number(db.run(`INSERT INTO job_lines (area_id, module_key, option_key, qty, description, custom_unit_cost, custom_uom,
                override_type, override_value, override_reason, override_by, override_approved_by, sort,
                snap_unit_cost, snap_unit_sell, snap_line_cost, snap_line_sell, snap_json, job_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, jobId).lastInsertRowid);
        keepLineIds.push(id);
      }
    });
  });
  const lineIn = keepLineIds.length ? keepLineIds.join(',') : '0';
  const areaIn = keepAreaIds.length ? keepAreaIds.join(',') : '0';
  db.run(`DELETE FROM job_lines WHERE job_id = ? AND id NOT IN (${lineIn})`, jobId);
  db.run(`DELETE FROM job_areas WHERE job_id = ? AND id NOT IN (${areaIn})`, jobId);
}

function priceForSave(db, company, bookId, doc) {
  const book = loadBook(db, company.id, bookId);
  const tierKey = book.tiers.some((t) => t.key === doc.tierKey) ? doc.tierKey : (book.tiers.find((t) => t.isDefault) || book.tiers[0]).key;
  const pricing = priceJob({ ...doc, tierKey }, book, pricingSettings(company));
  return { book, tierKey, pricing };
}

export function createJob(db, actor, company, body) {
  const raw = { areas: [], ...body };
  if (!raw.areas.length && Array.isArray(body.templateIds) && body.templateIds.length) {
    const templates = listTemplates(db, company.id);
    raw.areas = body.templateIds.map((tid) => templates.find((x) => x.id === Number(tid))).filter(Boolean)
      .map((t) => ({ name: t.name.replace(/ – standard$/i, ''), type: t.areaType, defaultFinish: t.defaultFinish, lines: t.lines }));
  }
  if (!raw.areas.length) raw.areas = [{ name: 'Kitchen', type: 'kitchen', lines: [] }];
  const doc = normaliseDoc(raw);
  const cur = body.priceBookId ? { id: Number(body.priceBookId) } : currentPublished(db, company.id);
  if (!cur) throw conflict('Publish a price book before creating jobs.');
  const bookRow = db.get("SELECT status FROM price_books WHERE id = ? AND company_id = ?", cur.id, company.id);
  if (!bookRow || bookRow.status === 'draft') throw badRequest('Jobs must use a published price book.');
  return db.tx(() => {
    const { tierKey, pricing } = priceForSave(db, company, cur.id, doc);
    const ts = now();
    const jobNumber = nextJobNumber(db, company);
    const id = Number(db.run(`INSERT INTO jobs (company_id, job_number, name, client_name, client_email, client_phone, site_address, status, tier_key, price_book_id,
                              designer_id, notes, discount_pct, discount_reason, total_cost, total_sell, total_hours, created_by, created_at, updated_by, updated_at,
                              builder_name, contact_details, quote_basis)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      company.id, jobNumber, doc.name, doc.clientName, doc.clientEmail, doc.clientPhone, doc.siteAddress, doc.status || 'quoting', tierKey, cur.id,
      actor.id, doc.notes, doc.adjustments.discountPct, doc.adjustments.discountReason, pricing.totals.cost, pricing.totals.sell, pricing.totals.hoursTotal,
      actor.id, ts, actor.id, ts, doc.builderName || null, doc.contactDetails || null, doc.quoteBasis || null).lastInsertRowid);
    writeAreas(db, id, doc.areas, pricing, actor, new Map());
    audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: id, action: body.__action || 'create', detail: { jobNumber, from: body.__from } });
    return id;
  });
}

export function saveJob(db, actor, company, id, body) {
  const existing = jobRow(db, company.id, id);
  if (existing.archived_at) throw conflict('This job is archived. Restore it before editing.');
  const doc = normaliseDoc(body);
  if (Number(body.revision) !== existing.revision) {
    const by = db.get('SELECT name FROM users WHERE id = ?', existing.updated_by);
    throw conflict(`This job was saved by ${by ? by.name : 'someone else'} at ${new Date(existing.updated_at).toLocaleString('en-AU')} after you opened it. Use Save As to keep your version as a new job, or reopen the job.`, { reason: 'revision' });
  }
  const current = getJobDoc(db, company.id, id);
  if (LOCKED_STATUSES.includes(existing.status) && areasSignature(current.areas) !== areasSignature(doc.areas)) {
    throw conflict('This job\'s status is Won or later, so its areas and prices are locked. Use Save As to price a variation as a new job, or change the status back first.');
  }
  const newStatus = doc.status || existing.status;
  const newDetail = checkStatusDetail(db, company.id, newStatus, doc.statusDetail, existing.status_detail);
  // Reopening a closed (Complete or Missed) job needs a reason, recorded in the job's history.
  const reopening = CLOSED_STATUSES.includes(existing.status) && !CLOSED_STATUSES.includes(newStatus);
  if (reopening && !doc.reopenReason) throw badRequest('Enter the reason for reopening this job.', { field: 'reopenReason' });
  return db.tx(() => {
    const { tierKey, pricing, book } = priceForSave(db, company, existing.price_book_id, doc);
    const existingLines = new Map(db.all('SELECT * FROM job_lines WHERE job_id = ?', id).map((l) => [l.id, l]));
    const discountChanged = Number(existing.discount_pct) !== doc.adjustments.discountPct || (existing.discount_reason || '') !== doc.adjustments.discountReason;
    let discountApprovedBy = discountChanged ? null : existing.discount_approved_by;
    if (doc.adjustments.discountPct && isManager(actor) && (discountChanged || doc.adjustments.approve)) discountApprovedBy = actor.id;
    if (!doc.adjustments.discountPct) discountApprovedBy = null;
    db.run(`UPDATE jobs SET name = ?, client_name = ?, client_email = ?, client_phone = ?, site_address = ?, status = ?, tier_key = ?, notes = ?,
            discount_pct = ?, discount_reason = ?, discount_approved_by = ?, total_cost = ?, total_sell = ?, total_hours = ?,
            builder_name = ?, contact_details = ?, quote_basis = ?, status_detail = ?,
            revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
      doc.name, doc.clientName, doc.clientEmail, doc.clientPhone, doc.siteAddress, newStatus, tierKey, doc.notes,
      doc.adjustments.discountPct, doc.adjustments.discountReason, discountApprovedBy, pricing.totals.cost, pricing.totals.sell, pricing.totals.hoursTotal,
      doc.builderName || null, doc.contactDetails || null, doc.quoteBasis || null, newDetail,
      actor.id, now(), id);
    const areasWritten = !LOCKED_STATUSES.includes(existing.status);
    if (areasWritten) writeAreas(db, id, doc.areas, pricing, actor, existingLines);
    const label = (s, d) => statusLabel(db, company.id, s, d);
    const fromLabel = label(existing.status, existing.status_detail), toLabel = label(newStatus, newDetail);
    const changes = diffJob(current, { ...doc, tierKey, areas: areasWritten ? doc.areas : current.areas }, book,
      { from: fromLabel, to: toLabel, changed: newStatus !== existing.status || newDetail !== (existing.status_detail || null) });
    audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: id, action: 'save',
      detail: { revision: existing.revision + 1, sell: pricing.totals.sell, status: newStatus !== existing.status ? `${existing.status} → ${newStatus}` : undefined, changes } });
    if (reopening) {
      audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: id, action: 'job_reopened',
        detail: { from: existing.status, to: newStatus, fromLabel, toLabel, reason: doc.reopenReason } });
    }
    return id;
  });
}

// ---------------- change history ----------------

const JOB_FIELDS = [['name', 'Job name'], ['clientName', 'Client name'], ['clientEmail', 'Client email'], ['clientPhone', 'Client phone'], ['siteAddress', 'Site address'],
  ['builderName', 'Builder'], ['contactDetails', 'Contact'], ['quoteBasis', 'Quote based on'], ['notes', 'Internal notes']];
const short = (v) => { const s = v == null ? '' : String(v); return s.length > 300 ? `${s.slice(0, 297)}…` : s; };
const OVERRIDE_TEXT = (o) => (o ? `${OVERRIDE_TYPES[o.type] || o.type} ${o.value}${o.reason ? ` (${o.reason})` : ''}` : '');

/**
 * What changed between the saved job and the new version, for the job's History: fields, areas and items, each with
 * the previous and new value. Lines are matched by id, so edits, additions, deletions and moves are told apart.
 */
export function diffJob(before, after, book, status) {
  const out = [];
  const push = (c) => out.push(c);
  const field = (label, from, to, extra = {}) => { if (short(from) !== short(to)) push({ kind: 'field', field: label, from: short(from), to: short(to), ...extra }); };
  for (const [k, label] of JOB_FIELDS) field(label, before[k] || '', after[k] || '');
  if (status.changed) push({ kind: 'field', field: 'Status', from: status.from, to: status.to });
  const tierName = (k) => book.tiers.find((t) => t.key === k)?.name || k;
  if (before.tierKey !== after.tierKey) field('Price tier', tierName(before.tierKey), tierName(after.tierKey));
  field('Discount %', before.adjustments?.discountPct || 0, after.adjustments?.discountPct || 0);
  field('Discount reason', before.adjustments?.discountReason || '', after.adjustments?.discountReason || '');

  const mods = new Map(book.modules.map((m) => [m.key, m]));
  const finish = (k) => (k ? book.finishGroups.find((f) => f.key === k)?.name || k : 'None');
  const itemName = (l) => {
    if (l.moduleKey === CUSTOM_MODULE) return l.description || 'Custom item';
    const m = mods.get(l.moduleKey);
    if (!m) return l.moduleKey;
    const o = l.optionKey ? m.options.find((x) => x.key === l.optionKey) : null;
    return o ? (o.fullName ? o.name : `${m.name} – ${o.name}`) : m.name;
  };
  const optName = (l) => {
    const o = l.optionKey ? mods.get(l.moduleKey)?.options.find((x) => x.key === l.optionKey) : null;
    return o ? o.name : 'Area finish';
  };
  const beforeAreas = new Map(before.areas.map((a) => [Number(a.id), a]));
  const beforeLines = new Map(before.areas.flatMap((a) => a.lines.map((l) => [Number(l.id), { l, area: a }])));
  const seenAreas = new Set(), seenLines = new Set();
  for (const a of after.areas) {
    const old = beforeAreas.get(Number(a.id));
    if (!old) push({ kind: 'area', action: 'added', area: a.name, to: `${a.lines.length} item${a.lines.length === 1 ? '' : 's'}` });
    else {
      seenAreas.add(old.id);
      const af = (label, from, to) => field(label, from, to, { kind: 'area', area: a.name });
      af('Area name', old.name, a.name);
      af('Area type', old.type, a.type);
      af('Area finish', finish(old.defaultFinish), finish(a.defaultFinish));
      af('Optional (not in total)', old.optional ? 'Yes' : 'No', a.optional ? 'Yes' : 'No');
      af('Provisional sum', old.quoteLabel === 'provisional' ? 'Yes' : 'No', a.quoteLabel === 'provisional' ? 'Yes' : 'No');
      af('Area notes', old.notes || '', a.notes || '');
    }
    for (const l of a.lines) {
      const prev = beforeLines.get(Number(l.id));
      if (!prev) { push({ kind: 'item', action: 'added', area: a.name, item: itemName(l), to: `qty ${l.qty}` }); continue; }
      seenLines.add(prev.l.id);
      const p = prev.l;
      const it = (label, from, to) => field(label, from, to, { kind: 'item', area: a.name, item: itemName(l) });
      if (Number(prev.area.id) !== Number(a.id)) it('Moved to area', prev.area.name, a.name);
      it('Quantity', p.qty, l.qty);
      if ((p.optionKey || null) !== (l.optionKey || null)) it('Finish / option', optName(p), optName(l));
      if (l.moduleKey !== CUSTOM_MODULE) it('Quote wording', p.description || '(standard)', l.description || '(standard)');
      else {
        it('Description', p.description, l.description);
        it('Unit cost', p.custom?.unitCost ?? 0, l.custom?.unitCost ?? 0);
        it('Unit', p.custom?.uom || 'EA', l.custom?.uom || 'EA');
      }
      it('Price override', OVERRIDE_TEXT(p.override) || 'None', OVERRIDE_TEXT(l.override) || 'None');
    }
  }
  for (const [aid, a] of beforeAreas) if (!seenAreas.has(aid)) push({ kind: 'area', action: 'removed', area: a.name, from: `${a.lines.length} item${a.lines.length === 1 ? '' : 's'}` });
  // Items of a deleted area are covered by the area entry; items deleted from a kept area are listed one by one.
  for (const [lid, { l, area }] of beforeLines) {
    if (!seenLines.has(lid) && seenAreas.has(area.id)) push({ kind: 'item', action: 'removed', area: area.name, item: itemName(l), from: `qty ${l.qty}` });
  }
  return out.length > 200 ? [...out.slice(0, 200), { kind: 'more', count: out.length - 200 }] : out;
}

/** Save As: copy the (possibly unsaved) document into a new job. */
export function saveJobAs(db, actor, company, sourceId, body) {
  const src = jobRow(db, company.id, sourceId);
  const doc = normaliseDoc(body.doc || {});
  const fresh = {
    ...doc,
    name: cleanStr(body.name, 160) || `${doc.name} (copy)`,
    clientName: body.clientName != null ? cleanStr(body.clientName, 160) : doc.clientName,
    status: 'quoting', statusDetail: null, reopenReason: '',
    priceBookId: body.useLatestPrices ? undefined : src.price_book_id,
    areas: doc.areas.map((a) => ({ ...a, id: undefined, lines: a.lines.map((l) => ({ ...l, id: undefined, override: l.override ? { ...l.override, approve: false } : null })) })),
    __action: 'save_as', __from: src.job_number,
  };
  return createJob(db, actor, company, fresh);
}

export function setArchived(db, actor, company, id, archived) {
  if (!isManager(actor)) throw forbidden('Only owners and admins can archive jobs.');
  jobRow(db, company.id, id);
  db.run('UPDATE jobs SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', archived ? now() : null, now(), actor.id, id);
  audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: id, action: archived ? 'archive' : 'restore' });
}

// ---------------- job files ----------------

export const JOB_FILE_FORMAT = 'joinery-pricing-job';

export function exportJob(db, actor, company, id) {
  const doc = getJobDoc(db, company.id, id);
  audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: id, action: 'export' });
  return {
    format: JOB_FILE_FORMAT, formatVersion: 1, exportedAt: now(), exportedBy: actor.name,
    source: { company: company.name, priceBook: { id: doc.priceBookId, label: doc.priceBookLabel } },
    job: {
      jobNumber: doc.jobNumber, name: doc.name, clientName: doc.clientName, clientEmail: doc.clientEmail, clientPhone: doc.clientPhone,
      siteAddress: doc.siteAddress, builderName: doc.builderName, contactDetails: doc.contactDetails, quoteBasis: doc.quoteBasis,
      tierKey: doc.tierKey, notes: doc.notes, adjustments: { discountPct: doc.adjustments.discountPct, discountReason: doc.adjustments.discountReason },
      areas: doc.areas.map((a) => ({ name: a.name, type: a.type, defaultFinish: a.defaultFinish, optional: a.optional, notes: a.notes, quoteLabel: a.quoteLabel,
        lines: a.lines.map((l) => ({ moduleKey: l.moduleKey, optionKey: l.optionKey, qty: l.qty, description: l.description, custom: l.custom,
          override: l.override ? { type: l.override.type, value: l.override.value, reason: l.override.reason } : null })) })),
    },
  };
}

export function importJob(db, actor, company, file) {
  if (!file || file.format !== JOB_FILE_FORMAT || !file.job) throw badRequest('This is not a job file exported from this program.');
  const cur = currentPublished(db, company.id);
  if (!cur) throw conflict('Publish a price book before importing jobs.');
  const book = loadBook(db, company.id, cur.id);
  const known = new Set(book.modules.map((m) => m.key));
  const missing = new Set();
  for (const a of file.job.areas || []) for (const l of a.lines || []) if (l.moduleKey !== CUSTOM_MODULE && !known.has(l.moduleKey)) missing.add(l.moduleKey);
  const id = createJob(db, actor, company, {
    ...file.job, name: `${file.job.name || 'Imported job'}`, status: 'quoting',
    notes: [file.job.notes, `Imported from ${file.source?.company || 'job file'} (${file.job.jobNumber || 'no number'}) on ${new Date().toLocaleDateString('en-AU')}. Repriced with ${book.label}.`].filter(Boolean).join('\n\n'),
    __action: 'import', __from: file.job.jobNumber,
  });
  return { id, missingModules: [...missing] };
}

// ---------------- repricing ----------------

export function repricePreview(db, company, id, toBookId) {
  const doc = getJobDoc(db, company.id, id);
  const settings = pricingSettings(company);
  const from = priceJob(doc, loadBook(db, company.id, doc.priceBookId), settings);
  const toBook = loadBook(db, company.id, toBookId);
  if (toBook.status !== 'published') throw badRequest('Jobs can only move to a published price book.');
  const to = priceJob(doc, toBook, settings);
  const lines = [];
  doc.areas.forEach((a, ai) => a.lines.forEach((l, li) => {
    const f = from.areas[ai].lines[li], t = to.areas[ai].lines[li];
    if (round2(f.lineSell) !== round2(t.lineSell) || round2(f.lineCost) !== round2(t.lineCost)) {
      lines.push({ area: a.name, description: f.description || t.description, qty: l.qty, fromSell: f.lineSell, toSell: t.lineSell, fromCost: f.lineCost, toCost: t.lineCost });
    }
  }));
  return { from: { id: doc.priceBookId, label: doc.priceBookLabel, totals: from.totals }, to: { id: toBook.id, label: toBook.label, totals: to.totals }, lines, warnings: to.warnings.filter((w) => w.level === 'error') };
}

export function applyReprice(db, actor, company, id, toBookId, revision, { via } = {}) {
  const j = jobRow(db, company.id, id);
  if (!['enquiry', 'quoting', 'quoted'].includes(j.status)) throw conflict('Only jobs that have not been accepted can be repriced.');
  if (Number(revision) !== j.revision) throw conflict('Save or reopen the job before repricing.');
  const toBook = loadBook(db, company.id, toBookId);
  if (toBook.status !== 'published') throw badRequest('Jobs can only move to a published price book.');
  db.tx(() => {
    db.run('UPDATE jobs SET price_book_id = ? WHERE id = ?', toBookId, id);
    const doc = getJobDoc(db, company.id, id);
    saveJob(db, actor, company, id, { ...doc, revision: j.revision });
    const fromLabel = db.get('SELECT label FROM price_books WHERE id = ?', j.price_book_id)?.label;
    audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: id, action: 'reprice',
      detail: { from: j.price_book_id, to: toBookId, via, fromLabel, toLabel: toBook.label, sellBefore: j.total_sell, sellAfter: jobRow(db, company.id, id).total_sell } });
  });
}

/**
 * Publish a price book and move ONLY the chosen open jobs onto it (manual control). Jobs not chosen keep their
 * current price book and prices. Nothing is applied automatically. Recorded in the activity log: who, when, which
 * version, jobs updated and jobs left unchanged.
 */
export function publishAndApply(db, actor, company, bookId, { effectiveFrom, applyToJobIds = [] } = {}) {
  const chosen = new Set((Array.isArray(applyToJobIds) ? applyToJobIds : []).map(Number));
  const open = publishImpact(db, company.id, bookId, pricingSettings(company)); // open jobs on other price books
  const openIds = new Set(open.map((j) => j.id));
  const notOpen = [...chosen].filter((jid) => !openIds.has(jid));
  if (notOpen.length) throw badRequest('Only open jobs (enquiry, quoting or quoted) on an older price book can be updated. Refresh and try again.');
  return db.tx(() => {
    const book = publishBook(db, company.id, bookId, { userId: actor.id, effectiveFrom });
    const applied = [], kept = [];
    for (const j of open) {
      if (chosen.has(j.id)) {
        applyReprice(db, actor, company, j.id, bookId, jobRow(db, company.id, j.id).revision, { via: `published "${book.label}"` });
        applied.push({ id: j.id, jobNumber: j.jobNumber, name: j.name, before: j.before, after: jobRow(db, company.id, j.id).total_sell });
      } else {
        kept.push({ id: j.id, jobNumber: j.jobNumber, name: j.name, sell: j.before });
        audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: j.id, action: 'reprice_kept', detail: { book: book.label, bookId } });
      }
    }
    audit(db, { companyId: company.id, userId: actor.id, entity: 'price_book', entityId: bookId, action: 'apply_new_prices',
      detail: { label: book.label, effectiveFrom: book.effectiveFrom, applied: applied.map((x) => x.jobNumber), kept: kept.map((x) => x.jobNumber) } });
    return { book, applied, kept };
  });
}

// ---------------- costs (budget vs actual) ----------------

export const COST_CODES = { MATERIAL: 'Board & materials', HARDWARE: 'Hardware', SUBCONTRACT: 'Subcontract', DELIVERY: 'Delivery & freight', OTHER: 'Other' };

export function listCosts(db, companyId, jobId) {
  jobRow(db, companyId, jobId);
  return db.all(`SELECT c.*, a.name AS area_name, u.name AS created_by_name FROM job_costs c
                 LEFT JOIN job_areas a ON a.id = c.area_id LEFT JOIN users u ON u.id = c.created_by
                 WHERE c.job_id = ? ORDER BY c.incurred_on DESC, c.id DESC`, jobId);
}

export function addCost(db, actor, company, jobId, body) {
  jobRow(db, company.id, jobId);
  const code = String(body.costCode || '');
  if (!code) throw badRequest('Choose a cost code.');
  const description = cleanStr(body.description, 300);
  if (!description) throw badRequest('Enter a description.');
  const amount = Number(body.amount) || 0;
  const hours = Number(body.hours) || 0;
  if (amount < 0 || hours < 0) throw badRequest('Amounts and hours cannot be negative.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.incurredOn || '') ? body.incurredOn : now().slice(0, 10);
  const areaId = body.areaId ? Number(body.areaId) : null;
  if (areaId && !db.get('SELECT 1 FROM job_areas WHERE id = ? AND job_id = ?', areaId, jobId)) throw badRequest('Unknown area.');
  const id = Number(db.run(`INSERT INTO job_costs (job_id, area_id, cost_code, description, supplier, amount, hours, incurred_on, created_by, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, jobId, areaId, code, description, cleanStr(body.supplier, 120) || null, round2(amount), hours, date, actor.id, now()).lastInsertRowid);
  audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: jobId, action: 'cost_add', detail: { code, amount, hours, description } });
  return id;
}

export function deleteCost(db, actor, company, jobId, costId) {
  jobRow(db, company.id, jobId);
  const c = db.get('SELECT * FROM job_costs WHERE id = ? AND job_id = ?', costId, jobId);
  db.run('DELETE FROM job_costs WHERE id = ? AND job_id = ?', costId, jobId);
  audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: jobId, action: 'cost_delete',
    detail: { costId, code: c?.cost_code, description: c?.description, amount: c?.amount, hours: c?.hours, incurredOn: c?.incurred_on } });
}

/** Budget by cost code from the accepted quote (or current pricing), with actuals alongside. */
export function budgetVsActual(db, company, jobId) {
  const accepted = db.get("SELECT * FROM quotes WHERE job_id = ? AND status = 'accepted' ORDER BY rev DESC LIMIT 1", jobId);
  let pricing, book, basis;
  const doc = getJobDoc(db, company.id, jobId);
  if (accepted) {
    const snap = JSON.parse(accepted.snapshot);
    pricing = snap.pricing;
    book = loadBook(db, company.id, accepted.price_book_id);
    basis = `Accepted quote rev ${accepted.rev}`;
  } else {
    book = loadBook(db, company.id, doc.priceBookId);
    pricing = priceJob(doc, book, pricingSettings(company));
    basis = 'Current job pricing (no accepted quote yet)';
  }
  const trades = new Map(book.trades.map((t) => [t.key, t]));
  const budget = {};
  const add = (code, amount, hours = 0) => { budget[code] = budget[code] || { amount: 0, hours: 0 }; budget[code].amount += amount; budget[code].hours += hours; };
  for (const a of pricing.areas) {
    if (a.optional) continue;
    for (const l of a.lines) {
      if (!l.qty) continue;
      if (l.moduleKey === CUSTOM_MODULE) { add('OTHER', l.lineCost); continue; }
      add('MATERIAL', l.unitMaterial * l.qty);
      add('HARDWARE', l.unitHardware * l.qty);
      // Labour dollars per trade as priced (older snapshots without them fall back to hours x rate).
      const byTrade = l.unitLabourByTrade || {};
      for (const t of new Set([...Object.keys(l.hours), ...Object.keys(byTrade)])) {
        const h = l.hours[t] || 0;
        add(`LAB:${t}`, t in byTrade ? byTrade[t] * l.qty : h * (trades.get(t)?.rate || 0), h);
      }
    }
  }
  const actual = {};
  for (const c of db.all('SELECT cost_code, SUM(amount) AS amount, SUM(hours) AS hours FROM job_costs WHERE job_id = ? GROUP BY cost_code', jobId)) actual[c.cost_code] = c;
  const codes = new Set([...Object.keys(budget), ...Object.keys(actual)]);
  const rows = [...codes].map((code) => {
    const b = budget[code] || { amount: 0, hours: 0 };
    const a = actual[code] || { amount: 0, hours: 0 };
    const label = code.startsWith('LAB:') ? `Labour – ${trades.get(code.slice(4))?.name || code.slice(4)}` : (COST_CODES[code] || code);
    return { code, label, budget: round2(b.amount), budgetHours: b.hours, actual: round2(a.amount), actualHours: a.hours, variance: round2(a.amount - b.amount) };
  }).filter((r) => r.budget || r.actual).sort((x, y) => x.code.localeCompare(y.code));
  const totals = rows.reduce((t, r) => ({ budget: t.budget + r.budget, actual: t.actual + r.actual }), { budget: 0, actual: 0 });
  const sell = pricing.totals.sell;
  const status = !totals.actual ? 'awaiting' : totals.actual > sell ? 'loss' : totals.actual > totals.budget * 1.05 ? 'over' : totals.actual > totals.budget ? 'watch' : 'on_track';
  return {
    basis, sell, rows, status,
    totals: { budget: round2(totals.budget), actual: round2(totals.actual), variance: round2(totals.actual - totals.budget), actualMargin: round2(sell - totals.actual), actualMarginPct: sell ? (sell - totals.actual) / sell : 0 },
    tradeCodes: book.trades.map((t) => ({ code: `LAB:${t.key}`, label: `Labour – ${t.name}`, rate: t.rate })),
  };
}

export function companyOf(db, companyId) {
  return companySettings(db.get('SELECT * FROM companies WHERE id = ?', companyId));
}

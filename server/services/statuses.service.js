// Job statuses as each company names them. The eight core statuses stay fixed (reports, locking and the schedule use
// them); admins can rename them and add their own variations, each of which counts as one core status.
import { badRequest, conflict, notFound } from '../http/http.js';
import { audit } from './audit.service.js';

export const CORE_STATUSES = ['enquiry', 'quoting', 'quoted', 'won', 'in_production', 'installing', 'complete', 'lost'];
export const CORE_LABELS = { enquiry: 'Enquiry', quoting: 'Quoting', quoted: 'Quoted', won: 'Won', in_production: 'In production', installing: 'Installing', complete: 'Complete', lost: 'Missed' };
/** Closed jobs: moving one back to any other status is "reopening" and needs a reason. */
export const CLOSED_STATUSES = ['complete', 'lost'];

export function ensureStatusDefaults(db, companyId) {
  if (db.get('SELECT 1 FROM job_statuses WHERE company_id = ? AND builtin = 1', companyId)) return;
  CORE_STATUSES.forEach((s, i) => db.run('INSERT OR IGNORE INTO job_statuses (company_id, key, label, base_status, builtin, sort) VALUES (?, ?, ?, ?, 1, ?)',
    companyId, s, CORE_LABELS[s], s, i * 10));
}

export function ensureAllStatusDefaults(db) {
  for (const c of db.all('SELECT id FROM companies')) ensureStatusDefaults(db, c.id);
}

const out = (r) => ({ key: r.key, label: r.label, baseStatus: r.base_status, builtin: !!r.builtin, sort: r.sort, active: !!r.active });

/** All statuses in display order: each core status followed by its variations. */
export function listStatuses(db, companyId, { includeInactive = false } = {}) {
  ensureStatusDefaults(db, companyId);
  const rows = db.all(`SELECT * FROM job_statuses WHERE company_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort, id`, companyId).map(out);
  return CORE_STATUSES.flatMap((s) => [rows.find((r) => r.builtin && r.key === s), ...rows.filter((r) => !r.builtin && r.baseStatus === s)]).filter(Boolean);
}

/** Display label for a job: its variation if it has one, otherwise the company's name for the core status. */
export function statusLabel(db, companyId, status, detail) {
  const row = detail
    ? db.get('SELECT label FROM job_statuses WHERE company_id = ? AND key = ?', companyId, detail)
    : db.get('SELECT label FROM job_statuses WHERE company_id = ? AND key = ? AND builtin = 1', companyId, status);
  return row ? row.label : CORE_LABELS[status] || status;
}

/** Check a job's status + variation pair; returns the variation key to store (or null). */
export function checkStatusDetail(db, companyId, status, detail, currentDetail) {
  if (!detail) return null;
  const row = db.get('SELECT * FROM job_statuses WHERE company_id = ? AND key = ? AND builtin = 0', companyId, detail);
  if (!row) throw badRequest('Unknown job status.');
  if (row.base_status !== status) throw badRequest(`"${row.label}" is a kind of ${CORE_LABELS[row.base_status]}, not ${CORE_LABELS[status]}.`);
  if (!row.active && detail !== currentDetail) throw badRequest(`"${row.label}" is turned off. Choose another status.`);
  return detail;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'status';

/** Create or rename/update a status. Core statuses can be renamed only. */
export function saveStatus(db, actor, body) {
  const label = String(body.label || '').trim().slice(0, 60);
  if (!label) throw badRequest('Enter a name for the status.');
  const companyId = actor.company_id;
  ensureStatusDefaults(db, companyId);
  if (body.key) {
    const row = db.get('SELECT * FROM job_statuses WHERE company_id = ? AND key = ?', companyId, String(body.key));
    if (!row) throw notFound('Status not found.');
    const active = row.builtin ? 1 : body.active === false ? 0 : 1;
    db.run('UPDATE job_statuses SET label = ?, active = ? WHERE id = ?', label, active, row.id);
    audit(db, { companyId, userId: actor.id, entity: 'job_status', entityId: row.key, action: 'status_update',
      detail: { key: row.key, from: row.label, to: label, active: !!active, wasActive: !!row.active } });
    return row.key;
  }
  const base = String(body.baseStatus || '');
  if (!CORE_STATUSES.includes(base)) throw badRequest('Choose which main status this is a kind of.');
  let key = `${base}_${slug(label)}`;
  for (let i = 2; db.get('SELECT 1 FROM job_statuses WHERE company_id = ? AND key = ?', companyId, key); i++) key = `${base}_${slug(label)}_${i}`;
  const baseSort = db.get('SELECT sort FROM job_statuses WHERE company_id = ? AND key = ?', companyId, base).sort;
  const n = db.get('SELECT COUNT(*) AS n FROM job_statuses WHERE company_id = ? AND base_status = ? AND builtin = 0', companyId, base).n;
  db.run('INSERT INTO job_statuses (company_id, key, label, base_status, builtin, sort) VALUES (?, ?, ?, ?, 0, ?)', companyId, key, label, base, baseSort + 1 + Math.min(n, 8));
  audit(db, { companyId, userId: actor.id, entity: 'job_status', entityId: key, action: 'status_create', detail: { key, label, baseStatus: base } });
  return key;
}

/** Delete a variation that no job uses; one in use can only be turned off, so existing jobs keep their status. */
export function deleteStatus(db, actor, key) {
  const row = db.get('SELECT * FROM job_statuses WHERE company_id = ? AND key = ?', actor.company_id, key);
  if (!row) throw notFound('Status not found.');
  if (row.builtin) throw conflict('Main statuses cannot be deleted, because reports and price locking use them. You can rename them.');
  const used = db.get('SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND status_detail = ?', actor.company_id, key).n;
  if (used) throw conflict(`"${row.label}" is used by ${used} job${used === 1 ? '' : 's'}, so it cannot be deleted. Turn it off instead: those jobs keep it, and it is no longer offered for other jobs.`, { used });
  db.run('DELETE FROM job_statuses WHERE id = ?', row.id);
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'job_status', entityId: key, action: 'status_delete', detail: { key, label: row.label } });
}

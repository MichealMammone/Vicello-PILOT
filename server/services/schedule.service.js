// Scheduling: resource pool (staff + leave), workflow event types, rule-driven proposals per job,
// calendar events, conflict detection and reminders.
import { badRequest, conflict, notFound } from '../http/http.js';
import { priceJob } from '../../shared/pricing.js';
import * as D from '../../shared/dates.js';
import { audit } from './audit.service.js';
import { loadBook, loadJobLinesForPricing } from './pricebook.service.js';

const nowIso = () => new Date().toISOString();

export const STAFF_CATEGORIES = { designer: 'Designer', installer: 'Installer', project_manager: 'Project Manager', qa: 'QA' };
export const EVENT_STATUSES = ['proposed', 'pending', 'confirmed', 'completed', 'cancelled'];
const SCHEDULED = ['pending', 'confirmed', 'completed'];

const PLACEHOLDER_STAFF = [
  ['Mia Thornton', 'Senior Kitchen Designer', 'designer', '#7A4FB5'],
  ['Lucas Ferreira', 'Kitchen Designer', 'designer', '#A65FB8'],
  ['Hannah Okafor', 'Project Manager', 'project_manager', '#2B6CB0'],
  ['Daniel Reyes', 'Site Supervisor', 'project_manager', '#3C8DBC'],
  ['Jack Whitfield', 'Lead Installer', 'installer', '#B7791F'],
  ['Sam Kowalski', 'Installer', 'installer', '#C05621'],
  ['Ethan Marsh', 'Installer', 'installer', '#9C4221'],
  ['Tom Bradley', 'Installer', 'installer', '#975A16'],
  ['Priya Raman', 'Apprentice Installer', 'installer', '#B83280'],
  ['Grace Lindqvist', 'Quality & Client Care Lead', 'qa', '#2F855A'],
];

// key, name, category, staffCount, unit, duration, anchor, offsetDays, rule, reminderMinutes, colour, defaultStart
const DEFAULT_TYPES = [
  ['consultation', 'Consultation', 'designer', 1, 'minutes', 120, 'job_created', 2, 'always', 1440, '#7A4FB5', '10:00'],
  ['site_inspection', 'Site inspection', 'project_manager', 1, 'minutes', 90, 'consultation', 5, 'site_dependent', 1440, '#2B6CB0', '09:00'],
  ['check_measure', 'Check measure', 'project_manager', 1, 'minutes', 120, 'site_inspection', 14, 'has_cabinetry', 1440, '#3C8DBC', '08:00'],
  ['install', 'Install', 'installer', 2, 'days', 2, 'check_measure', 21, 'always', 2880, '#B7791F', '07:00'],
  ['fit_off', 'Fit-off', 'installer', 1, 'minutes', 240, 'install:end', 5, 'has_fitoff_items', 1440, '#C05621', '08:00'],
  ['walkthrough', 'Client walk-through', 'project_manager', 1, 'minutes', 60, 'fit_off:end', 2, 'always', 1440, '#2C7A7B', '15:00'],
  ['feedback', 'Feedback session', 'qa', 1, 'minutes', 45, 'walkthrough', 14, 'always', 1440, '#2F855A', '11:00'],
  ['six_month', '6-month check-in consultation', 'qa', 1, 'minutes', 60, 'walkthrough', 182, 'always', 10080, '#276749', '10:00'],
];

export const RULES = {
  always: 'Every job',
  site_dependent: 'Jobs with kitchen, butler\'s, laundry, vanity or alfresco areas',
  has_cabinetry: 'Jobs with cabinetry, panels or benchtops',
  has_fitoff_items: 'Jobs with hardware, handles, lighting, benchtops or appliance integration',
  optional: 'Never added automatically',
};

/** Create default event types and placeholder staff for a company that has none. */
export function ensureDefaults(db, companyId) {
  if (!db.get('SELECT 1 FROM event_types WHERE company_id = ?', companyId)) {
    DEFAULT_TYPES.forEach(([key, name, cat, count, unit, dur, anchor, off, rule, rem, colour, start], i) => db.run(
      `INSERT INTO event_types (company_id, key, name, staff_category, staff_count, unit, duration, anchor, offset_days, rule, reminder_minutes, colour, default_start, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, companyId, key, name, cat, count, unit, dur, anchor, off, rule, rem, colour, start, i));
  }
  if (!db.get('SELECT 1 FROM staff WHERE company_id = ?', companyId)) {
    const ts = nowIso();
    PLACEHOLDER_STAFF.forEach(([name, position, category, colour]) => db.run(
      `INSERT INTO staff (company_id, name, position, category, colour, is_placeholder, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      companyId, name, position, category, colour, ts));
  }
}

export function ensureAllDefaults(db) {
  for (const c of db.all('SELECT id FROM companies')) ensureDefaults(db, c.id);
}

// ---------------- staff & leave ----------------

const staffOut = (s) => ({ id: s.id, name: s.name, position: s.position, category: s.category, categoryName: STAFF_CATEGORIES[s.category] || s.category,
  email: s.email || '', phone: s.phone || '', colour: s.colour, hoursPerDay: s.hours_per_day, userId: s.user_id, placeholder: !!s.is_placeholder, active: !!s.active });

export function listStaff(db, companyId, { includeInactive = false } = {}) {
  return db.all(`SELECT * FROM staff WHERE company_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY active DESC, category, name`, companyId).map(staffOut);
}

export function saveStaff(db, actor, body) {
  const name = String(body.name || '').trim();
  const position = String(body.position || '').trim();
  if (!name) throw badRequest('Enter a name.');
  if (!position) throw badRequest('Enter a position.');
  const category = String(body.category || '');
  if (!category) throw badRequest('Choose a category.');
  const hours = Number(body.hoursPerDay ?? 7.6);
  if (!(hours > 0 && hours <= 24)) throw badRequest('Hours per day must be between 0 and 24.');
  const colour = /^#[0-9a-f]{6}$/i.test(body.colour || '') ? body.colour : '#2B6653';
  if (body.id) {
    const s = db.get('SELECT * FROM staff WHERE id = ? AND company_id = ?', body.id, actor.company_id);
    if (!s) throw notFound('Staff member not found.');
    db.run(`UPDATE staff SET name = ?, position = ?, category = ?, email = ?, phone = ?, colour = ?, hours_per_day = ?, active = ?, is_placeholder = ? WHERE id = ?`,
      name, position, category, body.email || null, body.phone || null, colour, hours, body.active === false ? 0 : 1,
      body.placeholder === false || name !== s.name ? 0 : s.is_placeholder, s.id);
    audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'staff', entityId: s.id, action: 'update', detail: { name } });
    return s.id;
  }
  const id = Number(db.run(`INSERT INTO staff (company_id, name, position, category, email, phone, colour, hours_per_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    actor.company_id, name, position, category, body.email || null, body.phone || null, colour, hours, nowIso()).lastInsertRowid);
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'staff', entityId: id, action: 'create', detail: { name, category } });
  return id;
}

export function listLeave(db, companyId, from, to) {
  return db.all(`SELECT l.*, s.name AS staff_name FROM staff_leave l JOIN staff s ON s.id = l.staff_id
                 WHERE s.company_id = ? AND l.end_date >= ? AND l.start_date <= ? ORDER BY l.start_date`, companyId, from || '0000-00-00', to || '9999-12-31')
    .map((l) => ({ id: l.id, staffId: l.staff_id, staffName: l.staff_name, start: l.start_date, end: l.end_date, reason: l.reason || '' }));
}

export function addLeave(db, actor, body) {
  const s = db.get('SELECT id FROM staff WHERE id = ? AND company_id = ?', Number(body.staffId), actor.company_id);
  if (!s) throw badRequest('Choose a staff member.');
  if (!D.isDate(body.start) || !D.isDate(body.end) || body.end < body.start) throw badRequest('Enter a valid date range.');
  const id = Number(db.run('INSERT INTO staff_leave (staff_id, start_date, end_date, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    s.id, body.start, body.end, String(body.reason || '').slice(0, 200) || null, actor.id, nowIso()).lastInsertRowid);
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'staff', entityId: s.id, action: 'leave_add', detail: { start: body.start, end: body.end } });
  return id;
}

export function deleteLeave(db, actor, id) {
  const l = db.get('SELECT l.* FROM staff_leave l JOIN staff s ON s.id = l.staff_id WHERE l.id = ? AND s.company_id = ?', id, actor.company_id);
  db.run('DELETE FROM staff_leave WHERE id = ? AND staff_id IN (SELECT id FROM staff WHERE company_id = ?)', id, actor.company_id);
  if (l) audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'staff', entityId: l.staff_id, action: 'leave_delete', detail: { start: l.start_date, end: l.end_date, reason: l.reason } });
}

// ---------------- event types ----------------

const typeOut = (t) => ({ key: t.key, name: t.name, staffCategory: t.staff_category, staffCount: t.staff_count, unit: t.unit, duration: t.duration,
  anchor: t.anchor, offsetDays: t.offset_days, rule: t.rule, reminderMinutes: t.reminder_minutes, colour: t.colour, defaultStart: t.default_start, sort: t.sort, active: !!t.active });

export const listEventTypes = (db, companyId) => db.all('SELECT * FROM event_types WHERE company_id = ? ORDER BY sort, id', companyId).map(typeOut);

export function updateEventType(db, actor, key, f) {
  const t = db.get('SELECT * FROM event_types WHERE company_id = ? AND key = ?', actor.company_id, key);
  if (!t) throw notFound('Event type not found.');
  const sets = [], vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if ('name' in f) { const n = String(f.name).trim(); if (!n) throw badRequest('Name is required.'); set('name', n); }
  if ('staffCategory' in f) set('staff_category', String(f.staffCategory));
  if ('staffCount' in f) { const n = Number(f.staffCount); if (!(n >= 0 && n <= 10)) throw badRequest('Staff count must be 0–10.'); set('staff_count', Math.round(n)); }
  if ('unit' in f) { if (!['minutes', 'days'].includes(f.unit)) throw badRequest('Unit must be minutes or days.'); set('unit', f.unit); }
  if ('duration' in f) { const n = Number(f.duration); if (!(n > 0)) throw badRequest('Duration must be more than 0.'); set('duration', n); }
  if ('anchor' in f) set('anchor', String(f.anchor));
  if ('offsetDays' in f) { const n = Number(f.offsetDays); if (!Number.isFinite(n) || n < 0 || n > 730) throw badRequest('Lead time must be 0–730 days.'); set('offset_days', Math.round(n)); }
  if ('rule' in f) { if (!RULES[f.rule]) throw badRequest('Unknown rule.'); set('rule', f.rule); }
  if ('reminderMinutes' in f) set('reminder_minutes', Math.max(0, Math.round(Number(f.reminderMinutes) || 0)));
  if ('defaultStart' in f) { if (!/^\d{2}:\d{2}$/.test(f.defaultStart)) throw badRequest('Start time must look like 09:00.'); set('default_start', f.defaultStart); }
  if ('active' in f) set('active', f.active ? 1 : 0);
  if (sets.length) db.run(`UPDATE event_types SET ${sets.join(', ')} WHERE id = ?`, ...vals, t.id);
  const before = typeOut(t), after = typeOut(db.get('SELECT * FROM event_types WHERE id = ?', t.id));
  const changes = Object.keys(after).filter((k) => String(before[k]) !== String(after[k])).map((k) => ({ field: k, from: before[k], to: after[k] }));
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'event_type', entityId: key, action: 'update', detail: { name: after.name, changes } });
}

const keyFrom = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'milestone';

/** New workflow milestone. It is proposed for new jobs (and on "Recalculate") according to its rule. */
export function createEventType(db, actor, f) {
  const name = String(f.name || '').trim();
  if (!name) throw badRequest('Enter a name for the milestone.');
  if (!STAFF_CATEGORIES[f.staffCategory]) throw badRequest('Choose a staff category.');
  let key = keyFrom(name);
  for (let i = 2; db.get('SELECT 1 FROM event_types WHERE company_id = ? AND key = ?', actor.company_id, key); i++) key = `${keyFrom(name)}_${i}`;
  const last = db.get('SELECT key, MAX(sort) AS s FROM event_types WHERE company_id = ?', actor.company_id);
  const anchor = f.anchor ? String(f.anchor) : last?.key ? `${last.key}:end` : 'job_created';
  const colour = /^#[0-9a-f]{6}$/i.test(f.colour || '') ? f.colour : '#5D6963';
  db.run(`INSERT INTO event_types (company_id, key, name, staff_category, staff_count, unit, duration, anchor, offset_days, rule, reminder_minutes, colour, default_start, sort)
          VALUES (?, ?, ?, ?, 1, 'minutes', 60, ?, 0, 'always', 1440, ?, '09:00', ?)`, actor.company_id, key, name, f.staffCategory, anchor, colour, (last?.s ?? -1) + 1);
  const rest = { ...f };
  delete rest.name; delete rest.colour;
  updateEventType(db, actor, key, rest); // validates and applies duration, rule, lead time, etc.
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'event_type', entityId: key, action: 'create', detail: { name, key } });
  return key;
}

/**
 * Delete a milestone. One that is already on any job's schedule cannot be deleted (those jobs keep it); turn it off
 * instead. Milestones that were timed from it are re-timed from its own starting point, so nothing is left dangling.
 */
export function deleteEventType(db, actor, key) {
  const t = db.get('SELECT * FROM event_types WHERE company_id = ? AND key = ?', actor.company_id, key);
  if (!t) throw notFound('Milestone not found.');
  const used = db.get("SELECT COUNT(DISTINCT job_id) AS n FROM job_events WHERE company_id = ? AND type_key = ? AND status <> 'proposed'", actor.company_id, key).n;
  if (used) throw conflict(`"${t.name}" is on the schedule of ${used} job${used === 1 ? '' : 's'}, so it cannot be deleted. Untick "On" to stop proposing it for new jobs; existing jobs keep it.`, { used });
  const dependents = db.all('SELECT key, name, anchor, offset_days FROM event_types WHERE company_id = ? AND (anchor = ? OR anchor = ?)', actor.company_id, key, `${key}:end`);
  db.tx(() => {
    for (const d of dependents) db.run('UPDATE event_types SET anchor = ?, offset_days = ? WHERE company_id = ? AND key = ?', t.anchor, Math.min(730, d.offset_days + t.offset_days), actor.company_id, d.key);
    db.run("DELETE FROM job_events WHERE company_id = ? AND type_key = ? AND status = 'proposed'", actor.company_id, key);
    db.run('DELETE FROM event_types WHERE id = ?', t.id);
    audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'event_type', entityId: key, action: 'delete',
      detail: { name: t.name, retimed: dependents.map((d) => d.name), settings: typeOut(t) } });
  });
  return { retimed: dependents.map((d) => d.name) };
}

// ---------------- rules engine ----------------

const SITE_AREAS = ['kitchen', 'butlers', 'laundry', 'vanity', 'alfresco'];
const CABINETRY_CATS = ['Cabinetry', 'Panels & bulkheads', 'Benchtops'];
const FITOFF_CATS = ['Hardware & accessories', 'Handles', 'Lighting', 'Benchtops'];
const AREA_LABEL = { kitchen: 'kitchen', butlers: "butler's pantry", laundry: 'laundry', vanity: 'vanity', alfresco: 'alfresco' };

/** Facts about a job that the rules use: area types, item categories, estimated install hours. */
export function jobFacts(db, company, jobId) {
  const job = db.get('SELECT * FROM jobs WHERE id = ? AND company_id = ?', jobId, company.id);
  if (!job) throw notFound('Job not found.');
  const doc = loadJobLinesForPricing(db, job);
  const book = loadBook(db, company.id, job.price_book_id);
  const pricing = priceJob(doc, book, { gstRate: company.gst_rate, floorMargin: company.floor_margin });
  const modules = new Map(book.modules.map((m) => [m.key, m]));
  const cats = new Map();
  let lineCount = 0;
  for (const a of doc.areas) {
    if (a.optional) continue;
    for (const l of a.lines) {
      if (!Number(l.qty)) continue;
      lineCount++;
      const m = modules.get(l.moduleKey);
      const cat = m ? m.category : 'Custom';
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat).push(m ? m.name : 'Custom item');
      if (l.moduleKey === 'appliance-integration') { if (!cats.has('Integration')) cats.set('Integration', []); cats.get('Integration').push(m.name); }
    }
  }
  const areaTypes = db.all('SELECT area_type, COUNT(*) AS n FROM job_areas WHERE job_id = ? AND optional = 0 GROUP BY area_type', jobId);
  return {
    job, areaTypes: Object.fromEntries(areaTypes.map((a) => [a.area_type, a.n])),
    areaCount: db.get('SELECT COUNT(*) AS n FROM job_areas WHERE job_id = ? AND optional = 0 AND area_type <> ?', jobId, 'services').n,
    categories: cats, lineCount,
    installHours: pricing.totals.hours.INSTALL || 0,
  };
}

function evaluateRule(rule, f) {
  const list = (arr) => [...new Set(arr)].slice(0, 3).join(', ');
  switch (rule) {
    case 'always': return { required: true, reason: 'Standard for every job.' };
    case 'optional': return { required: false, reason: 'Optional – add it if this job needs it.' };
    case 'site_dependent': {
      const found = SITE_AREAS.filter((t) => f.areaTypes[t]);
      return found.length
        ? { required: true, reason: `Needs a site check: job has ${found.map((t) => AREA_LABEL[t]).join(', ')} area${found.length > 1 ? 's' : ''}.` }
        : { required: false, reason: 'No kitchen, laundry, vanity or alfresco areas.' };
    }
    case 'has_cabinetry': {
      if (!f.lineCount) return { required: true, reason: 'Assumed until items are added.' };
      const items = CABINETRY_CATS.flatMap((c) => f.categories.get(c) || []);
      return items.length ? { required: true, reason: `Job has ${items.length} cabinetry/panel item${items.length > 1 ? 's' : ''} (${list(items)}).` }
        : { required: false, reason: 'No cabinetry, panels or benchtops in this job.' };
    }
    case 'has_fitoff_items': {
      if (!f.lineCount) return { required: true, reason: 'Assumed until items are added.' };
      const items = [...FITOFF_CATS, 'Integration'].flatMap((c) => f.categories.get(c) || []);
      return items.length ? { required: true, reason: `Hardware to fit off: ${list(items)}.` }
        : { required: false, reason: 'No hardware, handles, lighting or integration items.' };
    }
    default: return { required: true, reason: '' };
  }
}

/** Built-in sizing: install days from estimated install hours; check measure grows with the number of areas. */
function sizeEvent(type, f, staffHours) {
  if (type.key === 'install' && type.unit === 'days') {
    const crew = Math.max(1, type.staff_count);
    if (f.installHours > 0) {
      const days = Math.min(15, Math.max(1, Math.ceil(f.installHours / (crew * staffHours))));
      return { duration: days, note: ` ${days} day${days > 1 ? 's' : ''}: ${Math.round(f.installHours)} estimated install hours ÷ ${crew} installer${crew > 1 ? 's' : ''}.` };
    }
  }
  if (type.key === 'check_measure' && type.unit === 'minutes') {
    const mins = Math.min(300, type.duration + Math.max(0, f.areaCount - 1) * 30);
    if (mins !== type.duration) return { duration: mins, note: ` ${mins / 60} h for ${f.areaCount} areas.` };
  }
  return { duration: type.duration, note: '' };
}

function placeEvent(type, date, duration) {
  if (type.unit === 'days') return { allDay: true, start: date, end: D.addBusinessDays(date, Math.max(1, Math.round(duration)) - 1) };
  const start = D.at(date, type.default_start);
  return { allDay: false, start, end: D.addMinutes(start, Math.round(duration)) };
}

/** Scheduled (non-proposed, non-cancelled) commitments + leave for a set of staff, for conflict checks. */
function loadCommitments(db, companyId, staffIds, from, to, { otherProposalsFor = null } = {}) {
  if (!staffIds.length) return { events: [], leave: [] };
  const ids = staffIds.map(Number).join(',');
  // For suggestions, other jobs' unconfirmed proposals also count, so two new jobs don't get the same person at the same time.
  const statusClause = otherProposalsFor
    ? `(e.status IN ('pending','confirmed','completed') OR (e.status = 'proposed' AND e.included = 1 AND e.job_id <> ${Number(otherProposalsFor)}))`
    : "e.status IN ('pending','confirmed','completed')";
  const events = db.all(`SELECT e.id, e.job_id, e.title, e.all_day, e.start_at, e.end_at, e.status, es.staff_id, j.job_number
                         FROM job_events e JOIN job_event_staff es ON es.event_id = e.id JOIN jobs j ON j.id = e.job_id
                         WHERE e.company_id = ? AND es.staff_id IN (${ids}) AND ${statusClause}
                           AND e.end_at >= ? AND e.start_at <= ? AND j.archived_at IS NULL`, companyId, from, `${to}T99`)
    .map((e) => ({ id: e.id, jobId: e.job_id, title: e.title, allDay: !!e.all_day, start: e.start_at, end: e.end_at, staffId: e.staff_id, jobNumber: e.job_number }));
  const leave = db.all(`SELECT staff_id, start_date, end_date, reason FROM staff_leave WHERE staff_id IN (${ids}) AND end_date >= ? AND start_date <= ?`, D.dateOf(from), D.dateOf(to))
    .map((l) => ({ staffId: l.staff_id, allDay: true, start: l.start_date, end: l.end_date, reason: l.reason }));
  return { events, leave };
}

function staffConflicts(ev, staffId, commitments) {
  const out = [];
  for (const c of commitments.events) {
    if (c.staffId !== staffId || c.id === ev.id) continue;
    if (D.overlaps(ev, c)) out.push({ staffId, kind: 'event', eventId: c.id, title: `${c.title} (${c.jobNumber})` });
  }
  for (const l of commitments.leave) {
    if (l.staffId === staffId && D.overlaps(ev, l)) out.push({ staffId, kind: 'leave', title: `On leave${l.reason ? `: ${l.reason}` : ''}` });
  }
  return out;
}

/** Pick staff of the right category who are free, least-booked first. */
function suggestStaff(db, companyId, jobId, type, ev, planned) {
  if (!type.staff_count) return { staffIds: [], note: '' };
  const pool = db.all('SELECT id, name, hours_per_day FROM staff WHERE company_id = ? AND active = 1 AND category = ? ORDER BY name', companyId, type.staff_category);
  if (!pool.length) return { staffIds: [], note: ` No active ${STAFF_CATEGORIES[type.staff_category] || type.staff_category} staff to assign.` };
  const from = D.addDays(D.dateOf(ev.start), -7), to = D.addDays(D.dateOf(ev.end), 7);
  const com = loadCommitments(db, companyId, pool.map((p) => p.id), from, to, { otherProposalsFor: jobId });
  for (const p of planned) for (const sid of p.staffIds) com.events.push({ ...p, id: -1, staffId: sid, jobNumber: 'this job' });
  const ranked = pool.map((p) => {
    const conflicts = staffConflicts(ev, p.id, com);
    const load = com.events.filter((c) => c.staffId === p.id).reduce((s, c) => s + D.eventDates(c).reduce((h, d) => h + D.hoursOnDate(c, d, p.hours_per_day), 0), 0);
    return { id: p.id, free: !conflicts.length, load };
  }).sort((a, b) => (b.free - a.free) || a.load - b.load || a.id - b.id);
  const chosen = ranked.slice(0, type.staff_count);
  const busy = chosen.filter((c) => !c.free).length;
  return { staffIds: chosen.map((c) => c.id), allFree: !busy && chosen.length >= type.staff_count, note: busy ? ` ${busy} suggested staff already booked – check availability.` : '' };
}

/** Find the first business day (within ~4 weeks) on which enough staff of the right category are free. */
function placeWithStaff(db, companyId, jobId, type, date, duration, planned) {
  let d = date;
  for (let tries = 0; tries < 20; tries++) {
    const placed = placeEvent(type, d, duration);
    const sug = suggestStaff(db, companyId, jobId, type, placed, planned);
    if (sug.allFree || !type.staff_count) {
      const moved = D.daysBetween(date, d);
      const note = moved ? ` Moved ${moved} day${moved > 1 ? 's' : ''} later: no ${STAFF_CATEGORIES[type.staff_category] || 'staff'} free on ${D.parseDate(date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}.` : '';
      return { placed, sug: { ...sug, note: sug.note + note } };
    }
    d = D.addBusinessDays(d, 1);
  }
  const placed = placeEvent(type, date, duration);
  return { placed, sug: suggestStaff(db, companyId, jobId, type, placed, planned) };
}

/**
 * Work out the events a job needs and store them as proposals (not yet on the calendar).
 * Existing scheduled events are kept and used as anchors; earlier proposals are replaced.
 */
export function proposeSchedule(db, actor, company, jobId) {
  ensureDefaults(db, company.id);
  const f = jobFacts(db, company, jobId);
  const types = db.all('SELECT * FROM event_types WHERE company_id = ? AND active = 1 ORDER BY sort, id', company.id);
  const existing = db.all("SELECT * FROM job_events WHERE job_id = ? AND status NOT IN ('proposed','cancelled')", jobId);
  const staffHours = db.get("SELECT AVG(hours_per_day) AS h FROM staff WHERE company_id = ? AND category = 'installer' AND active = 1", company.id).h || 7.6;
  const dates = { job_created: { start: D.dateOf(f.job.created_at), end: D.dateOf(f.job.created_at) } };
  const earliest = D.nextBusinessDay(D.addDays(D.today(), 1));
  let lastIncluded = dates.job_created;
  const planned = [];

  return db.tx(() => {
    db.run("DELETE FROM job_events WHERE job_id = ? AND status = 'proposed'", jobId);
    types.forEach((t, i) => {
      const done = existing.find((e) => e.type_key === t.key);
      if (done) { dates[t.key] = { start: D.dateOf(done.start_at), end: D.dateOf(done.end_at) }; lastIncluded = dates[t.key]; return; }
      const { required, reason } = evaluateRule(t.rule, f);
      const [anchorKey, edge] = t.anchor.split(':');
      const anchor = dates[anchorKey] || lastIncluded;
      let date = D.nextBusinessDay(D.addDays(edge === 'end' ? anchor.end : anchor.start, t.offset_days));
      if (D.dayNum(date) < D.dayNum(earliest)) date = earliest;
      const size = sizeEvent(t, f, staffHours);
      const { placed, sug } = required
        ? placeWithStaff(db, company.id, jobId, t, date, size.duration, planned)
        : { placed: placeEvent(t, date, size.duration), sug: { staffIds: [], note: '' } };
      const ev = { ...placed, staffIds: sug.staffIds };
      if (required) { dates[t.key] = { start: D.dateOf(placed.start), end: D.dateOf(placed.end) }; lastIncluded = dates[t.key]; planned.push(ev); }
      const ts = nowIso();
      const id = Number(db.run(`INSERT INTO job_events (company_id, job_id, type_key, title, status, included, reason, all_day, start_at, end_at, location, reminder_minutes, sort, created_by, created_at, updated_by, updated_at)
                                VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        company.id, jobId, t.key, t.name, required ? 1 : 0, (reason + size.note + sug.note).trim(), placed.allDay ? 1 : 0, placed.start, placed.end,
        f.job.site_address || null, t.reminder_minutes, i, actor?.id ?? null, ts, actor?.id ?? null, ts).lastInsertRowid);
      for (const sid of sug.staffIds) db.run('INSERT INTO job_event_staff (event_id, staff_id) VALUES (?, ?)', id, sid);
    });
    audit(db, { companyId: company.id, userId: actor?.id, entity: 'job', entityId: jobId, action: 'schedule_proposed' });
    return getJobSchedule(db, company.id, jobId);
  });
}

/** Move included proposals onto the calendar (status pending). */
export function confirmSchedule(db, actor, company, jobId) {
  const job = db.get('SELECT id FROM jobs WHERE id = ? AND company_id = ?', jobId, company.id);
  if (!job) throw notFound('Job not found.');
  const n = db.run("UPDATE job_events SET status = 'pending', updated_by = ?, updated_at = ? WHERE job_id = ? AND status = 'proposed' AND included = 1", actor.id, nowIso(), jobId).changes;
  if (!n) throw badRequest('There are no included events to confirm.');
  audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: jobId, action: 'schedule_confirmed', detail: { events: Number(n) } });
  return getJobSchedule(db, company.id, jobId);
}

/** Cancel open events when a job is lost. */
export function cancelOpenEvents(db, actor, company, jobId) {
  const n = db.run("UPDATE job_events SET status = 'cancelled', updated_by = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending','confirmed')", actor.id, nowIso(), jobId).changes;
  db.run("DELETE FROM job_events WHERE job_id = ? AND status = 'proposed'", jobId);
  if (n) audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: jobId, action: 'schedule_cancelled', detail: { events: Number(n) } });
}

// ---------------- events ----------------

function eventRows(db, where, params) {
  const rows = db.all(`SELECT e.*, j.job_number, j.name AS job_name, j.client_name, j.site_address, j.status AS job_status,
                              t.colour, t.name AS type_name, t.staff_category
                       FROM job_events e JOIN jobs j ON j.id = e.job_id
                       LEFT JOIN event_types t ON t.company_id = e.company_id AND t.key = e.type_key
                       WHERE ${where} ORDER BY e.start_at, e.sort, e.id`, ...params);
  if (!rows.length) return [];
  const staff = db.all(`SELECT event_id, staff_id FROM job_event_staff WHERE event_id IN (${rows.map((r) => r.id).join(',')})`);
  return rows.map((e) => ({
    id: e.id, jobId: e.job_id, jobNumber: e.job_number, jobName: e.job_name, clientName: e.client_name || '', jobStatus: e.job_status,
    typeKey: e.type_key, typeName: e.type_name || 'Other', colour: e.colour || '#5D6963', staffCategory: e.staff_category || '',
    title: e.title, status: e.status, included: !!e.included, reason: e.reason || '',
    allDay: !!e.all_day, start: e.start_at, end: e.end_at, location: e.location || e.site_address || '', notes: e.notes || '',
    reminderMinutes: e.reminder_minutes, reminderDismissedAt: e.reminder_dismissed_at, completedAt: e.completed_at,
    staffIds: staff.filter((s) => s.event_id === e.id).map((s) => s.staff_id), updatedAt: e.updated_at,
  }));
}

function withConflicts(db, companyId, events) {
  const scheduled = events.filter((e) => e.status !== 'cancelled' && e.included);
  const staffIds = [...new Set(scheduled.flatMap((e) => e.staffIds))];
  if (!staffIds.length) return events.map((e) => ({ ...e, conflicts: [] }));
  const from = scheduled.reduce((m, e) => (e.start < m ? e.start : m), '9999');
  const to = scheduled.reduce((m, e) => (e.end > m ? e.end : m), '0000');
  const com = loadCommitments(db, companyId, staffIds, D.dateOf(from), D.dateOf(to));
  return events.map((e) => ({ ...e, conflicts: e.status === 'cancelled' || e.status === 'completed' ? [] : e.staffIds.flatMap((sid) => staffConflicts(e, sid, com)) }));
}

export function getJobSchedule(db, companyId, jobId) {
  return withConflicts(db, companyId, eventRows(db, 'e.job_id = ? AND e.company_id = ?', [jobId, companyId]));
}

export function getEvent(db, companyId, id) {
  const e = withConflicts(db, companyId, eventRows(db, 'e.id = ? AND e.company_id = ?', [id, companyId]))[0];
  if (!e) throw notFound('Event not found.');
  return e;
}

/** Calendar query. Proposed events are only returned for a single job's planning view. */
export function listEvents(db, companyId, q = {}) {
  const where = ['e.company_id = ?', 'j.archived_at IS NULL'];
  const params = [companyId];
  const from = D.isDate(q.from) ? q.from : D.addDays(D.today(), -31);
  const to = D.isDate(q.to) ? q.to : D.addDays(D.today(), 62);
  where.push('e.end_at >= ?', 'e.start_at <= ?');
  params.push(from, `${to}T99`);
  const statuses = String(q.status || '').split(',').filter((s) => EVENT_STATUSES.includes(s) && s !== 'proposed');
  where.push(statuses.length ? `e.status IN (${statuses.map(() => '?').join(',')})` : "e.status IN ('pending','confirmed','completed')");
  params.push(...statuses);
  if (q.job) { where.push('e.job_id = ?'); params.push(Number(q.job)); }
  const types = String(q.types || '').split(',').filter(Boolean);
  if (types.length) { where.push(`e.type_key IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  const staff = String(q.staff || '').split(',').map(Number).filter(Boolean);
  if (staff.length) where.push(`EXISTS (SELECT 1 FROM job_event_staff s WHERE s.event_id = e.id AND s.staff_id IN (${staff.join(',')}))`);
  if (q.unassigned === '1') where.push('NOT EXISTS (SELECT 1 FROM job_event_staff s WHERE s.event_id = e.id)');
  return withConflicts(db, companyId, eventRows(db, where.join(' AND '), params));
}

function readTimes(body, current) {
  const allDay = 'allDay' in body ? !!body.allDay : current.allDay;
  const start = body.start ?? current.start;
  const end = body.end ?? current.end;
  if (allDay) {
    if (!D.isDate(start) || !D.isDate(end)) throw badRequest('All-day events need start and end dates.');
    if (end < start) throw badRequest('The end date is before the start date.');
  } else {
    if (!D.isDateTime(start) || !D.isDateTime(end)) throw badRequest('Timed events need a start and end time.');
    if (D.absMin(end) <= D.absMin(start)) throw badRequest('The end time must be after the start time.');
  }
  return { allDay, start, end };
}

function setStaff(db, companyId, eventId, staffIds) {
  const ids = [...new Set((staffIds || []).map(Number).filter(Boolean))];
  if (ids.length) {
    const ok = db.all(`SELECT id FROM staff WHERE company_id = ? AND id IN (${ids.join(',')})`, companyId).map((r) => r.id);
    if (ok.length !== ids.length) throw badRequest('Unknown staff member.');
  }
  db.run('DELETE FROM job_event_staff WHERE event_id = ?', eventId);
  for (const sid of ids) db.run('INSERT INTO job_event_staff (event_id, staff_id) VALUES (?, ?)', eventId, sid);
}

export function createEvent(db, actor, company, body) {
  const job = db.get('SELECT * FROM jobs WHERE id = ? AND company_id = ?', Number(body.jobId), company.id);
  if (!job) throw badRequest('Choose a job for this event.');
  const type = db.get('SELECT * FROM event_types WHERE company_id = ? AND key = ?', company.id, body.typeKey || '');
  const title = String(body.title || type?.name || '').trim();
  if (!title) throw badRequest('Give the event a title.');
  const t = readTimes(body, { allDay: false });
  const status = ['proposed', 'pending', 'confirmed'].includes(body.status) ? body.status : 'pending';
  return db.tx(() => {
    const ts = nowIso();
    const id = Number(db.run(`INSERT INTO job_events (company_id, job_id, type_key, title, status, included, reason, all_day, start_at, end_at, location, notes, reminder_minutes, sort, created_by, created_at, updated_by, updated_at)
                              VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 99, ?, ?, ?, ?)`,
      company.id, job.id, type ? type.key : 'other', title, status, 'Added manually.', t.allDay ? 1 : 0, t.start, t.end,
      body.location || job.site_address || null, body.notes || null, body.reminderMinutes ?? type?.reminder_minutes ?? 1440, actor.id, ts, actor.id, ts).lastInsertRowid);
    setStaff(db, company.id, id, body.staffIds);
    audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: job.id, action: 'event_added', detail: { title, start: t.start } });
    return getEvent(db, company.id, id);
  });
}

export function updateEvent(db, actor, company, id, body) {
  const cur = getEvent(db, company.id, id);
  const t = readTimes(body, cur);
  const status = body.status ?? cur.status;
  if (!EVENT_STATUSES.includes(status)) throw badRequest('Unknown status.');
  if (cur.status !== 'proposed' && status === 'proposed') throw badRequest('Scheduled events cannot go back to proposed.');
  const title = 'title' in body ? String(body.title || '').trim() : cur.title;
  if (!title) throw badRequest('Give the event a title.');
  const moved = t.start !== cur.start || t.end !== cur.end;
  return db.tx(() => {
    db.run(`UPDATE job_events SET title = ?, status = ?, included = ?, all_day = ?, start_at = ?, end_at = ?, location = ?, notes = ?, reminder_minutes = ?,
            reminder_dismissed_at = ?, completed_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      title, status, 'included' in body ? (body.included ? 1 : 0) : (cur.included ? 1 : 0), t.allDay ? 1 : 0, t.start, t.end,
      'location' in body ? body.location || null : cur.location || null, 'notes' in body ? body.notes || null : cur.notes || null,
      'reminderMinutes' in body ? (body.reminderMinutes === null || body.reminderMinutes === '' ? null : Number(body.reminderMinutes)) : cur.reminderMinutes,
      moved || status !== cur.status ? null : cur.reminderDismissedAt,
      status === 'completed' ? (cur.completedAt || nowIso()) : null, actor.id, nowIso(), id);
    if ('staffIds' in body) setStaff(db, company.id, id, body.staffIds);
    const changes = [moved ? `moved to ${t.start}` : '', status !== cur.status ? `status ${cur.status} → ${status}` : '', 'staffIds' in body ? 'staff updated' : ''].filter(Boolean);
    if (cur.status !== 'proposed' && changes.length) audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: cur.jobId, action: 'event_updated', detail: { title, changes: changes.join(', ') } });
    return getEvent(db, company.id, id);
  });
}

export function deleteEvent(db, actor, company, id) {
  const cur = getEvent(db, company.id, id);
  if (cur.status === 'proposed' || cur.status === 'cancelled') db.run('DELETE FROM job_events WHERE id = ?', id);
  else db.run("UPDATE job_events SET status = 'cancelled', updated_by = ?, updated_at = ? WHERE id = ?", actor.id, nowIso(), id);
  audit(db, { companyId: company.id, userId: actor.id, entity: 'job', entityId: cur.jobId, action: 'event_cancelled', detail: { title: cur.title } });
}

// ---------------- reminders ----------------

/** Due reminders: upcoming within each event's reminder window, and past events not marked completed. */
export function reminders(db, companyId, now = D.nowLocal()) {
  const nowMin = D.absMin(now);
  const rows = eventRows(db, `e.company_id = ? AND j.archived_at IS NULL AND e.status IN ('pending','confirmed') AND e.reminder_dismissed_at IS NULL
                              AND e.start_at <= ? AND e.end_at >= ?`, [companyId, `${D.addDays(D.dateOf(now), 30)}T99`, D.addDays(D.dateOf(now), -30)]);
  const out = [];
  for (const e of rows) {
    const [s, en] = D.span(e);
    if (en <= nowMin) out.push({ ...e, kind: 'needs_completion', minutes: Math.round((nowMin - en)) });
    else if (s - (e.reminderMinutes ?? 1440) <= nowMin) out.push({ ...e, kind: s <= nowMin ? 'in_progress' : 'upcoming', minutes: Math.round(s - nowMin), needsConfirmation: e.status === 'pending' });
  }
  return out.sort((a, b) => (a.kind === 'needs_completion') - (b.kind === 'needs_completion') || a.minutes - b.minutes);
}

export function dismissReminder(db, actor, company, id) {
  getEvent(db, company.id, id);
  db.run('UPDATE job_events SET reminder_dismissed_at = ? WHERE id = ?', nowIso(), id);
}

/** Upcoming scheduled events for the dashboard. */
export function upcoming(db, companyId, days = 7) {
  const from = D.today(), to = D.addDays(from, days);
  return listEvents(db, companyId, { from, to, status: 'pending,confirmed' });
}

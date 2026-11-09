// API surface. Every handler receives ctx = { req, res, db, params, query, body, user, company, token }.
import path from 'node:path';
import fs from 'node:fs';
import * as backups from './services/backup.service.js';
import { backupNow, listBackups, backupPath } from './services/backup.service.js';
import * as statuses from './services/statuses.service.js';
import * as email from './services/email.service.js';
import { config } from './config.js';
import { createRouter, badRequest, forbidden, unauthorized, notFound, HttpError } from './http/http.js';
import { loginBlocked, recordLoginFailure, clearLoginFailures } from './http/security.js';
import { setupKey, setupKeyMatches, clearSetupKey, printSetupBanner } from './services/setupkey.service.js';
import * as acct from './services/account.service.js';
import * as pb from './services/pricebook.service.js';
import * as jobs from './services/jobs.service.js';
import * as quotes from './services/quotes.service.js';
import { dashboard, drillDown } from './services/reports.service.js';
import { checkPrices } from './services/pricecheck.service.js';
import * as sched from './services/schedule.service.js';
import { listAudit } from './services/audit.service.js';
import { audit } from './services/audit.service.js';

const r = createRouter();

const WRONG_KEY = 'That setup key is not right. Copy it again from Render: your service → Logs → the line "FIRST-TIME SETUP KEY". Capitals and dashes do not matter.';

/** Check the first-time setup key, with the same throttle as sign-in (5 wrong tries per 15 minutes per address). */
function requireSetupKey(ctx) {
  if (!acct.needsSetup(ctx.db) || !setupKey()) return;
  const key = `setup|${ctx.ip}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Too many wrong setup keys. Wait 15 minutes, then try again.');
  if (!setupKeyMatches(ctx.body.setupKey)) {
    recordLoginFailure(key);
    printSetupBanner('Someone just typed a wrong setup key. The correct key is shown above.');
    throw new HttpError(403, WRONG_KEY, { field: 'setupKey' });
  }
  clearLoginFailures(key);
}

const auth = (ctx) => { if (!ctx.user) throw unauthorized(); };
const role = (...roles) => (ctx) => { auth(ctx); if (!roles.includes(ctx.user.role)) throw forbidden(); };
const manager = role('owner', 'admin');
const owner = role('owner');
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id.'); return n; };
const settings = (company) => jobs.pricingSettings(company);

// Backup/restore errors carry a status and the field to highlight; pass them on as normal API errors.
const asHttp = (fn) => { try { return fn(); } catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(err.status || 400, err.message, { field: err.field, problems: err.problems }); } };
const asHttpAsync = async (fn) => { try { return await fn(); } catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(err.status || 400, err.message, { field: err.field, problems: err.problems }); } };

// ---- session ----
r.get('/api/state', (ctx) => {
  const company = ctx.company ? acct.companySettings(ctx.company) : null;
  if (company) { company.hasLogo = !!company.quoteLogo; delete company.quoteLogo; } // the picture itself is loaded by Settings only
  return {
    app: { name: config.appName, version: config.version, environment: config.appEnv, emailEnabled: email.emailEnabled() },
    setupRequired: acct.needsSetup(ctx.db),
    setupKeyRequired: acct.needsSetup(ctx.db) && !!setupKey(),
    user: ctx.user ? acct.publicUser(ctx.user) : null,
    company,
    statuses: ctx.company ? statuses.listStatuses(ctx.db, ctx.company.id, { includeInactive: true }) : [],
  };
});
// Lets the setup screen confirm the key straight away, before the rest of the form is filled in.
r.post('/api/setup/check-key', (ctx) => { requireSetupKey(ctx); return { ok: true }; });
r.post('/api/setup', (ctx) => {
  requireSetupKey(ctx);
  acct.setup(ctx.db, ctx.body);
  clearSetupKey();
  return { ok: true };
});
// A brand-new site can start from a backup instead of a new company: check the backup (step 1), then restore (step 2).
// The setup key travels in a header because the backup file itself is the request body.
const setupKeyFromHeader = (ctx) => { ctx.body = { ...ctx.body, setupKey: ctx.body.setupKey ?? ctx.req.headers['x-setup-key'] }; requireSetupKey(ctx); };
const setupOnly = (ctx) => { if (!acct.needsSetup(ctx.db)) throw new HttpError(409, 'This website is already set up. To restore over it, sign in as the owner and use Settings → Backups.'); };
/** The backup to check: an uploaded file, a backup on this server (owner only), or an off-site backup (named, or the latest). */
async function backupToCheck(ctx, { allowServer = false } = {}) {
  if (ctx.rawBody) return { buf: ctx.rawBody, source: `uploaded file ${String(ctx.req.headers['x-file-name'] || '').slice(0, 120)}`.trim() };
  if (allowServer && ctx.body.serverBackup) {
    const file = backupPath(ctx.body.serverBackup);
    if (!file) throw notFound('Backup not found.');
    return { buf: fs.readFileSync(file), source: `backup on this server: ${ctx.body.serverBackup}` };
  }
  let key = ctx.body.offsiteKey ? String(ctx.body.offsiteKey) : null;
  if (!key && ctx.body.offsiteLatest) {
    const list = await asHttpAsync(() => backups.listOffsite({ limit: 1 }));
    if (!list.length) throw badRequest('No off-site backups were found in the storage bucket.');
    key = list[0].key;
  }
  if (!key) throw badRequest('Choose a backup file.');
  return { buf: await asHttpAsync(() => backups.downloadOffsite(key)), source: `off-site ${key}` };
}
const backupKeyOf = (ctx) => String(ctx.req.headers['x-backup-key'] || ctx.body.backupKey || '');

r.post('/api/setup/restore/check', async (ctx) => {
  setupOnly(ctx);
  setupKeyFromHeader(ctx);
  const { buf, source } = await backupToCheck(ctx);
  return asHttp(() => backups.stageRestore(buf, { passphrase: backupKeyOf(ctx), source }));
});
r.post('/api/setup/restore/apply', (ctx) => {
  setupOnly(ctx);
  requireSetupKey(ctx);
  const out = asHttp(() => backups.applyRestore(ctx.db, String(ctx.body.token || ''), { keepSafetyCopy: false }));
  afterRestore(ctx, out, null);
  clearSetupKey();
  return { ok: true, summary: out.summary };
});
r.get('/api/setup/restore/offsite', async (ctx) => {
  setupOnly(ctx);
  ctx.body = { setupKey: ctx.req.headers['x-setup-key'] };
  requireSetupKey(ctx);
  return asHttpAsync(() => backups.listOffsite({ limit: 30 }));
});

/** After any restore: make sure the restored data has this version's defaults, and record it in the restored log. */
function afterRestore(ctx, out, actor) {
  sched.ensureAllDefaults(ctx.db);
  statuses.ensureAllStatusDefaults(ctx.db);
  const companyId = ctx.db.get('SELECT id FROM companies ORDER BY id LIMIT 1')?.id;
  audit(ctx.db, { companyId, userId: null, entity: 'system', action: 'restore',
    detail: { source: out.source, by: actor ? `${actor.name} (${actor.email})` : 'first-time setup screen', safetyCopy: out.safetyCopy, counts: out.summary.counts, lastActivity: out.summary.lastActivity } });
  ctx.clearCookie();
  backups.offsiteSoon(ctx.db, 5000);
  email.notify(ctx.db, { subject: 'The database was restored from a backup',
    text: `The live data was replaced with a backup.\n\nFrom: ${out.source}\nBy: ${actor ? `${actor.name} (${actor.email})` : 'the first-time setup screen'}\nJobs: ${out.summary.counts?.jobs ?? '?'}, quotes: ${out.summary.counts?.quotes ?? '?'}\nLast activity in the backup: ${out.summary.lastActivity || '—'}${out.safetyCopy ? `\nThe data from just before the restore was kept as ${out.safetyCopy}.` : ''}\n\nEveryone has been signed out and signs in again.` });
}
r.post('/api/login', (ctx) => {
  const { token, user } = acct.login(ctx.db, { ...ctx.body, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] }, config.sessionHours);
  ctx.setCookie(token);
  return { user };
});
r.post('/api/logout', (ctx) => { acct.logout(ctx.db, ctx.token); ctx.clearCookie(); return { ok: true }; });
// Health check for the hosting service: the program is running and the database answers.
r.get('/healthz', (ctx) => { ctx.db.get('SELECT 1 AS ok'); return { ok: true, version: config.version }; });
// Forgotten password: always the same answer (so nobody can find out which emails have accounts); throttled per address.
r.post('/api/password/forgot', (ctx) => {
  if (!email.emailEnabled()) throw badRequest('Email is not set up on this site. Ask an owner to reset your password from Settings → Users & access.');
  const key = `forgot|${ctx.ip}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Too many requests. Wait 15 minutes, then try again.');
  recordLoginFailure(key);
  const started = acct.createPasswordReset(ctx.db, ctx.body.email);
  if (started) email.resetLinkEmail({ user: started.user, token: started.token, company: ctx.db.get('SELECT name FROM companies WHERE id = ?', started.user.company_id)?.name, minutes: acct.RESET_MINUTES });
  return { ok: true };
});
r.post('/api/password/reset', async (ctx) => {
  const user = acct.resetPasswordWithToken(ctx.db, ctx.body.token, ctx.body.password);
  await email.passwordChangedEmail({ user, company: ctx.db.get('SELECT name FROM companies WHERE id = ?', user.company_id)?.name });
  return { ok: true, email: user.email };
});
r.post('/api/account/password', auth, (ctx) => { acct.changePassword(ctx.db, ctx.user, ctx.body); return { ok: true }; });

// ---- company & users ----
r.get('/api/company', auth, (ctx) => acct.companySettings(ctx.company));
r.put('/api/company', manager, (ctx) => acct.updateCompany(ctx.db, ctx.user, ctx.body));
r.get('/api/users', manager, (ctx) => acct.listUsers(ctx.db, ctx.company.id));
r.get('/api/designers', auth, (ctx) => acct.listUsers(ctx.db, ctx.company.id).filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })));
// New users and password resets by an owner: the person is emailed their sign-in details when email is set up.
r.post('/api/users', owner, async (ctx) => {
  const user = acct.createUser(ctx.db, ctx.user, ctx.body);
  const mail = await email.welcomeEmail({ user, tempPassword: ctx.body.password, company: ctx.company.name, by: ctx.user.name });
  return { ...user, emailSent: mail.sent, emailError: mail.sent ? undefined : mail.error };
});
r.put('/api/users/:id', owner, async (ctx) => {
  const user = acct.updateUser(ctx.db, ctx.user, id(ctx.params.id), ctx.body);
  if (!ctx.body.password) return user;
  const mail = await email.adminResetEmail({ user, tempPassword: ctx.body.password, company: ctx.company.name, by: ctx.user.name });
  return { ...user, emailSent: mail.sent, emailError: mail.sent ? undefined : mail.error };
});
r.get('/api/admin/email', owner, () => ({ enabled: email.emailEnabled(), host: config.smtp.host, port: config.smtp.port, from: config.smtp.fromEmail, appUrl: config.appUrl, notify: config.notifyEmail || 'all owners' }));
r.post('/api/admin/email/test', owner, async (ctx) => {
  const to = String(ctx.body.to || ctx.user.email).trim();
  try { await email.testEmail({ to, company: ctx.company.name, by: ctx.user.name }); } catch (err) { throw badRequest(`The test email was not sent: ${err.message}`); }
  audit(ctx.db, { companyId: ctx.company.id, userId: ctx.user.id, entity: 'system', action: 'email_test', detail: { to } });
  return { ok: true, to };
});
r.get('/api/audit', manager, (ctx) => listAudit(ctx.db, ctx.company.id, { limit: 200 }));

// ---- templates ----
r.get('/api/templates', auth, (ctx) => acct.listTemplates(ctx.db, ctx.company.id));
r.post('/api/templates', manager, (ctx) => ({ id: acct.saveTemplate(ctx.db, ctx.user, ctx.body) }));
r.delete('/api/templates/:id', manager, (ctx) => { acct.deleteTemplate(ctx.db, ctx.user, id(ctx.params.id)); return { ok: true }; });

// ---- price books ----
r.get('/api/price-books', auth, (ctx) => ({ books: pb.listBooks(ctx.db, ctx.company.id), currentId: pb.currentPublished(ctx.db, ctx.company.id)?.id || null }));
r.get('/api/price-books/:id', auth, (ctx) => pb.loadBook(ctx.db, ctx.company.id, id(ctx.params.id)));
r.post('/api/price-books/:id/clone', manager, (ctx) => ({ id: pb.cloneBook(ctx.db, ctx.company.id, id(ctx.params.id), { userId: ctx.user.id, label: ctx.body.label }) }));
r.post('/api/price-books/:id/changes', manager, (ctx) => pb.applyChanges(ctx.db, ctx.company.id, id(ctx.params.id), ctx.body.changes, { userId: ctx.user.id }));
r.get('/api/price-books/:id/validate', manager, (ctx) => ({ problems: pb.validateBook(pb.loadBook(ctx.db, ctx.company.id, id(ctx.params.id))) }));
r.get('/api/price-books/:id/diff', auth, (ctx) => pb.diff(ctx.db, ctx.company.id, id(ctx.params.id), ctx.query.against ? id(ctx.query.against) : null));
r.get('/api/price-books/:id/impact', manager, (ctx) => pb.publishImpact(ctx.db, ctx.company.id, id(ctx.params.id), settings(ctx.company)));
// Price integrity check against the spreadsheet (the one bundled with the app, or an uploaded .xlsx).
r.post('/api/price-books/:id/price-check', manager, (ctx) => {
  let source;
  if (ctx.body.file) {
    source = Buffer.from(String(ctx.body.file), 'base64');
    if (source.length < 4 || source.readUInt32LE(0) !== 0x04034b50) throw badRequest('Choose an .xlsx spreadsheet file.');
  }
  return checkPrices(ctx.db, ctx.company.id, id(ctx.params.id), source ? { source, sourceName: String(ctx.body.fileName || 'Uploaded spreadsheet').slice(0, 200) } : {});
});
// Publish; only the open jobs listed in applyToJobIds move to the new prices (none unless chosen).
r.post('/api/price-books/:id/publish', manager, (ctx) => {
  const out = jobs.publishAndApply(ctx.db, ctx.user, ctx.company, id(ctx.params.id), { effectiveFrom: ctx.body.effectiveFrom, applyToJobIds: ctx.body.applyToJobIds });
  backups.offsiteSoon(ctx.db);
  return { ...out.book, publishResult: { applied: out.applied, kept: out.kept } };
});
r.post('/api/price-books/:id/archive', manager, (ctx) => { pb.archiveBook(ctx.db, ctx.company.id, id(ctx.params.id), { userId: ctx.user.id }); return { ok: true }; });
r.delete('/api/price-books/:id', manager, (ctx) => { pb.deleteDraft(ctx.db, ctx.company.id, id(ctx.params.id), { userId: ctx.user.id }); return { ok: true }; });
r.get('/api/price-books/:id/export', manager, (ctx) => {
  const book = pb.loadBook(ctx.db, ctx.company.id, id(ctx.params.id));
  ctx.download(`price-book-${book.id}-${book.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`, { format: 'joinery-pricing-price-book', formatVersion: 1, exportedAt: new Date().toISOString(), book });
});
r.post('/api/price-books/import', manager, (ctx) => {
  const f = ctx.body;
  if (!f || f.format !== 'joinery-pricing-price-book' || !f.book) throw badRequest('This is not a price book file exported from this program.');
  return { id: pb.insertBook(ctx.db, ctx.company.id, { ...f.book, label: `${f.book.label} (imported)`, effectiveFrom: null }, { userId: ctx.user.id }) };
});

// ---- jobs ----
r.get('/api/jobs', auth, (ctx) => jobs.listJobs(ctx.db, ctx.company.id, { q: ctx.query.q || '', status: ctx.query.status || '', archived: ctx.query.archived === '1' }));
// Every new job gets a rule-driven schedule proposal (reviewed and confirmed on the job's Schedule tab).
const withSchedule = (ctx, jid) => { sched.proposeSchedule(ctx.db, ctx.user, ctx.company, jid); return jid; };
r.post('/api/jobs', auth, (ctx) => ({ id: withSchedule(ctx, jobs.createJob(ctx.db, ctx.user, ctx.company, ctx.body)) }));
r.get('/api/jobs/:id', auth, (ctx) => jobs.jobPayload(ctx.db, ctx.company, id(ctx.params.id)));
r.put('/api/jobs/:id', auth, (ctx) => {
  const jid = id(ctx.params.id);
  const before = ctx.db.get('SELECT status FROM jobs WHERE id = ? AND company_id = ?', jid, ctx.company.id);
  jobs.saveJob(ctx.db, ctx.user, ctx.company, jid, ctx.body);
  if (before && before.status !== 'lost' && ctx.body.status === 'lost') sched.cancelOpenEvents(ctx.db, ctx.user, ctx.company, jid);
  return jobs.jobPayload(ctx.db, ctx.company, jid);
});
r.post('/api/jobs/:id/save-as', auth, (ctx) => ({ id: withSchedule(ctx, jobs.saveJobAs(ctx.db, ctx.user, ctx.company, id(ctx.params.id), ctx.body)) }));
r.post('/api/jobs/:id/archive', auth, (ctx) => { jobs.setArchived(ctx.db, ctx.user, ctx.company, id(ctx.params.id), true); return { ok: true }; });
r.post('/api/jobs/:id/restore', auth, (ctx) => { jobs.setArchived(ctx.db, ctx.user, ctx.company, id(ctx.params.id), false); return { ok: true }; });
r.get('/api/jobs/:id/export', auth, (ctx) => {
  const data = jobs.exportJob(ctx.db, ctx.user, ctx.company, id(ctx.params.id));
  ctx.download(`${data.job.jobNumber} ${data.job.name}`.replace(/[^a-z0-9 \-]+/gi, '').trim() + '.job.json', data);
});
r.post('/api/jobs/import', auth, (ctx) => { const out = jobs.importJob(ctx.db, ctx.user, ctx.company, ctx.body); withSchedule(ctx, out.id); return out; });
r.get('/api/jobs/:id/reprice', auth, (ctx) => jobs.repricePreview(ctx.db, ctx.company, id(ctx.params.id), id(ctx.query.to)));
r.post('/api/jobs/:id/reprice', auth, (ctx) => { const jid = id(ctx.params.id); jobs.applyReprice(ctx.db, ctx.user, ctx.company, jid, id(ctx.body.to), ctx.body.revision); return jobs.jobPayload(ctx.db, ctx.company, jid); });
r.get('/api/jobs/:id/history', auth, (ctx) => listAudit(ctx.db, ctx.company.id, { entity: 'job', entityId: id(ctx.params.id), limit: 1000 }));

// ---- quotes ----
r.get('/api/jobs/:id/quotes', auth, (ctx) => quotes.listQuotes(ctx.db, ctx.company.id, id(ctx.params.id)));
r.post('/api/jobs/:id/quotes', auth, (ctx) => { const q = quotes.createQuote(ctx.db, ctx.user, ctx.company, id(ctx.params.id), ctx.body); backups.offsiteSoon(ctx.db); return q; });
// Manual status only: no job status change, no schedule changes, nothing sent.
r.post('/api/quotes/:id/status', auth, (ctx) => { quotes.setQuoteStatus(ctx.db, ctx.user, ctx.company, id(ctx.params.id), ctx.body.status); return { ok: true }; });

// ---- scheduling ----
r.get('/api/schedule/meta', auth, (ctx) => {
  sched.ensureDefaults(ctx.db, ctx.company.id);
  return { types: sched.listEventTypes(ctx.db, ctx.company.id), staff: sched.listStaff(ctx.db, ctx.company.id), categories: sched.STAFF_CATEGORIES, rules: sched.RULES };
});
r.get('/api/staff', auth, (ctx) => sched.listStaff(ctx.db, ctx.company.id, { includeInactive: ctx.query.all === '1' }));
r.post('/api/staff', manager, (ctx) => ({ id: sched.saveStaff(ctx.db, ctx.user, { ...ctx.body, id: undefined }) }));
r.put('/api/staff/:id', manager, (ctx) => ({ id: sched.saveStaff(ctx.db, ctx.user, { ...ctx.body, id: id(ctx.params.id) }) }));
r.get('/api/leave', auth, (ctx) => sched.listLeave(ctx.db, ctx.company.id, ctx.query.from, ctx.query.to));
r.post('/api/leave', manager, (ctx) => ({ id: sched.addLeave(ctx.db, ctx.user, ctx.body) }));
r.delete('/api/leave/:id', manager, (ctx) => { sched.deleteLeave(ctx.db, ctx.user, id(ctx.params.id)); return { ok: true }; });
r.put('/api/event-types/:key', manager, (ctx) => { sched.updateEventType(ctx.db, ctx.user, ctx.params.key, ctx.body); return sched.listEventTypes(ctx.db, ctx.company.id); });
r.post('/api/event-types', manager, (ctx) => { const key = sched.createEventType(ctx.db, ctx.user, ctx.body); return { key, types: sched.listEventTypes(ctx.db, ctx.company.id) }; });
r.delete('/api/event-types/:key', manager, (ctx) => { const out = sched.deleteEventType(ctx.db, ctx.user, ctx.params.key); return { ...out, types: sched.listEventTypes(ctx.db, ctx.company.id) }; });
r.get('/api/events', auth, (ctx) => sched.listEvents(ctx.db, ctx.company.id, ctx.query));
r.post('/api/events', auth, (ctx) => sched.createEvent(ctx.db, ctx.user, ctx.company, ctx.body));
r.put('/api/events/:id', auth, (ctx) => sched.updateEvent(ctx.db, ctx.user, ctx.company, id(ctx.params.id), ctx.body));
r.delete('/api/events/:id', auth, (ctx) => { sched.deleteEvent(ctx.db, ctx.user, ctx.company, id(ctx.params.id)); return { ok: true }; });
r.post('/api/events/:id/dismiss', auth, (ctx) => { sched.dismissReminder(ctx.db, ctx.user, ctx.company, id(ctx.params.id)); return { ok: true }; });
r.get('/api/reminders', auth, (ctx) => sched.reminders(ctx.db, ctx.company.id));
r.get('/api/jobs/:id/schedule', auth, (ctx) => {
  const jid = id(ctx.params.id);
  let events = sched.getJobSchedule(ctx.db, ctx.company.id, jid);
  if (!events.length) events = sched.proposeSchedule(ctx.db, ctx.user, ctx.company, jid); // jobs created before scheduling existed
  return events;
});
r.post('/api/jobs/:id/schedule/propose', auth, (ctx) => sched.proposeSchedule(ctx.db, ctx.user, ctx.company, id(ctx.params.id)));
r.post('/api/jobs/:id/schedule/confirm', auth, (ctx) => sched.confirmSchedule(ctx.db, ctx.user, ctx.company, id(ctx.params.id)));
r.get('/quotes/:id', auth, (ctx) => ctx.html(quotes.renderQuoteHtml(ctx.db, ctx.company.id, id(ctx.params.id))));

// ---- costs ----
r.get('/api/jobs/:id/costs', auth, (ctx) => {
  const jid = id(ctx.params.id);
  return { costs: jobs.listCosts(ctx.db, ctx.company.id, jid), budget: jobs.budgetVsActual(ctx.db, ctx.company, jid), codes: jobs.COST_CODES };
});
r.post('/api/jobs/:id/costs', auth, (ctx) => ({ id: jobs.addCost(ctx.db, ctx.user, ctx.company, id(ctx.params.id), ctx.body) }));
r.delete('/api/jobs/:id/costs/:costId', auth, (ctx) => { jobs.deleteCost(ctx.db, ctx.user, ctx.company, id(ctx.params.id), id(ctx.params.costId)); return { ok: true }; });

// ---- reports & admin ----
r.get('/api/dashboard', auth, (ctx) => ({ ...dashboard(ctx.db, ctx.company.id), upcoming: sched.upcoming(ctx.db, ctx.company.id, 7) }));
// Records behind a dashboard figure, loaded only when that figure is clicked.
r.get('/api/dashboard/drill', auth, (ctx) => drillDown(ctx.db, ctx.company.id, String(ctx.query.metric || ''), { period: ['all', '12m', 'year', 'month'].includes(ctx.query.period) ? ctx.query.period : 'all' }));
r.get('/api/admin/backups', owner, () => listBackups());
r.post('/api/admin/backups', owner, (ctx) => {
  const file = backupNow(ctx.db);
  audit(ctx.db, { companyId: ctx.company.id, userId: ctx.user.id, entity: 'system', action: 'backup', detail: { file: path.basename(file) } });
  return listBackups();
});
r.get('/api/admin/backups/:name', owner, (ctx) => {
  const file = backupPath(ctx.params.name);
  if (!file) throw notFound('Backup not found.');
  audit(ctx.db, { companyId: ctx.company.id, userId: ctx.user.id, entity: 'system', action: 'backup_download', detail: { file: ctx.params.name } });
  ctx.sendFile(file, ctx.params.name);
});
r.get('/api/admin/info', owner, (ctx) => ({ dataDir: config.dataDir, dbFile: config.dbFile, host: config.host, port: config.port, node: process.version, version: config.version, environment: config.appEnv }));
// Off-site backups: status, run now, and the list available to restore (needs a key that can read the bucket).
r.get('/api/admin/offsite', owner, () => backups.offsiteStatus());
r.post('/api/admin/offsite/run', owner, async (ctx) => {
  const out = await backups.offsiteTick(ctx.db, { force: true });
  if (out.skipped) throw badRequest(`${out.reason} The settings needed are listed in docs/backup-strategy.md.`);
  audit(ctx.db, { companyId: ctx.company.id, userId: ctx.user.id, entity: 'system', action: 'offsite_backup', detail: { ok: out.ok, uploaded: out.uploaded, error: out.error } });
  if (!out.ok) throw new HttpError(502, `Off-site backup failed: ${out.error}`);
  return backups.offsiteStatus();
});
r.get('/api/admin/offsite/list', owner, () => asHttpAsync(() => backups.listOffsite({ limit: 60 })));
// Restore over this site (owner only): check the backup first, then restore with the owner's password.
r.post('/api/admin/restore/check', owner, async (ctx) => {
  const { buf, source } = await backupToCheck(ctx, { allowServer: true });
  const staged = asHttp(() => backups.stageRestore(buf, { passphrase: backupKeyOf(ctx), source }));
  audit(ctx.db, { companyId: ctx.company.id, userId: ctx.user.id, entity: 'system', action: 'restore_checked', detail: { source, ok: true, counts: staged.summary.counts } });
  return staged;
});
r.post('/api/admin/restore/apply', owner, (ctx) => {
  if (!acct.passwordMatches(ctx.user, ctx.body.password)) throw new HttpError(403, 'Your password is not right.', { field: 'password' });
  const actor = { name: ctx.user.name, email: ctx.user.email };
  const out = asHttp(() => backups.applyRestore(ctx.db, String(ctx.body.token || '')));
  afterRestore(ctx, out, actor);
  return { ok: true, safetyCopy: out.safetyCopy, summary: out.summary };
});

// ---- job statuses (names and variations) ----
r.get('/api/statuses', auth, (ctx) => statuses.listStatuses(ctx.db, ctx.company.id, { includeInactive: ctx.query.all === '1' }));
r.post('/api/statuses', manager, (ctx) => { statuses.saveStatus(ctx.db, ctx.user, { ...ctx.body, key: undefined }); return statuses.listStatuses(ctx.db, ctx.company.id, { includeInactive: true }); });
r.put('/api/statuses/:key', manager, (ctx) => { statuses.saveStatus(ctx.db, ctx.user, { ...ctx.body, key: ctx.params.key }); return statuses.listStatuses(ctx.db, ctx.company.id, { includeInactive: true }); });
r.delete('/api/statuses/:key', manager, (ctx) => { statuses.deleteStatus(ctx.db, ctx.user, ctx.params.key); return statuses.listStatuses(ctx.db, ctx.company.id, { includeInactive: true }); });

export { backupNow };
export const router = r;

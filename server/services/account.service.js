// Company, users, sessions and first-run setup.
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../http/http.js';
import { hashPassword, verifyPassword, passwordProblem, newToken, tokenHash, loginBlocked, recordLoginFailure, clearLoginFailures } from '../http/security.js';
import { audit } from './audit.service.js';
import { insertBook, starterBook } from './pricebook.service.js';
import { buildLegacyPriceBook, DEFAULT_TEMPLATES } from '../seed/legacy-import.js';
import { buildMaterialLabourBook } from '../seed/material-labour-import.js';
import { ensureDefaults } from './schedule.service.js';
import { ensureStatusDefaults } from './statuses.service.js';
import { DEFAULT_INCLUSIONS, DEFAULT_TERMS, withCompany } from '../seed/quote-defaults.js';

const now = () => new Date().toISOString();
const ROLES = ['owner', 'admin', 'designer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const needsSetup = (db) => !db.get('SELECT 1 FROM users LIMIT 1');

export function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active, mustChangePassword: !!u.must_change_password, lastLoginAt: u.last_login_at, createdAt: u.created_at };
}

export function companySettings(c) {
  return c && {
    id: c.id, name: c.name, legalName: c.legal_name || '', abn: c.abn || '', address: c.address || '', phone: c.phone || '', email: c.email || '', website: c.website || '',
    jobPrefix: c.job_prefix, gstRate: c.gst_rate, floorMargin: c.floor_margin, quoteValidityDays: c.quote_validity_days, quoteTerms: c.quote_terms || '', currency: c.currency,
    licenceNo: c.licence_no || '', quoteInclusions: c.quote_inclusions || '', quoteLogo: c.quote_logo || '',
  };
}

// Quote logo: a small picture stored with the company (PNG, JPEG or WebP, up to 600 KB).
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** First run: create the company, the owner account, the first price book and area templates. */
export function setup(db, body) {
  if (!needsSetup(db)) throw conflict('This website is already set up. Go to the sign-in page and sign in.');
  const companyName = String(body.companyName || '').trim();
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  if (!companyName) throw badRequest('Enter your company name.', { field: 'companyName' });
  if (!name) throw badRequest('Enter your name.', { field: 'name' });
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address, for example alex@vicello.com.au.', { field: 'email' });
  const pw = passwordProblem(body.password);
  if (pw) throw badRequest(`Password: ${pw}`, { field: 'password' });
  const prefix = String(body.jobPrefix || companyName.replace(/[^A-Za-z]/g, '').slice(0, 3) || 'JOB').toUpperCase().slice(0, 6);

  return db.tx(() => {
    const ts = now();
    const companyId = Number(db.run(
      `INSERT INTO companies (name, job_prefix, quote_terms, quote_inclusions, created_at) VALUES (?, ?, ?, ?, ?)`,
      companyName, prefix, withCompany(DEFAULT_TERMS, companyName), withCompany(DEFAULT_INCLUSIONS, companyName), ts).lastInsertRowid);
    const userId = Number(db.run(
      `INSERT INTO users (company_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'owner', ?, ?)`,
      companyId, email, name, hashPassword(body.password), ts).lastInsertRowid);
    // Default: the Material + Labour cost book. 'legacy' = the V0.1 workbook; 'starter' = a small example.
    const choice = ['starter', 'legacy'].includes(body.priceBook) ? body.priceBook : 'material-labour';
    const data = choice === 'starter' ? starterBook() : choice === 'legacy' ? buildLegacyPriceBook() : buildMaterialLabourBook().book;
    delete data.issues;
    insertBook(db, companyId, data, { userId, status: 'published' });
    if (choice !== 'starter') {
      DEFAULT_TEMPLATES.forEach((t, i) => db.run(
        'INSERT INTO area_templates (company_id, name, area_type, default_finish, lines_json, sort) VALUES (?, ?, ?, ?, ?, ?)',
        companyId, t.name, t.areaType, t.defaultFinish, JSON.stringify(t.lines.map((k) => ({ moduleKey: k, qty: 0 }))), i));
    }
    ensureDefaults(db, companyId);
    ensureStatusDefaults(db, companyId);
    audit(db, { companyId, userId, entity: 'company', entityId: companyId, action: 'setup', detail: { priceBook: choice } });
    return { companyId, userId };
  });
}

export function login(db, { email, password, ip, userAgent }, sessionHours) {
  const key = `${String(email || '').toLowerCase()}|${ip}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  const user = db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim());
  if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) {
    recordLoginFailure(key);
    if (user) audit(db, { companyId: user.company_id, userId: user.id, entity: 'user', entityId: user.id, action: 'login_failed', detail: { ip } });
    throw unauthorized('Email or password is incorrect.');
  }
  clearLoginFailures(key);
  const token = newToken();
  const ts = new Date();
  db.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    tokenHash(token), user.id, ts.toISOString(), new Date(ts.getTime() + sessionHours * 3600e3).toISOString(), ts.toISOString(), ip, String(userAgent || '').slice(0, 200));
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', ts.toISOString(), user.id);
  db.run('DELETE FROM sessions WHERE expires_at < ?', ts.toISOString());
  audit(db, { companyId: user.company_id, userId: user.id, entity: 'user', entityId: user.id, action: 'login', detail: { ip } });
  return { token, user: publicUser(user) };
}

/** Resolve a session token to { user, company }; slides expiry forward. */
export function sessionFor(db, token, sessionHours) {
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE id_hash = ?', tokenHash(token));
  if (!s) return null;
  const t = Date.now();
  if (Date.parse(s.expires_at) < t) { db.run('DELETE FROM sessions WHERE id_hash = ?', s.id_hash); return null; }
  const user = db.get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!user || !user.active) return null;
  if (t - Date.parse(s.last_seen_at) > 60e3) {
    db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', new Date(t).toISOString(), new Date(t + sessionHours * 3600e3).toISOString(), s.id_hash);
  }
  const company = db.get('SELECT * FROM companies WHERE id = ?', user.company_id);
  return { user, company };
}

// ---- Forgotten password (emailed link) ----
// Reset links are single-use, expire after RESET_MINUTES, and live only in memory (a restart cancels open links).
// Only a hash of each token is kept.
export const RESET_MINUTES = 60;
const resetTokens = new Map(); // tokenHash -> { userId, expires }

/** Start a reset for this email. Returns { user, token } for an active user, or null (the caller says the same either way). */
export function createPasswordReset(db, email) {
  const user = db.get('SELECT * FROM users WHERE email = ? AND active = 1', String(email || '').trim());
  if (!user) return null;
  for (const [k, v] of resetTokens) if (v.expires < Date.now() || v.userId === user.id) resetTokens.delete(k);
  const token = newToken();
  resetTokens.set(tokenHash(token), { userId: user.id, expires: Date.now() + RESET_MINUTES * 60e3 });
  audit(db, { companyId: user.company_id, userId: user.id, entity: 'user', entityId: user.id, action: 'password_reset_requested' });
  return { user, token };
}

/** Finish a reset: set the new password, sign the user out everywhere, record it. Returns the user. */
export function resetPasswordWithToken(db, token, newPassword) {
  const key = tokenHash(String(token || ''));
  const entry = resetTokens.get(key);
  if (!entry || entry.expires < Date.now()) { resetTokens.delete(key); throw badRequest('This reset link has expired or was already used. Ask for a new one from the sign-in page.'); }
  const pw = passwordProblem(newPassword);
  if (pw) throw badRequest(`Password: ${pw}`, { field: 'password' });
  const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', entry.userId);
  if (!user) throw badRequest('This account is disabled.');
  resetTokens.delete(key);
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(newPassword), user.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    audit(db, { companyId: user.company_id, userId: user.id, entity: 'user', entityId: user.id, action: 'password_reset_by_email' });
  });
  return user;
}

/** Re-check a signed-in user's password before a serious action (restoring a backup). */
export const passwordMatches = (user, password) => !!user && verifyPassword(String(password || ''), user.password_hash);

export function logout(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE id_hash = ?', tokenHash(token));
}

export function changePassword(db, user, { currentPassword, newPassword }) {
  if (!verifyPassword(String(currentPassword || ''), user.password_hash)) throw badRequest('Current password is incorrect.');
  const pw = passwordProblem(newPassword);
  if (pw) throw badRequest(`New password: ${pw}`);
  db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(newPassword), user.id);
  audit(db, { companyId: user.company_id, userId: user.id, entity: 'user', entityId: user.id, action: 'password_changed' });
}

// ---- Users (owner only) ----

export const listUsers = (db, companyId) => db.all('SELECT * FROM users WHERE company_id = ? ORDER BY active DESC, name', companyId).map(publicUser);

export function createUser(db, actor, body) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  if (!name) throw badRequest('Enter a name.');
  if (!EMAIL_RE.test(email)) throw badRequest('Enter a valid email address.');
  if (!ROLES.includes(body.role) || body.role === 'owner' && actor.role !== 'owner') throw badRequest('Choose a valid role.');
  const pw = passwordProblem(body.password);
  if (pw) throw badRequest(`Temporary password: ${pw}`);
  if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('A user with that email already exists.');
  const id = Number(db.run('INSERT INTO users (company_id, email, name, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    actor.company_id, email, name, body.role, hashPassword(body.password), now()).lastInsertRowid);
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'user', entityId: id, action: 'create', detail: { email, role: body.role } });
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
}

export function updateUser(db, actor, id, body) {
  const u = db.get('SELECT * FROM users WHERE id = ? AND company_id = ?', id, actor.company_id);
  if (!u) throw notFound('User not found.');
  const owners = db.get("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'owner' AND active = 1", actor.company_id).n;
  const losingOwner = u.role === 'owner' && u.active && ((body.role && body.role !== 'owner') || body.active === false);
  if (losingOwner && owners <= 1) throw conflict('There must be at least one active owner.');
  if (body.role && !ROLES.includes(body.role)) throw badRequest('Unknown role.');
  if (body.role === 'owner' && actor.role !== 'owner') throw forbidden();
  db.tx(() => {
    if (body.name) db.run('UPDATE users SET name = ? WHERE id = ?', String(body.name).trim(), id);
    if (body.role) db.run('UPDATE users SET role = ? WHERE id = ?', body.role, id);
    if (typeof body.active === 'boolean') {
      db.run('UPDATE users SET active = ? WHERE id = ?', body.active ? 1 : 0, id);
      if (!body.active) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (body.password) {
      const pw = passwordProblem(body.password);
      if (pw) throw badRequest(`Password: ${pw}`);
      db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(body.password), id);
      db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'user', entityId: id, action: 'update', detail: { ...body, password: body.password ? '(reset)' : undefined } });
  });
  return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
}

// ---- Company settings ----

export function updateCompany(db, actor, body) {
  const map = { name: 'name', legalName: 'legal_name', abn: 'abn', address: 'address', phone: 'phone', email: 'email', website: 'website', jobPrefix: 'job_prefix', quoteTerms: 'quote_terms', currency: 'currency',
    licenceNo: 'licence_no', quoteInclusions: 'quote_inclusions' };
  const before = companySettings(db.get('SELECT * FROM companies WHERE id = ?', actor.company_id));
  db.tx(() => {
    if ('quoteLogo' in body) {
      const logo = String(body.quoteLogo || '');
      if (logo && (!LOGO_RE.test(logo) || logo.length > 800000)) throw badRequest('The logo must be a PNG, JPEG or WebP picture under 600 KB.');
      db.run('UPDATE companies SET quote_logo = ? WHERE id = ?', logo || null, actor.company_id);
    }
    for (const [k, col] of Object.entries(map)) {
      if (!(k in body)) continue;
      let v = String(body[k] ?? '').trim();
      if (k === 'name' && !v) throw badRequest('Company name is required.');
      if (k === 'jobPrefix') { v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); if (!v) throw badRequest('Job number prefix is required.'); }
      db.run(`UPDATE companies SET ${col} = ? WHERE id = ?`, v, actor.company_id);
    }
    const pct = (k, col, max) => {
      if (!(k in body)) return;
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0 || n > max) throw badRequest(`${k} is out of range.`);
      db.run(`UPDATE companies SET ${col} = ? WHERE id = ?`, n, actor.company_id);
    };
    pct('gstRate', 'gst_rate', 1);
    pct('floorMargin', 'floor_margin', 1);
    pct('quoteValidityDays', 'quote_validity_days', 365);
    // History: each changed setting with its previous and new value (the logo is recorded as changed, not stored twice).
    const after = companySettings(db.get('SELECT * FROM companies WHERE id = ?', actor.company_id));
    const changes = Object.keys(after).filter((k) => k !== 'id' && String(before[k]) !== String(after[k]))
      .map((k) => (k === 'quoteLogo' ? { field: k, from: before[k] ? '(logo)' : '', to: after[k] ? '(new logo)' : '' } : { field: k, from: before[k], to: after[k] }));
    audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'company', entityId: actor.company_id, action: 'update', detail: { changes } });
  });
  return companySettings(db.get('SELECT * FROM companies WHERE id = ?', actor.company_id));
}

// ---- Area templates ----

export function listTemplates(db, companyId) {
  return db.all('SELECT * FROM area_templates WHERE company_id = ? ORDER BY sort, id', companyId)
    .map((t) => ({ id: t.id, name: t.name, areaType: t.area_type, defaultFinish: t.default_finish, lines: JSON.parse(t.lines_json) }));
}

export function saveTemplate(db, actor, body) {
  const name = String(body.name || '').trim();
  if (!name) throw badRequest('Template name is required.');
  const lines = (body.lines || []).map((l) => ({ moduleKey: String(l.moduleKey), optionKey: l.optionKey || null, qty: Number(l.qty) || 0 }));
  if (body.id) {
    const old = db.get('SELECT name FROM area_templates WHERE id = ? AND company_id = ?', body.id, actor.company_id);
    db.run('UPDATE area_templates SET name = ?, area_type = ?, default_finish = ?, lines_json = ? WHERE id = ? AND company_id = ?',
      name, body.areaType || 'other', body.defaultFinish || null, JSON.stringify(lines), body.id, actor.company_id);
    audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'template', entityId: body.id, action: 'template_update', detail: { from: old?.name, to: name, items: lines.length } });
    return body.id;
  }
  const max = db.get('SELECT COALESCE(MAX(sort), -1) AS s FROM area_templates WHERE company_id = ?', actor.company_id).s;
  const id = Number(db.run('INSERT INTO area_templates (company_id, name, area_type, default_finish, lines_json, sort) VALUES (?, ?, ?, ?, ?, ?)',
    actor.company_id, name, body.areaType || 'other', body.defaultFinish || null, JSON.stringify(lines), max + 1).lastInsertRowid);
  audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'template', entityId: id, action: 'template_create', detail: { name, items: lines.length } });
  return id;
}

export function deleteTemplate(db, actor, id) {
  const old = db.get('SELECT name, lines_json FROM area_templates WHERE id = ? AND company_id = ?', id, actor.company_id);
  db.run('DELETE FROM area_templates WHERE id = ? AND company_id = ?', id, actor.company_id);
  if (old) audit(db, { companyId: actor.company_id, userId: actor.id, entity: 'template', entityId: id, action: 'template_delete', detail: { name: old.name, lines: JSON.parse(old.lines_json) } });
}

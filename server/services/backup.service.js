// Backups: on-disk copies (on demand, daily, before upgrades and restores), each one checked; encrypted off-site
// copies to S3-compatible storage every 15 minutes when data has changed, plus daily and monthly copies; and restore
// of a checked backup into this installation (a running site, a brand-new site, or a PC).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { LATEST_SCHEMA } from '../db/database.js';
import { putObject, getObject, listObjects } from '../backup/s3.js';
import { notify } from './email.service.js';

const NAME_RE = /^platform-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(-(auto|pre-upgrade|pre-restore))?\.db$/;
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const sqlPath = (f) => f.replace(/'/g, "''");
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------- checking a database file ----------------

const COUNT_TABLES = ['companies', 'users', 'jobs', 'job_areas', 'job_lines', 'quotes', 'price_books', 'job_events', 'job_costs', 'audit_log'];

/**
 * Open a database file read-only and check it: SQLite integrity, foreign keys, database version this program can
 * read, and that it holds a company. Returns what it contains so a person can confirm it is the right backup.
 */
export function inspectDatabaseFile(file) {
  const problems = [];
  const head = Buffer.alloc(16);
  try { const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); } catch { return { ok: false, problems: ['The file could not be read.'] }; }
  if (head.toString('latin1') !== 'SQLite format 3\0') return { ok: false, problems: ['This is not a database backup file (expected a .db or .vbak file from this program).'] };
  let raw;
  try { raw = new DatabaseSync(file, { readOnly: true }); } catch (err) { return { ok: false, problems: [`The database could not be opened: ${err.message}`] }; }
  try {
    const integrity = raw.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok') problems.push(`Integrity check failed: ${integrity.slice(0, 3).join('; ')}`);
    const fk = raw.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) problems.push(`${fk.length} broken record link${fk.length === 1 ? '' : 's'} (foreign keys).`);
    const has = (t) => !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const schemaVersion = has('schema_migrations') ? Number(raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v || 0) : 0;
    if (!schemaVersion) problems.push('This database has no version information, so it is not from this program.');
    if (schemaVersion > LATEST_SCHEMA) problems.push(`This backup was made by a newer version of the program (database version ${schemaVersion}; this program reads up to ${LATEST_SCHEMA}). Update the program first.`);
    const counts = {};
    for (const t of COUNT_TABLES) counts[t] = has(t) ? Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n) : 0;
    const company = has('companies') ? raw.prepare('SELECT name FROM companies ORDER BY id LIMIT 1').get()?.name || '' : '';
    if (!company) problems.push('This backup has no company in it (it was taken before setup).');
    const lastActivity = has('audit_log') ? raw.prepare('SELECT MAX(at) AS at FROM audit_log').get().at : null;
    return { ok: !problems.length, problems, schemaVersion, counts, company, lastActivity, bytes: fs.statSync(file).size };
  } catch (err) {
    return { ok: false, problems: [`The database could not be read: ${err.message}`] };
  } finally {
    raw.close();
  }
}

// ---------------- on-disk copies ----------------

/** Consistent copy of the live database (VACUUM INTO is safe while the app is running), checked straight away. */
export function backupNow(db, { auto = false, kind = auto ? 'auto' : '' } = {}) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const file = path.join(config.backupDir, `platform-${localStamp()}${kind ? `-${kind}` : ''}.db`);
  db.exec(`VACUUM INTO '${sqlPath(file)}'`);
  const check = inspectDatabaseFile(file);
  fs.writeFileSync(`${file}.json`, JSON.stringify({ checkedAt: new Date().toISOString(), appVersion: config.version, ...check }, null, 2));
  if (!check.ok) console.error(`Backup check FAILED for ${file}: ${check.problems.join(' ')}`);
  return file;
}

const readCheck = (file) => { try { return JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')); } catch { return null; } };

export function listBackups() {
  const base = { dir: config.backupDir, keep: config.backupKeep, auto: config.autoBackup };
  if (!fs.existsSync(config.backupDir)) return { ...base, files: [] };
  const files = fs.readdirSync(config.backupDir).filter((f) => NAME_RE.test(f)).map((f) => {
    const full = path.join(config.backupDir, f);
    const st = fs.statSync(full);
    const kind = (f.match(/-(auto|pre-upgrade|pre-restore)\.db$/) || [])[1] || 'manual';
    const check = readCheck(full);
    return { name: f, size: st.size, at: st.mtime.toISOString(), auto: kind === 'auto', kind, checked: check ? check.ok : null, problems: check?.problems || [] };
  }).sort((a, b) => b.name.localeCompare(a.name));
  return { ...base, files };
}

/** Keep the newest `keep` automatic backups and upgrade/restore safety copies for 90 days; manual backups stay. */
export function pruneBackups(keep = config.backupKeep) {
  const files = listBackups().files;
  const remove = (f) => { fs.rmSync(path.join(config.backupDir, f.name), { force: true }); fs.rmSync(path.join(config.backupDir, `${f.name}.json`), { force: true }); };
  files.filter((f) => f.auto).slice(keep).forEach(remove);
  const cutoff = Date.now() - 90 * 86400e3;
  files.filter((f) => (f.kind === 'pre-upgrade' || f.kind === 'pre-restore') && Date.parse(f.at) < cutoff).forEach(remove);
}

/** Absolute path of a backup by name, or null if the name is not a backup file. */
export function backupPath(name) {
  if (!NAME_RE.test(String(name))) return null;
  const file = path.join(config.backupDir, name);
  return fs.existsSync(file) ? file : null;
}

/** Called hourly: makes one automatic backup per day, then prunes old ones. */
export function autoBackupTick(db) {
  const today = localStamp().slice(0, 10);
  const done = listBackups().files.some((f) => f.auto && f.name.startsWith(`platform-${today}`));
  if (done) return null;
  const file = backupNow(db, { auto: true });
  pruneBackups();
  return file;
}

// ---------------- encrypted backup files (.vbak) ----------------
// Layout: "VCBAK1\n" | header length (4 bytes) | header JSON (manifest + key derivation + IV) | AES-256-GCM(gzip(db)) | tag.
// The header is authenticated too, so neither the manifest nor the data can be altered without the key noticing.

const MAGIC = Buffer.from('VCBAK1\n');
const KDF = { N: 16384, r: 8, p: 1 };
const deriveKey = (passphrase, salt, kdf = KDF) => crypto.scryptSync(String(passphrase), salt, 32, { ...kdf, maxmem: 64 * 1024 * 1024 });

export function packBackup(dbBuffer, manifest, passphrase) {
  if (!passphrase) throw new Error('No backup encryption key is set (BACKUP_ENCRYPTION_KEY).');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ format: 'vicello-backup', v: 1, manifest, kdf: { alg: 'scrypt', ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64') }));
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  const aad = Buffer.concat([MAGIC, len, header]);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(dbBuffer, { level: 9 })), cipher.final()]);
  return Buffer.concat([aad, body, cipher.getAuthTag()]);
}

export const isPacked = (buf) => buf.length > MAGIC.length + 4 && buf.subarray(0, MAGIC.length).equals(MAGIC);

/** Read a .vbak: returns { manifest } without a key, and { manifest, dbBuffer } with the right key. */
export function unpackBackup(buf, passphrase) {
  if (!isPacked(buf)) throw new Error('This is not an encrypted backup (.vbak) file.');
  const hlen = buf.readUInt32BE(MAGIC.length);
  const hEnd = MAGIC.length + 4 + hlen;
  const header = JSON.parse(buf.subarray(MAGIC.length + 4, hEnd).toString('utf8'));
  if (passphrase == null) return { manifest: header.manifest };
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(header.kdf.salt, 'base64'), { N: header.kdf.N, r: header.kdf.r, p: header.kdf.p }), Buffer.from(header.iv, 'base64'));
  decipher.setAAD(buf.subarray(0, hEnd));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  let plain;
  try { plain = Buffer.concat([decipher.update(buf.subarray(hEnd, buf.length - 16)), decipher.final()]); } catch {
    throw Object.assign(new Error('The backup encryption key is wrong, or the file is damaged.'), { code: 'BAD_KEY' });
  }
  const dbBuffer = zlib.gunzipSync(plain);
  if (header.manifest?.dbSha256 && sha256(dbBuffer) !== header.manifest.dbSha256) throw new Error('The backup is damaged: its checksum does not match.');
  return { manifest: header.manifest, dbBuffer };
}

/** Copy the live database, check it, and pack it encrypted with its manifest. */
export function makeOffsiteFile(db, { kind, passphrase = config.backupEncryptionKey } = {}) {
  fs.mkdirSync(config.restoreDir, { recursive: true });
  const tmp = path.join(config.restoreDir, `offsite-${process.pid}-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${sqlPath(tmp)}'`);
    const check = inspectDatabaseFile(tmp);
    if (!check.ok) throw new Error(`The copy failed its check, so it was not uploaded: ${check.problems.join(' ')}`);
    const dbBuffer = fs.readFileSync(tmp);
    const manifest = {
      app: config.appName, appVersion: config.version, environment: config.appEnv, kind, createdAt: new Date().toISOString(),
      schemaVersion: check.schemaVersion, company: check.company, counts: check.counts, lastActivity: check.lastActivity,
      dbBytes: dbBuffer.length, dbSha256: sha256(dbBuffer),
    };
    return { buffer: packBackup(dbBuffer, manifest, passphrase), manifest };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------- off-site schedule ----------------

export const offsiteConfigured = (c = config) => !!(c.offsite.endpoint && c.offsite.bucket && c.offsite.accessKeyId && c.offsite.secretAccessKey && c.backupEncryptionKey);
const writeCfg = (c = config) => ({ endpoint: c.offsite.endpoint, region: c.offsite.region, bucket: c.offsite.bucket, accessKeyId: c.offsite.accessKeyId, secretAccessKey: c.offsite.secretAccessKey });
const readCfg = (c = config) => ({ endpoint: c.offsite.endpoint, region: c.offsite.region, bucket: c.offsite.bucket, accessKeyId: c.offsite.readKeyId, secretAccessKey: c.offsite.readSecret });

function readState() { try { return JSON.parse(fs.readFileSync(config.offsiteStateFile, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.mkdirSync(path.dirname(config.offsiteStateFile), { recursive: true }); fs.writeFileSync(config.offsiteStateFile, JSON.stringify(s, null, 2)); }

/** Date, month and hour in the business's own time zone (the server clock on Render is UTC). */
export function businessTime(d = new Date(), tz = config.businessTimeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, hour: Number(p.hour) };
}
const dayBefore = (date) => new Date(Date.parse(`${date}T12:00:00Z`) - 86400e3).toISOString().slice(0, 10);

/**
 * What a tick should upload now: recent (data changed), daily (from 11 pm business time), monthly (the first daily of
 * each month). A daily taken earlier in the day (the very first run, or catching up after the server was down at
 * 11 pm) is named for the day it stands in for and does not replace tonight's copy.
 */
export function offsitePlan(state, { changeSig, now = new Date(), force = false, dailyHour = config.offsite.dailyHour } = {}) {
  const bt = businessTime(now);
  const yesterday = dayBefore(bt.date);
  const kinds = [];
  if (force || changeSig !== state.lastSig) kinds.push('recent');
  let dailyDate = null, recordDaily = null;
  if (state.lastDailyDate !== bt.date) {
    if (bt.hour >= dailyHour) { dailyDate = bt.date; recordDaily = bt.date; }
    else if (!state.lastDailyDate) { dailyDate = bt.date; recordDaily = yesterday; }
    else if (state.lastDailyDate < yesterday) { dailyDate = yesterday; recordDaily = yesterday; }
  }
  if (dailyDate) kinds.push('daily');
  if (dailyDate && state.lastMonthly !== bt.month) kinds.push('monthly');
  return { kinds, bt, dailyDate, recordDaily };
}

const objectKey = (kind, now, bt, dailyDate, prefix = config.offsite.prefix) => {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261109T041500Z
  if (kind === 'recent') return `${prefix}/recent/${iso.slice(0, 4)}/${iso.slice(4, 6)}/platform-${iso}.vbak`;
  if (kind === 'daily') return `${prefix}/daily/${dailyDate.slice(0, 4)}/platform-${dailyDate}.vbak`;
  if (kind === 'monthly') return `${prefix}/monthly/platform-${bt.month}.vbak`;
  return `${prefix}/manual/platform-${iso}.vbak`;
};

async function heartbeat(ok, detail) {
  if (!config.heartbeatUrl) return;
  try { await fetch(ok ? config.heartbeatUrl : `${config.heartbeatUrl.replace(/\/$/, '')}/fail`, { method: 'POST', body: String(detail || '').slice(0, 1000), signal: AbortSignal.timeout(10000) }); } catch { /* the monitor notices missing pings */ }
}

let running = null;
let soonTimer = null;

/**
 * One off-site check. Uploads what offsitePlan says is due, then pings the heartbeat monitor (success, or /fail with
 * the reason). Safe to call often; only one runs at a time.
 */
export async function offsiteTick(db, { force = false, now = new Date() } = {}) {
  if (!offsiteConfigured()) return { skipped: true, reason: 'Off-site backup is not set up.' };
  if (running) return running;
  running = (async () => {
    const state = readState();
    const changeSig = String(db.get('SELECT MAX(id) AS m FROM audit_log')?.m ?? 0);
    const { kinds, bt, dailyDate, recordDaily } = offsitePlan(state, { changeSig, now, force });
    try {
      if (kinds.length) {
        const { buffer, manifest } = makeOffsiteFile(db, { kind: kinds.join('+') });
        const uploaded = [];
        for (const kind of kinds) {
          const lockUntil = config.offsite.objectLock
            ? new Date(now.getTime() + (kind === 'monthly' ? config.offsite.monthlyYears * 365.25 : config.offsite.lockDays) * 86400e3) : null;
          const key = objectKey(kind, now, bt, dailyDate);
          await putObject(writeCfg(), key, buffer, { lockUntil });
          uploaded.push(key);
        }
        Object.assign(state, { lastSig: changeSig, lastUploadAt: now.toISOString(), lastUploaded: uploaded, lastBytes: buffer.length, lastCounts: manifest.counts });
        if (kinds.includes('daily')) state.lastDailyDate = recordDaily;
        if (kinds.includes('monthly')) state.lastMonthly = bt.month;
      }
      const recovered = (state.failures || 0) > 0;
      Object.assign(state, { lastOkAt: now.toISOString(), lastError: null, failures: 0, lastAlertAt: null });
      writeState(state);
      await heartbeat(true, kinds.length ? `Uploaded ${kinds.join(', ')}` : 'No changes');
      if (recovered) await notify(db, { subject: 'Off-site backups are working again', text: `Off-site backups to ${config.offsite.bucket} succeeded again at ${now.toISOString()}.` });
      return { ok: true, uploaded: kinds, state };
    } catch (err) {
      Object.assign(state, { lastError: err.message, lastErrorAt: now.toISOString(), failures: (state.failures || 0) + 1 });
      // Email the owners on the first failure, then at most every 6 hours while it keeps failing.
      const alert = !state.lastAlertAt || now - Date.parse(state.lastAlertAt) > 6 * 3600e3;
      if (alert) state.lastAlertAt = now.toISOString();
      writeState(state);
      console.error('Off-site backup failed:', err.message);
      await heartbeat(false, err.message);
      if (alert) await notify(db, { subject: 'Off-site backup FAILED', text: `The off-site backup to ${config.offsite.bucket} failed:\n\n${err.message}\n\nCopies on the server itself are still being made. Open Settings → Backups & restore to see the status, and fix the setting named in the message under Render → Environment.` });
      return { ok: false, error: err.message, state };
    } finally {
      running = null;
    }
  })();
  return running;
}

/** After an important change (quote issued, price book published, restore), back up off-site within two minutes. */
export function offsiteSoon(db, delayMs = 120000) {
  if (!offsiteConfigured() || soonTimer) return;
  soonTimer = setTimeout(() => { soonTimer = null; offsiteTick(db).catch(() => {}); }, delayMs);
  soonTimer.unref?.();
}

export function offsiteStatus() {
  const s = readState();
  const o = config.offsite;
  return {
    configured: offsiteConfigured(), environment: config.appEnv,
    missing: [!o.endpoint && 'OFFSITE_ENDPOINT', !o.bucket && 'OFFSITE_BUCKET', !o.accessKeyId && 'OFFSITE_KEY_ID', !o.secretAccessKey && 'OFFSITE_SECRET', !config.backupEncryptionKey && 'BACKUP_ENCRYPTION_KEY'].filter(Boolean),
    bucket: o.bucket, endpoint: o.endpoint, prefix: o.prefix, intervalMinutes: o.intervalMinutes, objectLock: o.objectLock, lockDays: o.lockDays, monthlyYears: o.monthlyYears,
    heartbeat: !!config.heartbeatUrl, canRead: !!(o.endpoint && o.bucket && o.readKeyId && o.readSecret),
    lastUploadAt: s.lastUploadAt || null, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null, lastErrorAt: s.lastErrorAt || null,
    lastUploaded: s.lastUploaded || [], lastBytes: s.lastBytes || 0, lastDailyDate: s.lastDailyDate || null, lastMonthly: s.lastMonthly || null, failures: s.failures || 0,
  };
}

/** Off-site backups available to restore, newest first (needs a key that can read). */
export async function listOffsite({ limit = 60 } = {}) {
  const cfg = readCfg();
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId) throw new Error('Off-site storage is not set up on this site.');
  const all = (await Promise.all(['recent', 'daily', 'monthly', 'manual'].map((k) => listObjects(cfg, `${config.offsite.prefix}/${k}/`).catch((err) => { if (k === 'recent') throw err; return []; })))).flat();
  return all.filter((o) => o.key.endsWith('.vbak')).sort((a, b) => b.lastModified.localeCompare(a.lastModified)).slice(0, limit)
    .map((o) => ({ key: o.key, size: o.size, at: o.lastModified, kind: o.key.slice(config.offsite.prefix.length + 1).split('/')[0] }));
}

export async function downloadOffsite(key) {
  if (!/^[\w./-]+\.vbak$/.test(key) || key.includes('..')) throw new Error('Not a backup file name.');
  return getObject(readCfg(), key);
}

// ---------------- restore ----------------

const TOKEN_RE = /^[a-f0-9]{32}$/;

/**
 * Step 1 of a restore: take a backup (plain .db or encrypted .vbak), check it fully, and keep it ready for step 2.
 * Nothing in the running database changes. Returns a token and what the backup contains.
 */
export function stageRestore(buf, { passphrase = '', source = 'upload' } = {}) {
  if (!buf || !buf.length) throw Object.assign(new Error('Choose a backup file.'), { status: 400 });
  let dbBuffer = buf, manifest = null;
  if (isPacked(buf)) {
    const key = passphrase || config.backupEncryptionKey;
    if (!key) throw Object.assign(new Error('This backup is encrypted. Enter the backup encryption key.'), { status: 400, field: 'backupKey' });
    try { ({ dbBuffer, manifest } = unpackBackup(buf, key)); } catch (err) { throw Object.assign(err, { status: 400, field: err.code === 'BAD_KEY' ? 'backupKey' : undefined }); }
  }
  // A database copied straight from a data folder may be marked as using a write-ahead log; the single file is complete
  // as of its last checkpoint, so mark the copy as a plain database file so it can be checked and opened on its own.
  if (dbBuffer.length > 20 && dbBuffer[18] === 2 && dbBuffer[19] === 2) { dbBuffer = Buffer.from(dbBuffer); dbBuffer[18] = 1; dbBuffer[19] = 1; }
  fs.mkdirSync(config.restoreDir, { recursive: true });
  for (const f of fs.readdirSync(config.restoreDir)) { // tidy restores that were never finished
    const full = path.join(config.restoreDir, f);
    if (Date.now() - fs.statSync(full).mtimeMs > 3600e3) fs.rmSync(full, { force: true });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const file = path.join(config.restoreDir, `${token}.db`);
  fs.writeFileSync(file, dbBuffer);
  const check = inspectDatabaseFile(file);
  if (!check.ok) { fs.rmSync(file, { force: true }); throw Object.assign(new Error(`This backup cannot be restored: ${check.problems.join(' ')}`), { status: 400, problems: check.problems }); }
  fs.writeFileSync(`${file}.json`, JSON.stringify({ source, manifest, check }));
  return { token, summary: { ...check, source, createdAt: manifest?.createdAt || null, appVersion: manifest?.appVersion || null, encrypted: !!manifest } };
}

export function stagedRestore(token) {
  if (!TOKEN_RE.test(String(token))) return null;
  const file = path.join(config.restoreDir, `${token}.db`);
  if (!fs.existsSync(file)) return null;
  return { file, meta: JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')) };
}

/**
 * Step 2: put the checked backup in place of the live database. A safety copy of the current database is taken first
 * (unless there is nothing to keep), the restored database is brought up to this version, and everyone signs in again.
 */
export function applyRestore(db, token, { keepSafetyCopy = true } = {}) {
  const staged = stagedRestore(token);
  if (!staged) throw Object.assign(new Error('That restore has expired or was already used. Check the backup again.'), { status: 409 });
  const safety = keepSafetyCopy ? backupNow(db, { kind: 'pre-restore' }) : null;
  db.replaceWith(staged.file);
  db.run('DELETE FROM sessions');
  fs.rmSync(staged.file, { force: true });
  fs.rmSync(`${staged.file}.json`, { force: true });
  return { safetyCopy: safety ? path.basename(safety) : null, summary: staged.meta.check, source: staged.meta.source };
}

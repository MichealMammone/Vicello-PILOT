// Backups and recovery: checked on-disk copies, a copy before every upgrade, encrypted off-site copies (against a
// stand-in S3 server), restore over a running site and into a brand-new site, and rejection of bad backups.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-backup-'));
process.env.DATA_DIR = dir;
const { config } = await import('../server/config.js');
const { openDatabase, LATEST_SCHEMA } = await import('../server/db/database.js');
const { migrations } = await import('../server/db/migrations.js');
const { createServer } = await import('../server/index.js');
const B = await import('../server/services/backup.service.js');
const { sign } = await import('../server/backup/s3.js');

const OWNER = { email: 'owner@example.test', password: 'Testing-12345' };
const KEY = 'correct horse battery staple 42';

// ---- stand-in S3 server: stores objects, checks every request is signed and every upload's Content-MD5 ----
const objects = new Map();
const requests = [];
let s3, s3url;
function fakeS3(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: u.pathname, headers: req.headers });
    if (!/^AWS4-HMAC-SHA256 Credential=TESTKEY\//.test(req.headers.authorization || '')) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (bucket !== 'vicello-backups') { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
    if (req.method === 'PUT') {
      if (crypto.createHash('md5').update(body).digest('base64') !== req.headers['content-md5']) { res.writeHead(400); return res.end('<Error><Code>BadDigest</Code></Error>'); }
      objects.set(key, { body, at: new Date().toISOString(), lock: req.headers['x-amz-object-lock-retain-until-date'] || null });
      res.writeHead(200, { ETag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
      return res.end();
    }
    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, o]) => `<Contents><Key>${k}</Key><LastModified>${o.at}</LastModified><Size>${o.body.length}</Size></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'GET' && objects.has(key)) { res.writeHead(200); return res.end(objects.get(key).body); }
    res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>');
  });
}

let db, server, base, cookie = '';
async function call(method, url, body, { raw = null, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method, body: raw || (body ? JSON.stringify(body) : undefined),
    headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  s3 = http.createServer(fakeS3);
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  s3url = `http://127.0.0.1:${s3.address().port}`;
  db = openDatabase(config.dbFile);
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/setup', { companyName: 'Vicello', name: 'Olive Owner', ...OWNER })).status, 200);
  assert.equal((await call('POST', '/api/login', OWNER)).status, 200);
  assert.equal((await call('POST', '/api/jobs', { name: 'Original job name', clientName: 'A Client' })).status, 200);
});
after(() => { server.close(); s3.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('S3 request signing matches the AWS Signature Version 4 example', () => {
  const h = sign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('every on-disk backup is checked when it is made', async () => {
  const r = await call('POST', '/api/admin/backups');
  assert.equal(r.status, 200);
  const f = r.data.files[0];
  assert.equal(f.checked, true);
  assert.equal(f.kind, 'manual');
  const check = JSON.parse(fs.readFileSync(path.join(config.backupDir, `${f.name}.json`), 'utf8'));
  assert.equal(check.company, 'Vicello');
  assert.equal(check.counts.jobs, 1);
  assert.equal(check.schemaVersion, LATEST_SCHEMA);
});

test('an existing database is copied before an upgrade changes its structure', () => {
  const old = path.join(dir, 'old', 'platform.db');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  const raw = new DatabaseSync(old);
  raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of migrations.filter((x) => x.version <= 3)) { raw.exec(m.sql); raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x'); }
  raw.prepare("INSERT INTO companies (name, created_at) VALUES ('Old Co', 'x')").run();
  raw.close();
  const upgraded = openDatabase(old);
  assert.equal(upgraded.get('SELECT MAX(version) AS v FROM schema_migrations').v, 4);
  assert.equal(upgraded.get('SELECT name FROM companies').name, 'Old Co');
  upgraded.close();
  const copies = fs.readdirSync(path.join(dir, 'old', 'backups')).filter((f) => f.endsWith('-pre-upgrade.db'));
  assert.equal(copies.length, 1);
  const inside = B.inspectDatabaseFile(path.join(dir, 'old', 'backups', copies[0]));
  assert.equal(inside.schemaVersion, 3, 'the copy is the database as it was before the upgrade');
  assert.equal(inside.company, 'Old Co');
});

test('encrypted backup files: round trip, wrong key and tampering are refused', () => {
  const data = Buffer.from('SQLite format 3\0 pretend database bytes');
  const manifest = { company: 'Vicello', dbSha256: crypto.createHash('sha256').update(data).digest('hex') };
  const packed = B.packBackup(data, manifest, KEY);
  assert.ok(B.isPacked(packed));
  assert.ok(!packed.includes(Buffer.from('pretend database')), 'contents are not readable without the key');
  assert.deepEqual(B.unpackBackup(packed, KEY).dbBuffer, data);
  assert.equal(B.unpackBackup(packed).manifest.company, 'Vicello', 'the manifest can be read without the key');
  assert.throws(() => B.unpackBackup(packed, 'wrong key'), /key is wrong/);
  const tampered = Buffer.from(packed); tampered[tampered.length - 40] ^= 1;
  assert.throws(() => B.unpackBackup(tampered, KEY), /key is wrong, or the file is damaged/);
});

test('bad backups are refused before anything changes', async () => {
  assert.equal((await call('POST', '/api/admin/restore/check', null, { raw: Buffer.from('hello, not a database') })).status, 400);
  const newer = path.join(dir, 'newer.db');
  db.exec(`VACUUM INTO '${newer}'`);
  const raw = new DatabaseSync(newer);
  raw.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'x')").run();
  raw.close();
  const r = await call('POST', '/api/admin/restore/check', null, { raw: fs.readFileSync(newer) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /newer version of the program/);
});

test('off-site: encrypted copies go to storage when data changes, plus daily and monthly copies, with object lock', async () => {
  Object.assign(config.offsite, { endpoint: s3url, bucket: 'vicello-backups', accessKeyId: 'TESTKEY', secretAccessKey: 'secret', readKeyId: 'TESTKEY', readSecret: 'secret', objectLock: true });
  config.backupEncryptionKey = KEY;
  assert.ok(B.offsiteConfigured());
  const first = await B.offsiteTick(db, { now: new Date('2026-11-09T02:00:00Z') }); // 1 pm Sydney
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.uploaded, ['recent', 'daily', 'monthly'], 'the first run makes all three');
  assert.ok([...objects.keys()].some((k) => k.startsWith('vicello/monthly/platform-2026-11')));
  const monthly = [...objects.entries()].find(([k]) => k.includes('/monthly/'))[1];
  assert.ok(monthly.lock && monthly.lock.startsWith('2033'), 'monthly copies are locked for 7 years');
  const recent = [...objects.entries()].find(([k]) => k.includes('/recent/'))[1];
  assert.ok(recent.lock.startsWith('2026-12'), 'recent copies are locked for 30 days');
  const quiet = await B.offsiteTick(db, { now: new Date('2026-11-09T02:15:00Z') });
  assert.deepEqual(quiet.uploaded, [], 'nothing changed, nothing uploaded');
  await call('POST', '/api/jobs', { name: 'Second job' });
  const changed = await B.offsiteTick(db, { now: new Date('2026-11-09T02:30:00Z') });
  assert.deepEqual(changed.uploaded, ['recent']);
  const night = await B.offsiteTick(db, { now: new Date('2026-11-09T12:05:00Z') }); // 11:05 pm Sydney
  assert.deepEqual(night.uploaded, ['daily'], '11 pm: the day\'s daily copy');
  assert.ok(requests.every((r) => /^AWS4-HMAC-SHA256 /.test(r.headers.authorization)));
  const status = (await call('GET', '/api/admin/offsite')).data;
  assert.equal(status.configured, true);
  assert.equal(status.lastError, null);
  assert.equal(status.lastDailyDate, '2026-11-09');
});

test('off-site failures are recorded and shown, not silent', async () => {
  const good = config.offsite.secretAccessKey;
  Object.assign(config.offsite, { accessKeyId: 'WRONGKEY' });
  const r = await B.offsiteTick(db, { force: true, now: new Date('2026-11-10T01:00:00Z') });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 403/);
  assert.match((await call('GET', '/api/admin/offsite')).data.lastError, /AccessDenied/);
  Object.assign(config.offsite, { accessKeyId: 'TESTKEY', secretAccessKey: good });
});

let offsiteKey;
test('restore over the running site: check first, owner password, safety copy, everyone signs in again', async () => {
  const list = (await call('GET', '/api/admin/offsite/list')).data;
  assert.ok(list.length >= 4);
  offsiteKey = list.find((o) => o.kind === 'monthly').key; // taken when there was one job named "Original job name"
  // change the live data after that backup
  const jobId = db.get("SELECT id FROM jobs WHERE name = 'Original job name'").id;
  const j = (await call('GET', `/api/jobs/${jobId}`)).data.job;
  assert.equal((await call('PUT', `/api/jobs/${jobId}`, { ...j, name: 'Renamed after the backup' })).status, 200);
  const checked = await call('POST', '/api/admin/restore/check', { offsiteKey });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  assert.equal(checked.data.summary.counts.jobs, 1);
  assert.equal(checked.data.summary.encrypted, true);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs').n, 2, 'checking changes nothing');
  assert.equal((await call('POST', '/api/admin/restore/apply', { token: checked.data.token, password: 'wrong-password-1' })).status, 403);
  const applied = await call('POST', '/api/admin/restore/apply', { token: checked.data.token, password: OWNER.password });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.match(applied.data.safetyCopy, /-pre-restore\.db$/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM jobs').n, 1);
  assert.equal(db.get('SELECT name FROM jobs').name, 'Original job name');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions').n, 0, 'everyone signs in again');
  assert.equal((await call('GET', '/api/jobs')).status, 401);
  assert.equal((await call('POST', '/api/login', OWNER)).status, 200, 'the backup\'s users and passwords work');
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'restore'"), 'the restore is in the activity log');
  const safety = B.inspectDatabaseFile(path.join(config.backupDir, applied.data.safetyCopy));
  assert.equal(safety.counts.jobs, 2, 'the safety copy holds the data from just before the restore');
  assert.equal((await call('POST', '/api/admin/restore/apply', { token: checked.data.token, password: OWNER.password })).status, 409, 'a check can be used once');
});

test('a brand-new site can start from a backup on the setup screen (file upload)', async () => {
  const freshFile = path.join(dir, 'fresh', 'platform.db');
  const fresh = openDatabase(freshFile);
  const s2 = createServer(fresh);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const vbak = (await (await import('../server/backup/s3.js')).getObject({ endpoint: s3url, bucket: 'vicello-backups', accessKeyId: 'TESTKEY', secretAccessKey: 'secret' }, offsiteKey));
    const post = async (url, opts) => { const r = await fetch(base2 + url, { method: 'POST', ...opts, headers: { 'X-Requested-With': 'app', ...opts.headers } }); return { status: r.status, data: await r.json() }; };
    const noKey = await post('/api/setup/restore/check', { body: vbak, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(noKey.status, 200, 'the server knows the encryption key here, so none is typed');
    const checked = noKey.data;
    assert.equal(checked.summary.company, 'Vicello');
    const applied = await post('/api/setup/restore/apply', { body: JSON.stringify({ token: checked.token }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const state = await (await fetch(`${base2}/api/state`)).json();
    assert.equal(state.setupRequired, false);
    const login = await post('/api/login', { body: JSON.stringify(OWNER), headers: { 'Content-Type': 'application/json' } });
    assert.equal(login.status, 200);
    assert.equal(fresh.get('SELECT name FROM jobs').name, 'Original job name');
    const again = await post('/api/setup/restore/check', { body: vbak, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(again.status, 409, 'once set up, restore is only possible from Settings by the owner');
  } finally {
    s2.close(); fresh.close();
  }
});

test('without the encryption key on the server, the person restoring is asked for it', async () => {
  const keep = config.backupEncryptionKey;
  config.backupEncryptionKey = '';
  try {
    const vbak = objects.get(offsiteKey).body;
    const r1 = await call('POST', '/api/admin/restore/check', null, { raw: vbak });
    assert.equal(r1.status, 400);
    assert.equal(r1.data.details.field, 'backupKey');
    const r2 = await call('POST', '/api/admin/restore/check', null, { raw: vbak, headers: { 'X-Backup-Key': 'not it' } });
    assert.equal(r2.data.details.field, 'backupKey');
    const r3 = await call('POST', '/api/admin/restore/check', null, { raw: vbak, headers: { 'X-Backup-Key': KEY } });
    assert.equal(r3.status, 200);
  } finally { config.backupEncryptionKey = keep; }
});

test('the weekly restore test restores a real off-site backup, reprices every job and re-checks every quote', async () => {
  const { runRestoreTest } = await import('../server/backup/restore-test.js');
  const latest = [...objects.entries()].filter(([k]) => k.includes('/recent/')).pop()[1].body;
  const r = runRestoreTest(latest, { key: KEY, maxAgeHours: 24 * 365 });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /jobs reprice to exactly their saved totals/.test(l)));
  assert.ok(r.lines.some((l) => /issued quotes match their reference numbers/.test(l)));
  const stale = runRestoreTest(latest, { key: KEY, maxAgeHours: 1, now: new Date('2027-01-01T00:00:00Z') });
  assert.equal(stale.ok, false);
  assert.match(stale.problems[0], /hours old/);
  assert.throws(() => runRestoreTest(latest, { key: 'wrong' }), /key is wrong/);
});

test('off-site plan: daily copy from 11 pm Sydney time, catching up a missed day; monthly once a month', () => {
  const plan = (state, iso, sig = 'same') => B.offsitePlan({ lastSig: 'same', ...state }, { changeSig: sig, now: new Date(iso) }).kinds;
  assert.deepEqual(plan({ lastDailyDate: '2026-11-09', lastMonthly: '2026-11' }, '2026-11-09T11:00:00Z'), [], '10 pm Sydney: not yet');
  assert.deepEqual(plan({ lastDailyDate: '2026-11-08', lastMonthly: '2026-11' }, '2026-11-09T12:00:00Z'), ['daily'], '11 pm Sydney');
  assert.deepEqual(plan({ lastDailyDate: '2026-11-07', lastMonthly: '2026-11' }, '2026-11-09T01:00:00Z'), ['daily'], 'a whole day was missed: catch up now');
  assert.deepEqual(plan({ lastDailyDate: '2026-11-30', lastMonthly: '2026-11' }, '2026-12-01T12:30:00Z'), ['daily', 'monthly'], 'first daily of a new month is also the monthly');
  assert.deepEqual(plan({ lastDailyDate: '2026-11-09', lastMonthly: '2026-11' }, '2026-11-09T03:00:00Z', 'changed'), ['recent']);
});

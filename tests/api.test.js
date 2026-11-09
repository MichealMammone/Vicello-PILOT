// End-to-end API tests against a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-test-'));
process.env.DATA_DIR = dir;
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');

let server, base, db, cookie = '';
const OWNER = { email: 'owner@example.test', password: 'Testing-12345' };

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('first run setup, then sign in', async () => {
  assert.equal((await call('GET', '/api/state')).data.setupRequired, true);
  const weak = await call('POST', '/api/setup', { companyName: 'Test Joinery', name: 'Olive Owner', ...OWNER, password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal((await call('POST', '/api/setup', { companyName: 'Test Joinery', name: 'Olive Owner', ...OWNER })).status, 200);
  assert.equal((await call('POST', '/api/setup', { companyName: 'X', name: 'Y', ...OWNER })).status, 409);
  assert.equal((await call('GET', '/api/jobs')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: OWNER.email, password: 'wrong-password-1' })).status, 401);
  const ok = await call('POST', '/api/login', OWNER);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'owner');
});

test('requests without the app header are rejected (CSRF guard)', async () => {
  const r = await call('POST', '/api/jobs', { name: 'x' }, { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
});

let jobId, rev;
test('create, save, conflict, save as', async () => {
  const templates = (await call('GET', '/api/templates')).data;
  const created = await call('POST', '/api/jobs', { name: 'Smith kitchen', clientName: 'Jo Smith', templateIds: [templates[0].id] });
  assert.equal(created.status, 200);
  jobId = created.data.id;
  let { data } = await call('GET', `/api/jobs/${jobId}`);
  assert.match(data.job.jobNumber, /^TES-\d{4}-0001$/);
  const job = data.job;
  job.areas[0].lines[0].qty = 4.2;
  job.areas.push({ name: 'Wardrobe 4', type: 'wardrobe', defaultFinish: 'FG01', lines: [{ moduleKey: 'tall-cabinet', qty: 2.4 }] });
  const saved = await call('PUT', `/api/jobs/${jobId}`, job);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.job.revision, job.revision + 1);
  assert.equal(saved.data.job.areas.length, 2);
  assert.ok(saved.data.pricing.totals.sell > 0);
  rev = saved.data.job.revision;

  const stale = await call('PUT', `/api/jobs/${jobId}`, job);
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /Save As/);

  const copy = await call('POST', `/api/jobs/${jobId}/save-as`, { doc: job, name: 'Smith kitchen – option B' });
  assert.equal(copy.status, 200);
  const c = (await call('GET', `/api/jobs/${copy.data.id}`)).data;
  assert.equal(c.job.areas.length, 2);
  assert.equal(c.job.jobNumber.endsWith('0002'), true);
});

test('export and import a job file', async () => {
  const exp = await call('GET', `/api/jobs/${jobId}/export`);
  assert.equal(exp.data.format, 'joinery-pricing-job');
  const imp = await call('POST', '/api/jobs/import', exp.data);
  assert.equal(imp.status, 200);
  assert.deepEqual(imp.data.missingModules, []);
});

test('quote and statuses are manual; a job set to Won is locked', async () => {
  const before = (await call('GET', `/api/jobs/${jobId}`)).data.job.status;
  const q = await call('POST', `/api/jobs/${jobId}/quotes`, { revision: rev });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const html = await call('GET', `/quotes/${q.data.id}`);
  assert.match(html.data, /Quotation/);
  assert.match(html.data, /4\.20 LM/, 'quantities print with two decimals');
  let { data } = await call('GET', `/api/jobs/${jobId}`);
  assert.equal(data.job.status, before, 'creating a quote does not change the job status');
  // Quote status is set by hand, any way round, without touching the job.
  for (const s of ['accepted', 'declined', 'issued', 'accepted']) assert.equal((await call('POST', `/api/quotes/${q.data.id}/status`, { status: s })).status, 200);
  assert.equal((await call('POST', `/api/quotes/${q.data.id}/status`, { status: 'emailed' })).status, 400);
  ({ data } = await call('GET', `/api/jobs/${jobId}`));
  assert.equal(data.job.status, before, 'quote status does not change the job status');
  assert.equal((await call('GET', `/api/jobs/${jobId}/quotes`)).data[0].status, 'accepted');
  // Staff move the job on by hand.
  data.job.status = 'won';
  const won = await call('PUT', `/api/jobs/${jobId}`, data.job);
  assert.equal(won.status, 200, JSON.stringify(won.data));
  assert.equal(won.data.job.status, 'won');
  const lockedDoc = won.data.job;
  lockedDoc.areas[0].lines[0].qty = 99;
  const locked = await call('PUT', `/api/jobs/${jobId}`, lockedDoc);
  assert.equal(locked.status, 409);
  const costs = await call('POST', `/api/jobs/${jobId}/costs`, { costCode: 'MATERIAL', description: 'Polytec board order', amount: 1200 });
  assert.equal(costs.status, 200);
  const bva = (await call('GET', `/api/jobs/${jobId}/costs`)).data.budget;
  assert.ok(bva.rows.find((r) => r.code === 'MATERIAL').actual === 1200);
});

test('published price books are locked; Save As makes an editable draft', async () => {
  const { books, currentId } = (await call('GET', '/api/price-books')).data;
  assert.equal(books.length, 1);
  const book = (await call('GET', `/api/price-books/${currentId}`)).data;
  const opt = book.modules[0].options[0];
  const edit = { op: 'option.update', moduleKey: book.modules[0].key, optionKey: opt.key, fields: { material: opt.material + 20 } };
  assert.equal((await call('POST', `/api/price-books/${currentId}/changes`, { changes: [edit] })).status, 409);
  assert.throws(() => db.run('UPDATE pb_options SET material = 1 WHERE price_book_id = ?', currentId), /PRICE_BOOK_LOCKED/);
  const draft = (await call('POST', `/api/price-books/${currentId}/clone`, { label: '2026-11 uplift' })).data.id;
  const saved = await call('POST', `/api/price-books/${draft}/changes`, { changes: [edit] });
  assert.equal(saved.status, 200);
  const diff = (await call('GET', `/api/price-books/${draft}/diff`)).data;
  assert.equal(diff.changes.length, 1);
  assert.equal((await call('POST', `/api/price-books/${draft}/publish`, {})).status, 200);
  // the job created on the old version keeps its prices
  const job = (await call('GET', `/api/jobs/${jobId}`)).data;
  assert.equal(job.job.priceBookId, currentId);
});

test('backups: manual, download, automatic once a day, safe names only', async () => {
  const made = await call('POST', '/api/admin/backups');
  assert.equal(made.status, 200);
  const name = made.data.files[0].name;
  const res = await fetch(`${base}/api/admin/backups/${name}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await call('GET', '/api/admin/backups/..%2Fplatform.db')).status, 404);
  assert.equal((await call('GET', '/api/admin/backups/platform.db')).status, 404);
  const { autoBackupTick } = await import('../server/services/backup.service.js');
  assert.ok(autoBackupTick(db), 'first tick of the day makes a backup');
  assert.equal(autoBackupTick(db), null, 'second tick the same day does nothing');
  const list = (await call('GET', '/api/admin/backups')).data;
  assert.equal(list.files.filter((f) => f.auto).length, 1);
});

test('designers cannot edit pricing or manage users', async () => {
  await call('POST', '/api/users', { name: 'Dee Designer', email: 'dee@example.test', role: 'designer', password: 'Designer-12345' });
  await call('POST', '/api/logout');
  await call('POST', '/api/login', { email: 'dee@example.test', password: 'Designer-12345' });
  const { currentId } = (await call('GET', '/api/price-books')).data;
  assert.equal((await call('POST', `/api/price-books/${currentId}/clone`, {})).status, 403);
  assert.equal((await call('GET', '/api/users')).status, 403);
  assert.equal((await call('GET', '/api/jobs')).status, 200);
});

// Publishing a price book: new prices go ONLY to the open jobs the user selects; everything is audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-pub-'));
process.env.DATA_DIR = dir;
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');
const acct = await import('../server/services/account.service.js');
const jobs = await import('../server/services/jobs.service.js');
const pb = await import('../server/services/pricebook.service.js');

let server, base, db, cookie = '';
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
let J = {}, oldBook, draft;
const job = (id) => jobs.getJobDoc(db, 1, id);
const sell = (id) => db.get('SELECT total_sell FROM jobs WHERE id = ?', id).total_sell;

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  acct.setup(db, { companyName: 'Pub Co', name: 'Olive Owner', email: 'o@example.test', password: 'Testing-12345' });
  const owner = db.get('SELECT * FROM users WHERE id = 1');
  const company = db.get('SELECT * FROM companies WHERE id = 1');
  const make = (name, status) => {
    const id = jobs.createJob(db, owner, company, { name, clientName: `${name} client`, areas: [{ name: 'Kitchen', defaultFinish: 'FG01', lines: [{ moduleKey: 'base-cabinet', qty: 2.5 }, { moduleKey: 'drawer', qty: 4 }] }] });
    if (status) jobs.saveJob(db, owner, company, id, { ...job(id), status });
    return id;
  };
  J = { a: make('Job A'), b: make('Job B', 'quoted'), c: make('Job C', 'enquiry'), won: make('Job Won', 'won') };
  oldBook = pb.currentPublished(db, 1).id;
  // A draft with a 10% material increase on every option.
  draft = pb.cloneBook(db, 1, oldBook, { userId: 1, label: 'December increase' });
  const book = pb.loadBook(db, 1, draft);
  const changes = [];
  for (const m of book.modules) for (const o of m.options) if (o.material) changes.push({ op: 'option.update', moduleKey: m.key, optionKey: o.key, fields: { material: Math.round(o.material * 1.1 * 1e6) / 1e6 } });
  pb.applyChanges(db, 1, draft, changes, { userId: 1 });
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app' }, body: JSON.stringify({ email: 'o@example.test', password: 'Testing-12345' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the publish window lists every open job (with client), and never won jobs', async () => {
  const impact = (await call('GET', `/api/price-books/${draft}/impact`)).data;
  assert.deepEqual(impact.map((r) => r.id).sort(), [J.a, J.b, J.c].sort());
  assert.equal(impact.find((r) => r.id === J.a).client, 'Job A client');
  assert.ok(impact.every((r) => r.after > r.before));
});

test('a job that is not open cannot be chosen, and nothing is published or changed', async () => {
  const r = await call('POST', `/api/price-books/${draft}/publish`, { applyToJobIds: [J.a, J.won] });
  assert.equal(r.status, 400);
  assert.equal(db.get('SELECT status FROM price_books WHERE id = ?', draft).status, 'draft');
  assert.equal(job(J.a).priceBookId, oldBook);
});

test('only the selected jobs get the new prices; the others keep theirs', async () => {
  const before = { a: sell(J.a), b: sell(J.b), c: sell(J.c), won: sell(J.won) };
  const linesBefore = JSON.stringify(job(J.b).areas);
  const r = await call('POST', `/api/price-books/${draft}/publish`, { effectiveFrom: '2026-12-01', applyToJobIds: [J.a, J.c] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'published');
  assert.deepEqual(r.data.publishResult.applied.map((x) => x.id).sort(), [J.a, J.c].sort());
  assert.deepEqual(r.data.publishResult.kept.map((x) => x.id), [J.b]);
  // selected: moved to the new price book, priced from it
  assert.equal(job(J.a).priceBookId, draft);
  assert.equal(job(J.c).priceBookId, draft);
  assert.ok(sell(J.a) > before.a && sell(J.c) > before.c);
  // not selected: same price book, same prices, same lines (agreed pricing protected)
  assert.equal(job(J.b).priceBookId, oldBook);
  assert.equal(sell(J.b), before.b);
  assert.equal(JSON.stringify(job(J.b).areas), linesBefore);
  // won job: untouched
  assert.equal(job(J.won).priceBookId, oldBook);
  assert.equal(sell(J.won), before.won);
});

test('audit: who, when, which version, jobs updated and jobs kept', async () => {
  const entry = db.get("SELECT * FROM audit_log WHERE entity = 'price_book' AND entity_id = ? AND action = 'apply_new_prices'", String(draft));
  assert.ok(entry && entry.user_id === 1 && entry.at);
  const d = JSON.parse(entry.detail);
  assert.equal(d.label, 'December increase');
  assert.equal(d.effectiveFrom, '2026-12-01');
  assert.deepEqual(d.applied.sort(), [job(J.a).jobNumber, job(J.c).jobNumber].sort());
  assert.deepEqual(d.kept, [job(J.b).jobNumber]);
  const histA = (await call('GET', `/api/jobs/${J.a}/history`)).data.map((h) => h.action);
  const histB = (await call('GET', `/api/jobs/${J.b}/history`)).data.map((h) => h.action);
  assert.ok(histA.includes('reprice'));
  assert.ok(histB.includes('reprice_kept') && !histB.includes('reprice'));
});

test('publishing with no jobs ticked leaves every job unchanged', async () => {
  const d2 = pb.cloneBook(db, 1, draft, { userId: 1, label: 'January' });
  const sells = [J.a, J.b, J.c].map(sell);
  const r = await call('POST', `/api/price-books/${d2}/publish`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.publishResult.applied.length, 0);
  assert.deepEqual([J.a, J.b, J.c].map(sell), sells);
});

test('reporting wording: "Missed" instead of "Lost", and no separate "Quotes" count', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const drill = fs.readFileSync(path.join(root, 'public/js/views/drilldown.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'public/js/ui.js'), 'utf8');
  const dash = fs.readFileSync(path.join(root, 'public/js/views/dashboard.js'), 'utf8');
  for (const word of ["'Quotes'", 'Total quotes', 'Quote success', "'Lost'", 'Jobs lost', 'Revenue lost', 'Loss %', 'Date lost']) assert.ok(!drill.includes(word), `drill-down still shows ${word}`);
  for (const word of ['Jobs quoted', 'Jobs missed', 'Missed %', 'Revenue missed', 'Date missed']) assert.ok(drill.includes(word), `drill-down shows ${word}`);
  assert.match(ui, /lost: 'Missed'/);
  assert.match(dash, /Won vs missed/);
});

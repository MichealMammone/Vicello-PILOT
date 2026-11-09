// Dashboard drill-down: the records behind each figure, and win/loss + staff performance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-drill-'));
process.env.DATA_DIR = dir;
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');
const acct = await import('../server/services/account.service.js');
const jobs = await import('../server/services/jobs.service.js');
const quotes = await import('../server/services/quotes.service.js');

let server, base, db, cookie = '';
const call = async (url) => {
  const res = await fetch(base + url, { headers: { 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}) } });
  return { status: res.status, data: await res.json() };
};

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  acct.setup(db, { companyName: 'Drill Co', name: 'Olive Owner', email: 'o@example.test', password: 'Testing-12345' });
  const owner = db.get('SELECT * FROM users WHERE id = 1');
  const company = db.get('SELECT * FROM companies WHERE id = 1');
  const dee = acct.createUser(db, owner, { name: 'Dee Designer', email: 'd@example.test', role: 'designer', password: 'Designer-12345' });
  const designer = db.get('SELECT * FROM users WHERE id = ?', dee.id);
  const make = (who, name, qty) => {
    const id = jobs.createJob(db, who, company, { name, clientName: `${name} client`, notes: `${name} notes`, areas: [{ name: 'Kitchen', defaultFinish: 'FG01', lines: [{ moduleKey: 'base-cabinet', qty }] }] });
    const q = quotes.createQuote(db, who, company, id, { revision: jobs.getJobDoc(db, 1, id).revision });
    return { id, q };
  };
  const setStatus = (who, id, status) => jobs.saveJob(db, who, company, id, { ...jobs.getJobDoc(db, 1, id), status });
  const a = make(owner, 'Won A', 2);
  quotes.setQuoteStatus(db, owner, company, a.q.id, 'accepted');
  setStatus(owner, a.id, 'won');
  const b = make(owner, 'Lost B', 1);
  quotes.setQuoteStatus(db, owner, company, b.q.id, 'declined');
  setStatus(owner, b.id, 'lost');
  const c = make(designer, 'Won C', 3);
  setStatus(designer, c.id, 'in_production');
  make(designer, 'Open D', 1);
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app' }, body: JSON.stringify({ email: 'o@example.test', password: 'Testing-12345' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('drill-down needs a signed-in user and a known figure', async () => {
  const c = cookie; cookie = '';
  assert.equal((await call('/api/dashboard/drill?metric=won')).status, 401);
  cookie = c;
  assert.equal((await call('/api/dashboard/drill?metric=nope')).status, 400);
});

test('won and lost jobs list the job, client, staff, value, date and notes or reason', async () => {
  const won = (await call('/api/dashboard/drill?metric=won')).data;
  assert.equal(won.kind, 'won');
  assert.deepEqual(won.rows.map((r) => r.name).sort(), ['Won A', 'Won C']);
  const a = won.rows.find((r) => r.name === 'Won A');
  assert.equal(a.client, 'Won A client');
  assert.equal(a.staff, 'Olive Owner');
  assert.ok(a.value > 0 && a.awardDate && a.acceptedQuote === 'R1');
  assert.equal(won.rows.find((r) => r.name === 'Won C').staff, 'Dee Designer');
  const lost = (await call('/api/dashboard/drill?metric=lost')).data;
  assert.deepEqual(lost.rows.map((r) => r.name), ['Lost B']);
  assert.ok(lost.rows[0].lostDate);
  assert.match(lost.rows[0].lossReason, /R1 declined/);
});

test('figures and bars open matching records', async () => {
  assert.deepEqual((await call('/api/dashboard/drill?metric=open')).data.rows.map((r) => r.name), ['Open D']);
  assert.deepEqual((await call('/api/dashboard/drill?metric=active')).data.rows.map((r) => r.name).sort(), ['Won A', 'Won C']);
  assert.deepEqual((await call('/api/dashboard/drill?metric=status:in_production')).data.rows.map((r) => r.name), ['Won C']);
  assert.deepEqual((await call('/api/dashboard/drill?metric=won-month')).data.rows.map((r) => r.name), ['Won A']);
  assert.deepEqual((await call('/api/dashboard/drill?metric=staff:2')).data.rows.map((r) => r.name).sort(), ['Open D', 'Won C']);
});

test('win rate drill-down: win/loss/conversion %, revenue won/lost and per-staff performance', async () => {
  const p = (await call('/api/dashboard/drill?metric=performance')).data;
  assert.equal(p.kind, 'performance');
  const t = p.team;
  assert.equal(t.totalQuotes, 4);
  assert.equal(t.jobsWon, 2);
  assert.equal(t.jobsLost, 1);
  assert.equal(t.winPct, 2 / 3);
  assert.equal(t.lossPct, 1 / 3);
  assert.equal(t.conversionPct, 2 / 4, '2 of the 4 quoted jobs were won');
  assert.equal(t.quoteSuccessPct, 1 / 4, '1 of 4 quotes accepted');
  assert.ok(t.revenueWon > t.revenueLost && t.revenueLost > 0);
  const owner = p.staff.find((s) => s.staff === 'Olive Owner');
  const dee = p.staff.find((s) => s.staff === 'Dee Designer');
  assert.equal(owner.jobsWon, 1); assert.equal(owner.jobsLost, 1); assert.equal(owner.winPct, 0.5);
  assert.equal(dee.jobsWon, 1); assert.equal(dee.jobsLost, 0); assert.equal(dee.conversionPct, 0.5);
  assert.equal(owner.revenueWon + dee.revenueWon, t.revenueWon);
  // a period filter is applied server-side
  assert.equal((await call('/api/dashboard/drill?metric=performance&period=month')).data.team.jobsWon, 2);
});

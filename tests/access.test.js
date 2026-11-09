// Access control: without signing in, no business data can be read or changed. Runs with production (Render) settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-access-'));
process.env.DATA_DIR = dir;
process.env.SECURE_COOKIES = '1';
process.env.TRUST_PROXY = '1';
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');

let server, base, db;
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'app' };

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(`${base}/api/setup`, { method: 'POST', headers: H, body: JSON.stringify({ companyName: 'Access Co', name: 'Owner', email: 'owner@example.test', password: 'Testing-12345' }) });
  assert.equal(s.status, 200);
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('every data endpoint refuses visitors who are not signed in', async () => {
  const reads = ['/api/jobs', '/api/jobs/1', '/api/jobs/1/export', '/api/jobs/1/quotes', '/api/jobs/1/costs', '/api/jobs/1/schedule', '/api/jobs/1/history',
    '/api/price-books', '/api/price-books/1', '/api/price-books/1/export', '/api/company', '/api/users', '/api/designers', '/api/templates', '/api/audit',
    '/api/dashboard', '/api/staff', '/api/leave', '/api/events', '/api/reminders', '/api/schedule/meta',
    '/api/admin/backups', '/api/admin/backups/platform-2026-01-01-00-00-00.db', '/api/admin/info', '/quotes/1'];
  for (const url of reads) {
    const r = await fetch(base + url);
    assert.equal(r.status, 401, `GET ${url} should need sign-in`);
    const body = await r.text();
    assert.ok(!/Access Co|owner@example/.test(body), `GET ${url} leaked data`);
  }
  const writes = [['POST', '/api/jobs'], ['PUT', '/api/jobs/1'], ['POST', '/api/price-books/1/clone'], ['PUT', '/api/company'], ['POST', '/api/users'],
    ['POST', '/api/events'], ['POST', '/api/admin/backups'], ['POST', '/api/staff'], ['POST', '/api/jobs/import']];
  for (const [method, url] of writes) {
    const r = await fetch(base + url, { method, headers: H, body: '{}' });
    assert.equal(r.status, 401, `${method} ${url} should need sign-in`);
  }
  // a second "setup" cannot take over an existing company
  const again = await fetch(`${base}/api/setup`, { method: 'POST', headers: H, body: JSON.stringify({ companyName: 'Evil', name: 'X', email: 'x@example.test', password: 'Testing-12345' }) });
  assert.equal(again.status, 409);
});

test('only the sign-in page and app files are public, and HTTPS is enforced by header', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('strict-transport-security') || '', /max-age=31536000/);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.user, null);
  assert.equal(state.company, null, 'company details are hidden until sign-in');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'owner@example.test', password: 'Testing-12345' }) });
  assert.match(login.headers.get('set-cookie') || '', /HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure/);
});

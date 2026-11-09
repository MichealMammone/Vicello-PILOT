// Internet-facing installs: first-run setup requires SETUP_KEY.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-key-'));
process.env.DATA_DIR = dir;
process.env.SETUP_KEY = 'k3y-for-tests-only';
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');

let server, base, db;
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app' }, body: JSON.stringify(body) });
const owner = { companyName: 'Key Co', name: 'Owner', email: 'owner@example.test', password: 'Testing-12345' };

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup needs the key when SETUP_KEY is set', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.setupKeyRequired, true);
  assert.equal((await post('/api/setup', owner)).status, 403);
  assert.equal((await post('/api/setup', { ...owner, setupKey: 'wrong' })).status, 403);
  assert.equal((await post('/api/setup', { ...owner, setupKey: ' k3y-for-tests-only ' })).status, 200);
  const after = await (await fetch(`${base}/api/state`)).json();
  assert.equal(after.setupRequired, false);
  assert.equal(after.setupKeyRequired, false);
});

// Starts the app the way Render does (RENDER=true, PORT set, none of our variables) and checks it configures itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startLikeRender(dataDir, port) {
  const env = { ...process.env, RENDER: 'true', PORT: String(port), DATA_DIR: dataDir, AUTO_BACKUP: '0' };
  for (const k of ['HOST', 'SECURE_COOKIES', 'TRUST_PROXY', 'SETUP_KEY', 'REQUIRE_SETUP_KEY']) delete env[k];
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80 && !/FIRST-TIME SETUP KEY:/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const stop = async () => { child.kill(); await new Promise((r) => setTimeout(r, 300)); };
  return { out: () => out, stop };
}

test('on Render with no settings: public port, secure cookies, one stable setup key in the logs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-render-'));
  const port = 4400 + Math.floor(Math.random() * 40); // clear of the live (4310), dev (4320) and UAT (4330) ports
  let app = await startLikeRender(dataDir, port);
  try {
    assert.match(app.out(), /Open:\s+http:\/\/localhost:/, 'listens on 0.0.0.0 (shown as localhost)');
    const key = (/FIRST-TIME SETUP KEY:\s+(\S+)/.exec(app.out()) || [])[1];
    assert.match(key || '', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, `readable setup key printed in logs:\n${app.out()}`);

    // The same key after a restart (it is saved on the data disk).
    await app.stop();
    app = await startLikeRender(dataDir, port);
    assert.equal((/FIRST-TIME SETUP KEY:\s+(\S+)/.exec(app.out()) || [])[1], key, 'key survives a restart');

    const base = `http://127.0.0.1:${port}`;
    const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'app', 'X-Forwarded-For': '198.51.100.7' };
    const home = await fetch(`${base}/`);
    assert.match(home.headers.get('strict-transport-security') || '', /max-age/);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.setupKeyRequired, true);

    // The key can be checked on its own; capitals and dashes do not matter.
    const check = async (setupKey) => (await fetch(`${base}/api/setup/check-key`, { method: 'POST', headers: H, body: JSON.stringify({ setupKey }) })).status;
    assert.equal(await check('WRONG-KEY'), 403);
    assert.equal(await check(key.toLowerCase().replace(/-/g, ' ')), 200);

    const body = { companyName: 'Render Co', name: 'Owner', email: 'o@example.test', password: 'Testing-12345' };
    const refused = await fetch(`${base}/api/setup`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.equal(refused.status, 403, 'setup refused without the key');
    assert.equal((await refused.json()).details.field, 'setupKey');
    assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: H, body: JSON.stringify({ ...body, setupKey: key }) })).status, 200);
    assert.equal(fs.existsSync(path.join(dataDir, 'setup-key.txt')), false, 'key is deleted once setup is done');
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.match(login.headers.get('set-cookie') || '', /; Secure/);
  } finally {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('wrong setup keys are throttled like sign-in', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-render-'));
  const port = 4450 + Math.floor(Math.random() * 20);
  const app = await startLikeRender(dataDir, port);
  try {
    const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'app', 'X-Forwarded-For': '203.0.113.9' };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await fetch(`http://127.0.0.1:${port}/api/setup/check-key`, { method: 'POST', headers: H, body: JSON.stringify({ setupKey: `NOPE-${i}` }) })).status);
    assert.deepEqual(codes, [403, 403, 403, 403, 403, 429]);
  } finally {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Email over SMTP, against a stand-in mail server: welcome emails, owner password resets, "forgotten password" links,
// test emails, backup-failure notices, and the SMTP conversation itself (AUTH PLAIN / LOGIN, wrong password).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// ---- stand-in SMTP server ----
const inbox = [];
const smtpState = { authMethods: 'LOGIN PLAIN', user: 'mailer@vicello.test', password: 'smtp-secret' };
const smtp = net.createServer((sock) => {
  let mode = 'cmd', data = '', msg = { to: [] }, loginStep = 0, loginUser = '';
  const say = (s) => sock.write(`${s}\r\n`);
  say('220 stand-in ESMTP');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (mode === 'data') {
      const end = buf.indexOf('\r\n.\r\n');
      if (end < 0) return;
      data = buf.slice(0, end); buf = buf.slice(end + 5); mode = 'cmd';
      const [head, body] = data.split('\r\n\r\n');
      const subjectRaw = (/^Subject: (.*)$/m.exec(head) || [])[1] || '';
      const subject = subjectRaw.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
      inbox.push({ ...msg, head, subject, text: Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') });
      msg = { to: [] };
      say('250 queued');
    }
    let n;
    while (mode === 'cmd' && (n = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 2);
      if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
      if (loginStep === 2) { loginStep = 0; say(loginUser === smtpState.user && Buffer.from(line, 'base64').toString() === smtpState.password ? '235 ok' : '535 bad credentials'); continue; }
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') { say('250-stand-in'); say(`250-AUTH ${smtpState.authMethods}`); say('250 8BITMIME'); }
      else if (cmd === 'AUTH' && /PLAIN/i.test(line)) { const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0'); say(u === smtpState.user && p === smtpState.password ? '235 ok' : '535 bad credentials'); }
      else if (cmd === 'AUTH' && /LOGIN/i.test(line)) { loginStep = 1; say('334 VXNlcm5hbWU6'); }
      else if (cmd === 'MAIL') { msg.from = /<(.*)>/.exec(line)[1]; say('250 ok'); }
      else if (cmd === 'RCPT') { msg.to.push(/<(.*)>/.exec(line)[1]); say('250 ok'); }
      else if (cmd === 'DATA') { mode = 'data'; say('354 go ahead'); if (buf.includes('\r\n.\r\n')) sock.emit('data', Buffer.alloc(0)); }
      else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
      else say('500 unknown');
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-email-'));
Object.assign(process.env, {
  DATA_DIR: dir, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_REQUIRE_TLS: '0',
  SMTP_USER: smtpState.user, SMTP_PASSWORD: smtpState.password, SMTP_FROM_EMAIL: 'quotes@vicello.test', SMTP_FROM_NAME: 'Vicello',
  APP_URL: 'https://vicello-platform.onrender.com/',
});
const { config } = await import('../server/config.js');
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');
const { sendMail } = await import('../server/services/email.service.js');
const B = await import('../server/services/backup.service.js');

let server, base, db, cookie = '';
const OWNER = { email: 'owner@example.test', password: 'Testing-12345' };
async function call(method, url, body, keepCookie = true) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set && keepCookie) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const waitFor = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); } return null; };

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/setup', { companyName: 'Vicello', name: 'Olive Owner', ...OWNER })).status, 200);
  assert.equal((await call('POST', '/api/login', OWNER)).status, 200);
});
after(() => { server.close(); smtp.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('settings: APP_URL without a trailing slash; health check; the app says email is on', async () => {
  assert.equal(config.appUrl, 'https://vicello-platform.onrender.com');
  const h = await call('GET', '/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  assert.equal((await call('GET', '/api/state')).data.app.emailEnabled, true);
});

test('SMTP: AUTH PLAIN and AUTH LOGIN, UTF-8 subject, and a clear message for a wrong password', async () => {
  await sendMail({ to: 'a@example.test', subject: 'Quote – ready ✓', text: 'Line one\n.starts with a dot' });
  let m = inbox.at(-1);
  assert.equal(m.subject, 'Quote – ready ✓');
  assert.match(m.text, /Line one\r\n\.starts with a dot/);
  assert.match(m.head, /^From: Vicello <quotes@vicello\.test>$/m);
  smtpState.authMethods = 'LOGIN';
  await sendMail({ to: ['b@example.test', 'c@example.test'], subject: 'Two', text: 'x' });
  assert.deepEqual(inbox.at(-1).to, ['b@example.test', 'c@example.test']);
  smtpState.authMethods = 'LOGIN PLAIN';
  await assert.rejects(sendMail({ to: 'a@example.test', subject: 'x', text: 'x' }, { ...config.smtp, password: 'wrong' }), /SMTP_USER and SMTP_PASSWORD/);
  await assert.rejects(sendMail({ to: 'a@example.test', subject: 'x', text: 'x' }, { ...config.smtp, requireTls: true }), /does not offer encryption/);
});

test('a new user is emailed their sign-in link and temporary password', async () => {
  const r = await call('POST', '/api/users', { name: 'Dana Designer', email: 'dana@example.test', role: 'designer', password: 'Temp-pass-123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.emailSent, true);
  const m = await waitFor((x) => x.to.includes('dana@example.test'));
  assert.ok(m);
  assert.match(m.subject, /Your Vicello login/);
  assert.match(m.text, /https:\/\/vicello-platform\.onrender\.com/);
  assert.match(m.text, /Temporary password: Temp-pass-123/);
  assert.match(m.text, /choose your own password/);
});

test('an owner resetting a password emails the new temporary password', async () => {
  const dana = db.get("SELECT id FROM users WHERE email = 'dana@example.test'");
  const r = await call('PUT', `/api/users/${dana.id}`, { password: 'Reset-pass-456' });
  assert.equal(r.data.emailSent, true);
  const m = await waitFor((x) => /password was reset/.test(x.subject));
  assert.match(m.text, /Temporary password: Reset-pass-456/);
});

test('forgotten password: same answer for any email, a one-time link for real users, then sign in with the new password', async () => {
  const before = inbox.length;
  assert.equal((await call('POST', '/api/password/forgot', { email: 'nobody@example.test' }, false)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(inbox.length, before, 'no email for an unknown address');
  assert.equal((await call('POST', '/api/password/forgot', { email: 'dana@example.test' }, false)).status, 200);
  const m = await waitFor((x) => /Reset your Vicello password/.test(x.subject));
  const token = /#\/reset\/([A-Za-z0-9_-]+)/.exec(m.text)[1];
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'short' }, false)).status, 400);
  const ok = await call('POST', '/api/password/reset', { token, password: 'Chosen-by-dana-1' }, false);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.email, 'dana@example.test');
  assert.equal((await call('POST', '/api/password/reset', { token, password: 'Another-one-22' }, false)).status, 400, 'a link works once');
  assert.ok(await waitFor((x) => /password was changed/.test(x.subject)), 'the user is told the password changed');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app' }, body: JSON.stringify({ email: 'dana@example.test', password: 'Chosen-by-dana-1' }) });
  assert.equal(login.status, 200);
  const actions = db.all("SELECT action FROM audit_log WHERE action LIKE 'password_reset%'").map((x) => x.action);
  assert.deepEqual(actions, ['password_reset_requested', 'password_reset_by_email']);
});

test('the owner can send a test email; it reports the mail server\'s problem when sending fails', async () => {
  const ok = await call('POST', '/api/admin/email/test', { to: 'owner@example.test' });
  assert.equal(ok.status, 200);
  assert.ok(await waitFor((x) => /Test email from Vicello/.test(x.subject)));
  const st = (await call('GET', '/api/admin/email')).data;
  assert.equal(st.enabled, true);
  assert.equal(st.from, 'quotes@vicello.test');
  const keep = config.smtp.password;
  config.smtp.password = 'wrong';
  const bad = await call('POST', '/api/admin/email/test', {});
  config.smtp.password = keep;
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /SMTP_USER and SMTP_PASSWORD/);
});

test('owners are emailed when off-site backups fail (once, not every 15 minutes)', async () => {
  Object.assign(config.offsite, { endpoint: 'http://127.0.0.1:9', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' });
  config.backupEncryptionKey = 'key';
  const first = await B.offsiteTick(db, { now: new Date('2026-11-10T01:00:00Z') });
  assert.equal(first.ok, false);
  const alert = await waitFor((x) => /Off-site backup FAILED/.test(x.subject));
  assert.ok(alert);
  assert.deepEqual(alert.to, ['owner@example.test']);
  const count = inbox.filter((x) => /FAILED/.test(x.subject)).length;
  await B.offsiteTick(db, { force: true, now: new Date('2026-11-10T01:15:00Z') });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(inbox.filter((x) => /FAILED/.test(x.subject)).length, count, 'no repeat within 6 hours');
});

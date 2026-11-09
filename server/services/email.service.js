// Email over SMTP (Microsoft 365, Google Workspace, Brevo, SendGrid, Amazon SES, any mail server). Built on Node's own
// net/tls, so the app still has no dependencies. Email is optional: with no SMTP_HOST set, nothing is sent and the
// app works exactly as before (people are told to pass passwords on themselves).
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import { config } from '../config.js';

export const emailEnabled = (c = config.smtp) => !!(c.host && c.fromEmail);

/** Read one complete SMTP reply (handles multi-line "250-…" replies). */
function replyReader(socketRef) {
  let buf = '';
  const waiting = [];
  const lines = [];
  const pump = () => {
    while (waiting.length) {
      const i = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (i < 0) return;
      const reply = lines.splice(0, i + 1);
      const code = Number(reply[reply.length - 1].slice(0, 3));
      waiting.shift().resolve({ code, text: reply.map((l) => l.slice(4)).join('\n'), lines: reply });
    }
  };
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let n;
    while ((n = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, n).replace(/\r$/, '')); buf = buf.slice(n + 1); }
    pump();
  };
  const fail = (err) => { while (waiting.length) waiting.shift().reject(err); };
  return {
    attach(sock) { sock.on('data', onData); sock.on('error', fail); sock.on('close', () => fail(new Error('The mail server closed the connection.'))); socketRef.sock = sock; },
    detach(sock) { sock.removeListener('data', onData); },
    next: () => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); pump(); }),
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (name, email) => (name ? `${encodeHeader(name.replace(/"/g, ''))} <${email}>` : email);

/** Build the message: plain text, UTF-8, base64 (safe through every mail server). */
export function buildMessage({ from, fromName, to, subject, text, replyTo }) {
  const headers = [
    `From: ${addr(fromName, from)}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1] || 'localhost'}>`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = b64(text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * Send one email. Port 465 uses TLS from the start; other ports upgrade with STARTTLS, which is required unless
 * SMTP_REQUIRE_TLS=0 (so a password is never sent unencrypted). Resolves with the server's final reply.
 */
export async function sendMail({ to, subject, text, replyTo }, c = config.smtp) {
  if (!emailEnabled(c)) throw new Error('Email is not set up (SMTP_HOST and SMTP_FROM_EMAIL are needed).');
  const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x).trim()).filter(Boolean);
  if (!recipients.length) throw new Error('No recipient.');
  const ref = {};
  const r = replyReader(ref);
  const timeout = c.timeoutMs || 20000;
  const connect = () => new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host, rejectUnauthorized: c.rejectUnauthorized !== false };
    const sock = c.secure ? tls.connect(opts, () => resolve(sock)) : net.connect(opts, () => resolve(sock));
    sock.setTimeout(timeout, () => sock.destroy(new Error(`The mail server ${c.host}:${c.port} did not answer in time.`)));
    sock.once('error', reject);
    r.attach(sock);
  });
  const sock0 = await connect();
  let sock = sock0;
  const send = (line) => sock.write(`${line}\r\n`);
  const expect = async (line, ok, what) => {
    if (line != null) send(line);
    const res = await r.next();
    if (!ok.includes(res.code)) throw new Error(`Mail server refused ${what}: ${res.code} ${res.text}`);
    return res;
  };
  try {
    await expect(null, [220], 'the connection');
    const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    let ehlo = await expect(`EHLO ${helo}`, [250], 'EHLO');
    if (!c.secure) {
      if (/STARTTLS/i.test(ehlo.text)) {
        await expect('STARTTLS', [220], 'STARTTLS');
        r.detach(sock);
        sock = await new Promise((resolve, reject) => {
          const s = tls.connect({ socket: sock0, servername: c.host, rejectUnauthorized: c.rejectUnauthorized !== false }, () => resolve(s));
          s.once('error', reject);
        });
        sock.setTimeout(timeout, () => sock.destroy(new Error('The mail server did not answer in time.')));
        r.attach(sock);
        ehlo = await expect(`EHLO ${helo}`, [250], 'EHLO');
      } else if (c.requireTls) {
        throw new Error(`The mail server ${c.host}:${c.port} does not offer encryption (STARTTLS). Use port 465 or 587, or set SMTP_REQUIRE_TLS=0 for a server on a private network.`);
      }
    }
    if (c.user) {
      const methods = (ehlo.lines.find((l) => /^\d{3}[- ]AUTH/i.test(l)) || '').toUpperCase();
      if (methods.includes('PLAIN') || !methods.includes('LOGIN')) {
        await expect(`AUTH PLAIN ${b64(`\0${c.user}\0${c.password}`)}`, [235], 'the SMTP user name or password (check SMTP_USER and SMTP_PASSWORD)');
      } else {
        await expect('AUTH LOGIN', [334], 'AUTH LOGIN');
        await expect(b64(c.user), [334], 'the SMTP user name');
        await expect(b64(c.password), [235], 'the SMTP user name or password (check SMTP_USER and SMTP_PASSWORD)');
      }
    }
    await expect(`MAIL FROM:<${c.fromEmail}>`, [250], `the sender address ${c.fromEmail} (it must be allowed to send from this account)`);
    for (const rcpt of recipients) await expect(`RCPT TO:<${rcpt}>`, [250, 251], `the recipient ${rcpt}`);
    await expect('DATA', [354], 'DATA');
    const msg = buildMessage({ from: c.fromEmail, fromName: c.fromName, to: recipients, subject, text, replyTo: replyTo || c.replyTo });
    sock.write(msg.replace(/\r\n\./g, '\r\n..'));
    const done = await expect('\r\n.', [250], 'the message');
    send('QUIT');
    return { ok: true, reply: done.text };
  } finally {
    setTimeout(() => sock.destroy(), 200).unref?.();
  }
}

// ---------------- messages ----------------

const appUrl = () => config.appUrl || `http://localhost:${config.port}`;
const sign = (company) => `\n\n—\n${company || config.appName}\n${appUrl()}\n\nThis email was sent automatically by the ${config.appName}.`;

/** Send without ever breaking the action that triggered it; returns { sent, error }. */
async function trySend(mail) {
  if (!emailEnabled()) return { sent: false, error: 'Email is not set up.' };
  try { await sendMail(mail); return { sent: true }; } catch (err) { console.error(`Email to ${mail.to} failed: ${err.message}`); return { sent: false, error: err.message }; }
}

export function welcomeEmail({ user, tempPassword, company, by }) {
  return trySend({
    to: user.email,
    subject: `Your ${company || config.appName} login`,
    text: `Hello ${user.name},\n\n${by} has given you access to the ${company || ''} pricing and job platform as ${user.role === 'designer' ? 'a designer' : `an ${user.role}`}.\n\nSign in at: ${appUrl()}\nEmail: ${user.email}\nTemporary password: ${tempPassword}\n\nYou will be asked to choose your own password when you first sign in.${sign(company)}`,
  });
}

export function adminResetEmail({ user, tempPassword, company, by }) {
  return trySend({
    to: user.email,
    subject: `Your ${company || config.appName} password was reset`,
    text: `Hello ${user.name},\n\n${by} has reset your password.\n\nSign in at: ${appUrl()}\nEmail: ${user.email}\nTemporary password: ${tempPassword}\n\nYou will be asked to choose a new password when you sign in. If you did not expect this, tell ${by} straight away.${sign(company)}`,
  });
}

export function resetLinkEmail({ user, token, company, minutes }) {
  return trySend({
    to: user.email,
    subject: `Reset your ${company || config.appName} password`,
    text: `Hello ${user.name},\n\nSomeone (hopefully you) asked to reset your password.\n\nChoose a new password here (the link works once, for ${minutes} minutes):\n${appUrl()}/#/reset/${token}\n\nIf you did not ask for this, ignore this email; your password has not changed.${sign(company)}`,
  });
}

export function passwordChangedEmail({ user, company }) {
  return trySend({
    to: user.email,
    subject: `Your ${company || config.appName} password was changed`,
    text: `Hello ${user.name},\n\nThe password for ${user.email} was just changed using a reset link. If this was not you, contact your administrator straight away.${sign(company)}`,
  });
}

/**
 * System notification to the people who should know: NOTIFY_EMAIL if set, otherwise every active owner.
 * Used for backup failures and recoveries, restores, and new users.
 */
export function notify(db, { subject, text, companyId = null }) {
  if (!emailEnabled()) return Promise.resolve({ sent: false, error: 'Email is not set up.' });
  const to = config.notifyEmail
    ? config.notifyEmail.split(/[,;\s]+/).filter(Boolean)
    : db.all(`SELECT email FROM users WHERE role = 'owner' AND active = 1 ${companyId ? 'AND company_id = ?' : ''}`, ...(companyId ? [companyId] : [])).map((u) => u.email);
  if (!to.length) return Promise.resolve({ sent: false, error: 'No one to notify.' });
  const company = db.get('SELECT name FROM companies ORDER BY id LIMIT 1')?.name;
  return trySend({ to, subject: `[${company || config.appName}] ${subject}`, text: `${text}${sign(company)}` });
}

export function testEmail({ to, company, by }) {
  return sendMail({
    to, subject: `Test email from ${company || config.appName}`,
    text: `This is a test email sent by ${by} from ${appUrl()}.\n\nIf you can read this, email is working: new users get their login, people can reset forgotten passwords, and owners are told about backup problems.${sign(company)}`,
  });
}

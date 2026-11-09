// First-time setup key. Protects the "Set up your company" screen on an internet-facing install, so nobody else can
// create the owner account before the business does.
//
// - SETUP_KEY (environment) is used when set.
// - Otherwise, when hosted (Render) a short readable key such as 7KQM-2HXP-9DWR is made once and saved in the data
//   folder, so it stays the same across restarts and redeploys. It is printed in the logs and deleted once setup is done.
// - Keys are not case-sensitive and dashes/spaces are ignored when typed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I look-alikes

export const normaliseKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The key to show and accept, or '' when this install does not need one (e.g. on a single office PC). */
export function setupKey() {
  if (config.setupKeyFromEnv) return config.setupKeyFromEnv;
  if (!config.requireSetupKey) return '';
  try {
    const saved = fs.readFileSync(config.setupKeyFile, 'utf8').trim();
    if (saved) return saved;
  } catch { /* not made yet */ }
  const raw = Array.from({ length: 12 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  const key = raw.match(/.{4}/g).join('-');
  fs.mkdirSync(path.dirname(config.setupKeyFile), { recursive: true });
  fs.writeFileSync(config.setupKeyFile, `${key}\n`, { mode: 0o600 });
  return key;
}

/** Timing-safe comparison of a typed key with the expected one. */
export function setupKeyMatches(given) {
  const expected = setupKey();
  if (!expected) return true;
  const a = crypto.createHash('sha256').update(normaliseKey(given)).digest();
  const b = crypto.createHash('sha256').update(normaliseKey(expected)).digest();
  return crypto.timingSafeEqual(a, b) && normaliseKey(given).length > 0;
}

/** Forget the generated key once setup is complete (an environment SETUP_KEY is left alone). */
export function clearSetupKey() {
  try { fs.unlinkSync(config.setupKeyFile); } catch { /* already gone */ }
}

/** A banner that is easy to spot in the hosting logs. */
export function printSetupBanner(note = '') {
  const key = setupKey();
  if (!key) return;
  const line = '='.repeat(66);
  console.log(line);
  console.log(`  FIRST-TIME SETUP KEY:  ${key}`);
  console.log('  Open the website and type this key on the "Set up your company" screen.');
  console.log(config.setupKeyFromEnv ? '  (This is the SETUP_KEY set under Environment.)' : '  It stays the same until setup is finished. Capitals and dashes do not matter.');
  if (note) console.log(`  ${note}`);
  console.log(line);
}

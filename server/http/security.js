// Password hashing (scrypt), session tokens, and login throttling.
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'Use 200 characters or fewer.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'Include at least one letter and one number.';
  return null;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Throttle: 5 failures per email+IP in 15 minutes locks that pair for 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
export function loginBlocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= 5;
}
export function recordLoginFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
export const clearLoginFailures = (key) => failures.delete(key);

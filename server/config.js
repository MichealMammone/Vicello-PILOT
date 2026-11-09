// Runtime configuration. Environment variables override defaults:
//   PORT (default 4310), HOST (default 127.0.0.1: this machine only; use 0.0.0.0 to serve the office network)
//   DATA_DIR (default %LOCALAPPDATA%\JoineryPricing on Windows, ~/.joinery-pricing elsewhere)
//   SESSION_HOURS (default 12)
// On Render (detected by its RENDER variable) no settings are needed: the app listens publicly, stores data on the
// /var/data disk, uses HTTPS-only cookies, trusts Render's proxy, and prints a first-time setup key in the logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const onRender = !!env.RENDER;
const RENDER_DISK = '/var/data';

function defaultDataDir() {
  if (onRender && fs.existsSync(RENDER_DISK)) return RENDER_DISK;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'JoineryPricing');
  return path.join(os.homedir(), '.joinery-pricing');
}

const flag = (name, hostedDefault) => (env[name] === '1' ? true : env[name] === '0' ? false : hostedDefault);
const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : defaultDataDir();

export const config = {
  appName: 'Vicello Pricing Platform',
  version: '0.4.1',
  root,
  publicDir: path.join(root, 'public'),
  sharedDir: path.join(root, 'shared'),
  onRender,
  port: Number(env.PORT || 4310),
  host: env.HOST || (onRender ? '0.0.0.0' : '127.0.0.1'),
  dataDir,
  // On Render without a disk at /var/data, everything saved is lost on each deploy: warn loudly at start-up.
  diskMissing: onRender && !env.DATA_DIR && dataDir !== RENDER_DISK,
  dbFile: path.join(dataDir, 'platform.db'),
  backupDir: path.join(dataDir, 'backups'),
  sessionHours: Number(env.SESSION_HOURS || 12),
  secureCookies: flag('SECURE_COOKIES', onRender),
  // Behind a hosting proxy (Render, a reverse proxy): read the visitor's address from X-Forwarded-For.
  trustProxy: flag('TRUST_PROXY', onRender),
  // Nightly automatic backup (on unless AUTO_BACKUP=0); number of automatic backups kept.
  autoBackup: env.AUTO_BACKUP !== '0',
  backupKeep: Number(env.BACKUP_KEEP || 14),
  // First-run setup key (see services/setupkey.service.js). SETUP_KEY wins when set. Otherwise, when hosted, one is
  // generated once, saved on the data disk so it survives restarts, printed in the logs, and deleted after setup.
  setupKeyFromEnv: env.SETUP_KEY || '',
  requireSetupKey: !!env.SETUP_KEY || onRender || env.REQUIRE_SETUP_KEY === '1',
  setupKeyFile: path.join(dataDir, 'setup-key.txt'),
  // APP_ENV=staging marks a test site: a coloured "TEST SITE" bar is shown and off-site backups stay off unless set.
  appEnv: env.APP_ENV === 'staging' ? 'staging' : 'production',
  businessTimeZone: env.BUSINESS_TIMEZONE || 'Australia/Sydney',
  // Off-site backups to S3-compatible storage (Backblaze B2 recommended). All of OFFSITE_ENDPOINT, OFFSITE_BUCKET,
  // OFFSITE_KEY_ID, OFFSITE_SECRET and BACKUP_ENCRYPTION_KEY must be set; see docs/backup-strategy.md.
  offsite: {
    endpoint: env.OFFSITE_ENDPOINT || '',
    region: env.OFFSITE_REGION || '',
    bucket: env.OFFSITE_BUCKET || '',
    accessKeyId: env.OFFSITE_KEY_ID || '',
    secretAccessKey: env.OFFSITE_SECRET || '',
    // A separate read key is only needed where backups are read back (restore, restore test); the live site's key can be write-only.
    readKeyId: env.OFFSITE_READ_KEY_ID || env.OFFSITE_KEY_ID || '',
    readSecret: env.OFFSITE_READ_SECRET || env.OFFSITE_SECRET || '',
    prefix: (env.OFFSITE_PREFIX || 'vicello').replace(/^\/+|\/+$/g, ''),
    intervalMinutes: Math.max(5, Number(env.OFFSITE_INTERVAL_MINUTES || 15)),
    dailyHour: Number(env.OFFSITE_DAILY_HOUR || 23),
    objectLock: env.OFFSITE_OBJECT_LOCK === '1',
    lockDays: Number(env.OFFSITE_LOCK_DAYS || 30),
    monthlyYears: Number(env.OFFSITE_MONTHLY_YEARS || 7),
  },
  // Web address used in emails (sign-in and password-reset links). On Render, RENDER_EXTERNAL_URL is set automatically.
  appUrl: (env.APP_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  // Email (SMTP). Optional: without SMTP_HOST nothing is emailed. Port 465 = TLS from the start; 587/25 = STARTTLS.
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' || env.SMTP_SECURE === '1' : Number(env.SMTP_PORT || 587) === 465,
    requireTls: env.SMTP_REQUIRE_TLS !== '0',
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    fromEmail: env.SMTP_FROM_EMAIL || '',
    fromName: env.SMTP_FROM_NAME || '',
    replyTo: env.SMTP_REPLY_TO || '',
  },
  // Who receives system notifications (backup problems, restores, new users). Empty = every active owner.
  notifyEmail: env.NOTIFY_EMAIL || '',
  backupEncryptionKey: env.BACKUP_ENCRYPTION_KEY || '',
  heartbeatUrl: env.BACKUP_HEARTBEAT_URL || '',
  restoreDir: path.join(dataDir, 'restore'),
  offsiteStateFile: path.join(dataDir, 'offsite-state.json'),
};

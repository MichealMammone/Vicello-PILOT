// Weekly automatic restore test (GitHub Actions, see docs/backup-strategy.md), or by hand:
//   node scripts/restore-test.js                  newest off-site backup (needs OFFSITE_* read settings + BACKUP_ENCRYPTION_KEY)
//   node scripts/restore-test.js <file.vbak|.db>  a backup file on this computer
// Exits with code 1 (and GitHub emails the repository owner) if anything is wrong.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Work in a throw-away data folder, never the real one.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-data-'));
const { config } = await import('../server/config.js');
const { listOffsite, downloadOffsite } = await import('../server/services/backup.service.js');
const { runRestoreTest } = await import('../server/backup/restore-test.js');

const arg = process.argv[2];
const maxAgeHours = Number(process.env.MAX_BACKUP_AGE_HOURS || 26);
let buffer, name;
try {
  if (arg) {
    buffer = fs.readFileSync(arg);
    name = arg;
  } else {
    const list = (await listOffsite({ limit: 200 })).filter((o) => o.kind === 'recent' || o.kind === 'daily');
    if (!list.length) throw new Error(`No off-site backups found in ${config.offsite.bucket}/${config.offsite.prefix}/.`);
    name = list[0].key;
    console.log(`Newest off-site backup: ${name} (${(list[0].size / 1024 / 1024).toFixed(2)} MB, uploaded ${list[0].at})`);
    buffer = await downloadOffsite(name);
  }
  const r = runRestoreTest(buffer, { key: config.backupEncryptionKey, maxAgeHours: arg ? null : maxAgeHours, name });
  const report = [`# Backup restore test – ${r.ok ? 'PASSED' : 'FAILED'}`, '', `Backup: ${name}`, '', ...r.lines].join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  process.exit(r.ok ? 0 : 1);
} catch (err) {
  console.error(`Backup restore test FAILED: ${err.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Backup restore test – FAILED\n\n${err.message}\n`);
  process.exit(1);
}

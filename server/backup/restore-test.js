// Full restore test of one backup, in a throw-away folder: decrypt → check → open with this program (bringing it up
// to date) → reprice every job with its own price book and compare with the saved totals → re-hash every issued
// quote → compare record counts with the backup's manifest → check the backup is recent. Used by the weekly
// automatic restore test (scripts/restore-test.js, GitHub Actions) and the test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../db/database.js';
import { inspectDatabaseFile, isPacked, unpackBackup } from '../services/backup.service.js';
import { getJobDoc, pricingSettings } from '../services/jobs.service.js';
import { loadBook } from '../services/pricebook.service.js';
import { priceJob, round2 } from '../../shared/pricing.js';

export function runRestoreTest(buffer, { key = '', maxAgeHours = null, now = new Date(), name = 'backup' } = {}) {
  const lines = [];
  const problems = [];
  const ok = (m) => lines.push(`✓ ${m}`);
  const bad = (m) => { problems.push(m); lines.push(`✗ ${m}`); };
  let manifest = null, dbBuffer = buffer;
  if (isPacked(buffer)) {
    ({ manifest, dbBuffer } = unpackBackup(buffer, key));
    ok(`Decrypted ${name} (made ${manifest.createdAt}, program ${manifest.appVersion}) and its checksum matches`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
  const file = path.join(dir, 'platform.db');
  try {
    fs.writeFileSync(file, dbBuffer);
    const check = inspectDatabaseFile(file);
    if (!check.ok) { check.problems.forEach(bad); return { ok: false, lines, problems }; }
    ok(`Database integrity and record links are correct (database version ${check.schemaVersion})`);
    if (manifest) {
      const diff = Object.keys(manifest.counts || {}).filter((k) => manifest.counts[k] !== check.counts[k]);
      if (diff.length) bad(`Record counts differ from the manifest: ${diff.join(', ')}`); else ok(`Record counts match the manifest (${check.counts.jobs} jobs, ${check.counts.quotes} quotes, ${check.counts.users} users)`);
      if (maxAgeHours != null) {
        const age = (now - Date.parse(manifest.createdAt)) / 3600e3;
        if (age > maxAgeHours) bad(`The newest backup is ${age.toFixed(1)} hours old (limit ${maxAgeHours}). Off-site backups may have stopped.`);
        else ok(`The backup is ${age.toFixed(1)} hours old`);
      }
    }
    const db = openDatabase(file);
    try {
      const companies = db.all('SELECT * FROM companies');
      let jobs = 0, mismatched = 0;
      for (const c of companies) {
        for (const j of db.all('SELECT id, job_number, total_sell FROM jobs WHERE company_id = ?', c.id)) {
          const doc = getJobDoc(db, c.id, j.id);
          const total = priceJob(doc, loadBook(db, c.id, doc.priceBookId), pricingSettings(c)).totals.sell;
          jobs++;
          if (Math.abs(round2(total) - round2(j.total_sell)) > 0.005) { mismatched++; if (mismatched <= 5) bad(`Job ${j.job_number}: repriced ${total} but saved ${j.total_sell}`); }
        }
      }
      if (!mismatched) ok(`All ${jobs} jobs reprice to exactly their saved totals`);
      const quotes = db.all('SELECT id, rev, job_id, snapshot, snapshot_hash FROM quotes');
      const broken = quotes.filter((q) => crypto.createHash('sha256').update(q.snapshot).digest('hex') !== q.snapshot_hash);
      if (broken.length) bad(`${broken.length} issued quote(s) do not match their reference number`); else ok(`All ${quotes.length} issued quotes match their reference numbers`);
      if (!db.get("SELECT 1 FROM users WHERE role = 'owner' AND active = 1")) bad('No active owner account: nobody could sign in to manage the restored site');
      else ok('An active owner account is present');
    } finally { db.close(); }
    return { ok: !problems.length, lines, problems, counts: check.counts, manifest };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

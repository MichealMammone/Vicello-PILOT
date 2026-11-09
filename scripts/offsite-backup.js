// Upload an off-site backup now (the running program does this by itself every 15 minutes when data changes).
//   node scripts/offsite-backup.js        (needs the OFFSITE_* settings and BACKUP_ENCRYPTION_KEY)
const { config } = await import('../server/config.js');
const { openDatabase } = await import('../server/db/database.js');
const { offsiteConfigured, offsiteTick, offsiteStatus } = await import('../server/services/backup.service.js');

if (!offsiteConfigured()) {
  console.error(`Off-site backup is not set up. Missing: ${offsiteStatus().missing.join(', ')}. See docs/backup-strategy.md.`);
  process.exit(1);
}
const db = openDatabase(config.dbFile);
const r = await offsiteTick(db, { force: true });
db.close();
if (!r.ok) { console.error(`Off-site backup failed: ${r.error}`); process.exit(1); }
console.log(`Uploaded to ${config.offsite.bucket}:\n  ${r.state.lastUploaded.join('\n  ')}`);

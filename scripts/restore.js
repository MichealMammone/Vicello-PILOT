// Restore a backup into this computer's data folder (the program must be closed first).
//   node scripts/restore.js <backup.db | backup.vbak>      (Restore From Backup.cmd asks for the file)
// Encrypted backups need the backup encryption key: set BACKUP_ENCRYPTION_KEY, or type it when asked.
// The current database (if any) is copied to the backups folder first.
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline/promises';

const { config } = await import('../server/config.js');
const { openDatabase } = await import('../server/db/database.js');
const B = await import('../server/services/backup.service.js');
const { ensureAllDefaults } = await import('../server/services/schedule.service.js');
const { ensureAllStatusDefaults } = await import('../server/services/statuses.service.js');
const { audit } = await import('../server/services/audit.service.js');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const fail = (msg) => { console.error(`\n${msg}\n`); rl.close(); process.exit(1); };
const file = (process.argv[2] || (await rl.question('Backup file (drag it into this window, then press Enter): '))).trim().replace(/^"|"$/g, '');
if (!file || !fs.existsSync(file)) fail(`File not found: ${file}`);

// The program must not be running, or it would keep using the old database.
const portBusy = await new Promise((resolve) => { const s = net.createServer().once('error', () => resolve(true)).once('listening', () => s.close(() => resolve(false))).listen(config.port, '127.0.0.1'); });
if (portBusy) fail(`The program is still running (port ${config.port} is in use). Close its black window, then try again.`);

const buf = fs.readFileSync(file);
let key = '';
if (B.isPacked(buf) && !config.backupEncryptionKey) key = (await rl.question('This backup is encrypted. Backup encryption key: ')).trim();
let staged;
try { staged = B.stageRestore(buf, { passphrase: key, source: `file ${file}` }); } catch (err) { fail(`Cannot restore this backup: ${err.message}`); }
const s = staged.summary;
console.log(`\nBackup checked: OK\n  Company:        ${s.company}\n  Last activity:  ${s.lastActivity || '—'}\n  Jobs: ${s.counts.jobs}   Quotes: ${s.counts.quotes}   Users: ${s.counts.users}   Price book versions: ${s.counts.price_books}`);
console.log(`\nThis replaces ALL data in ${config.dbFile}.`);
if ((await rl.question('Type RESTORE to continue: ')).trim() !== 'RESTORE') fail('Cancelled. Nothing was changed.');
rl.close();

const db = openDatabase(config.dbFile);
const hadData = !!db.get('SELECT 1 FROM companies LIMIT 1');
const out = B.applyRestore(db, staged.token, { keepSafetyCopy: hadData });
ensureAllDefaults(db);
ensureAllStatusDefaults(db);
audit(db, { companyId: db.get('SELECT id FROM companies ORDER BY id LIMIT 1')?.id, entity: 'system', action: 'restore', detail: { source: out.source, by: 'Restore From Backup (this computer)', safetyCopy: out.safetyCopy } });
db.close();
console.log(`\nRestored.${out.safetyCopy ? ` The previous data was saved as backups\\${out.safetyCopy}.` : ''}\nStart the program again (Start Pricing Platform.cmd) and sign in with an email and password from the backup.`);

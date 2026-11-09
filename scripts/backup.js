// Command-line backup (for Windows Task Scheduler etc.): node scripts/backup.js
const { config } = await import('../server/config.js');
const { openDatabase } = await import('../server/db/database.js');
const { backupNow } = await import('../server/services/backup.service.js');

const db = openDatabase(config.dbFile);
const file = backupNow(db);
db.close();
console.log(`Backup written: ${file}`);

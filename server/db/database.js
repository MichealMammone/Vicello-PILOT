// Thin wrapper over Node's built-in SQLite. Services talk to this interface only (all/get/run/tx),
// so a PostgreSQL adapter can replace it for cloud hosting without touching business logic.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations.js';

export const LATEST_SCHEMA = Math.max(...migrations.map((m) => m.version));

export function openDatabase(file, { backupDir = path.join(path.dirname(file), 'backups') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let raw = null;
  const cache = new Map();
  const open = () => {
    raw = new DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    cache.clear();
  };
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  const db = {
    file,
    get raw() { return raw; },
    all: (sql, ...params) => stmt(sql).all(...params).map(plain),
    get: (sql, ...params) => { const r = stmt(sql).get(...params); return r ? plain(r) : null; },
    run: (sql, ...params) => stmt(sql).run(...params),
    exec: (sql) => raw.exec(sql),
    /** Run fn inside a transaction (nested calls use savepoints). */
    tx(fn) {
      const name = `sp${depth}`;
      raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw e;
      }
    },
    close: () => raw.close(),
    /** Replace the database file with a checked copy (restore), then reopen and bring it up to date. */
    replaceWith(sourceFile) {
      if (depth) throw new Error('Cannot restore during a transaction.');
      raw.close();
      for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true });
      fs.copyFileSync(sourceFile, file);
      open();
      migrate(db, backupDir);
    },
  };
  open();
  migrate(db, backupDir);
  return db;
}

const plain = (row) => ({ ...row });

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function migrate(db, backupDir) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.version));
  // An existing database is copied before its structure changes, so an upgrade can always be undone.
  if (pending.length && applied.size) {
    fs.mkdirSync(backupDir, { recursive: true });
    const to = path.join(backupDir, `platform-${stamp()}-pre-upgrade.db`);
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
    console.log(`  Backup before upgrade (database version ${Math.max(...applied)} → ${LATEST_SCHEMA}): ${to}`);
  }
  for (const m of pending) {
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, new Date().toISOString());
    });
  }
}

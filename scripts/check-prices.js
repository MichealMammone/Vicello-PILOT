// Price integrity report from the command line: spreadsheet price vs database price vs calculated quote price.
// Usage: node scripts/check-prices.js [path\to\platform.db | -] [path\to\spreadsheet.xlsx | -] [output folder]
// Defaults: the database in DATA_DIR (or the live data folder), the spreadsheet bundled with the app, and docs/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import('../server/config.js');
const { openDatabase } = await import('../server/db/database.js');
const { currentPublished } = await import('../server/services/pricebook.service.js');
const { checkPrices } = await import('../server/services/pricecheck.service.js');

// "-" (or nothing) means "use the default" for that argument.
const arg = (i) => (process.argv[i] && process.argv[i] !== '-' ? path.resolve(process.argv[i]) : null);
const dbFile = arg(2) || config.dbFile;
const sheet = arg(3);
const outDir = arg(4) || path.join(root, 'docs');
if (!fs.existsSync(dbFile)) { console.error(`No database at ${dbFile}`); process.exit(1); }

const db = openDatabase(dbFile);
const company = db.get('SELECT id, name FROM companies ORDER BY id LIMIT 1');
const book = currentPublished(db, company.id);
const r = checkPrices(db, company.id, book.id, sheet ? { source: fs.readFileSync(sheet), sourceName: path.basename(sheet) } : {});
db.close();

const stamp = new Date().toISOString().slice(0, 10);
const nextRev = (name, ext) => {
  let n = 1;
  while (fs.existsSync(path.join(outDir, `${stamp}_Rev${String(n).padStart(2, '0')}_${name}.${ext}`))) n++;
  return path.join(outDir, `${stamp}_Rev${String(n).padStart(2, '0')}_${name}.${ext}`);
};
const LABEL = { ok: 'Match', price_mismatch: 'Price mismatch', missing: 'Missing from price book', extra: 'Not in spreadsheet', name_mismatch: 'Name differs', duplicate: 'Duplicate name', mapping: 'Mapping issue', sheet_conflict: 'Check spreadsheet row' };
const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const s = r.summary;
const issues = r.rows.filter((x) => x.status !== 'ok');
const md = [
  '# Price integrity report',
  '',
  `Company: **${company.name}** · price book: **${r.book.label}** · spreadsheet: **${r.source}** · checked ${new Date(r.checkedAt).toLocaleString('en-AU')}`,
  '',
  'For every product: the spreadsheet price (TOTAL column), the price stored in the database, and the price the program',
  `calculates on a quote for 1 and ${r.testQty} units with no markup. All three must be equal.`,
  '',
  '| Check | Result |', '|---|---|',
  `| Spreadsheet products | ${s.spreadsheetProducts} |`,
  `| Exact matches (spreadsheet = database = quote) | ${s.ok} |`,
  `| Price mismatches | ${s.priceMismatches} |`,
  `| Missing from the price book | ${s.missing} |`,
  `| In the price book but not the spreadsheet | ${s.extra} |`,
  `| Duplicate names (each copy counted) | ${s.duplicates} |`,
  `| Mapping / name issues | ${s.mapping + s.nameMismatches} |`,
  `| Spreadsheet rows to check (columns ≠ TOTAL) | ${s.spreadsheetConflicts} |`,
  '',
  `Price tiers (markup is only ever added by the tier chosen on a job, and is shown on every line): ${r.tiers.map((t) => `${t.name} ${t.markup}%${t.isDefault ? ' (default)' : ''}`).join(', ')}.`,
  ...(r.warnings.length ? ['', '**Warnings**', '', ...r.warnings.map((w) => `- ${w}`)] : []),
  '',
  `## Products to look at (${issues.length})`,
  '',
  '| Row | Product | Spreadsheet | Database | Quote ×1 | Quote ×5 | Result | Notes |', '|---|---|---|---|---|---|---|---|',
  ...issues.map((x) => `| ${x.row ?? '—'} | ${esc(x.name)} | ${money(x.spreadsheetPrice)} | ${money(x.bookPrice)} | ${money(x.quote1)} | ${money(x.quote5)} | ${LABEL[x.status]} | ${esc(x.notes.join(' · '))} |`),
  '',
  `The full product-by-product list (${r.rows.length} rows) is in the CSV file with the same name.`,
  '',
];
fs.mkdirSync(outDir, { recursive: true });
const mdFile = nextRev('Price-Integrity-Report', 'md');
fs.writeFileSync(mdFile, md.join('\n'));
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [['Spreadsheet row', 'Product', 'Spreadsheet price', 'Database price', 'Quote 1 unit', `Quote ${r.testQty} units`, `Expected ${r.testQty} units`, 'Result', 'Notes'].map(cell).join(',')]
  .concat(r.rows.map((x) => [x.row, x.name, x.spreadsheetPrice, x.bookPrice, x.quote1, x.quote5, x.expected5, LABEL[x.status], x.notes.join(' · ')].map(cell).join(',')));
const csvFile = mdFile.replace(/\.md$/, '.csv');
fs.writeFileSync(csvFile, `﻿${csv.join('\r\n')}`);
console.log(`${s.ok}/${s.spreadsheetProducts} exact matches · ${s.priceMismatches} price mismatches · ${s.missing} missing · ${s.extra} extra · ${s.duplicates} duplicates · ${s.mapping + s.nameMismatches} mapping · ${s.spreadsheetConflicts} rows to check`);
console.log(`Report: ${mdFile}`);
console.log(`CSV:    ${csvFile}`);

// Builds the Material + Labour price book from the spreadsheet, checks every value against the spreadsheet again,
// and writes (1) a price book file for Price Book → Import file… and (2) the import report.
// Usage: node scripts/build-pricebook.js [path\to\spreadsheet.xlsx] [output folder]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from '../server/seed/xlsx.js';
import { buildMaterialLabourBook, MATERIAL_LABOUR_FILE } from '../server/seed/material-labour-import.js';
import { indexBook, unitCostOf } from '../shared/pricing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ? path.resolve(process.argv[2]) : MATERIAL_LABOUR_FILE;
const outDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'docs');
const stamp = new Date().toISOString().slice(0, 10);
// File names follow YYYY-MM-DD_RevNN_Name: the next free revision number for today.
const nextRev = (name, ext) => {
  let n = 1;
  while (fs.existsSync(path.join(outDir, `${stamp}_Rev${String(n).padStart(2, '0')}_${name}.${ext}`))) n++;
  return path.join(outDir, `${stamp}_Rev${String(n).padStart(2, '0')}_${name}.${ext}`);
};

const { book, report, items } = buildMaterialLabourBook(file);

// ---- verify against the spreadsheet, cell by cell ----
const cells = new Map(readXlsx(file).rows.map((r) => [r.row, r.cells]));
const idx = indexBook(book);
const problems = [];
let verified = 0;
for (const m of book.modules) {
  for (const o of m.options) {
    const row = Number(/row (\d+)/.exec(o.source)[1]);
    const c = cells.get(row);
    const it = items.find((i) => i.row === row);
    const name = typeof c.A === 'string' ? c.A : '';
    if (name && (o.fullName ? o.name : m.name) !== name) problems.push(`Row ${row}: name changed`);
    const pricedAtTotal = report.conflicts.some((x) => x.row === row && x.type === 'total_mismatch');
    const want = it.totalOnly ? { material: c.I, hardware: 0 } : { material: typeof c.B === 'number' ? c.B : 0, hardware: typeof c.C === 'number' ? c.C : 0 };
    if (o.material !== want.material && !pricedAtTotal) problems.push(`Row ${row}: material ${o.material} ≠ ${want.material}`);
    if (unitCostOf(m, o, idx).unitCost !== it.spreadsheetPrice) problems.push(`Row ${row}: price ${unitCostOf(m, o, idx).unitCost} ≠ spreadsheet ${it.spreadsheetPrice}`);
    if (o.hardware !== want.hardware) problems.push(`Row ${row}: hardware ${o.hardware} ≠ ${want.hardware}`);
    if (!it.totalOnly) {
      for (const [t, col] of [['FACTORY', 'D'], ['DRAFTING', 'E'], ['STUDIO', 'F'], ['INSTALL', 'H']]) {
        const v = typeof c[col] === 'number' ? c[col] : undefined;
        if (o.labourCost[t] !== v) problems.push(`Row ${row}: ${t} ${o.labourCost[t]} ≠ ${v}`);
      }
    }
    if (unitCostOf(m, o, idx).unitCost !== it.unitCost) problems.push(`Row ${row}: unit cost mismatch`);
    verified++;
  }
}
if (problems.length) { console.error('Verification FAILED:\n' + problems.join('\n')); process.exit(1); }

// ---- price book file (same format as Price Book → Export) ----
const pbFile = nextRev('Vicello-PriceBook-Material-Labour', 'json');
fs.writeFileSync(pbFile, JSON.stringify({ format: 'joinery-pricing-price-book', formatVersion: 1, exportedAt: new Date().toISOString(), source: report.source, book }, null, 2));

// ---- report ----
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const lines = [
  `# Price book import report`,
  '',
  `Source: **${report.source}** (sheet "${report.sheet}"), ${report.rowsRead} rows read.`,
  `Result: **${report.itemsImported} items** imported into **${report.modules} products** (${book.modules.filter((m) => m.options.length > 1).length} product families with several finishes, the rest single items).`,
  `Verification: all ${verified} imported items were checked again against the spreadsheet, cell by cell. Every product's price equals the spreadsheet TOTAL exactly. Names, hardware and labour values match exactly, and material matches except where a row's own TOTAL leaves material out (listed under conflicts). Nothing was rounded, renamed, merged or re-categorised.`,
  `Price tiers: Raw cost (spreadsheet price) 0%, Retail 57.5%, Builder 47%. Markups are only ever added by choosing a tier, and every job line shows the book price next to the sell price.`,
  '',
  '## How values were read',
  '',
  '- Column A = item name (kept exactly, including spacing and spelling).',
  '- B = material, C = hardware, D = factory, E = drafting, F = studio, H = install (dollars per unit). Column G has no heading and was empty.',
  '- I = TOTAL. This is the product\'s price (single source of truth). Every product is priced at exactly this value.',
  '- J = note (kept on the item as a note).',
  '- Rows of one product (e.g. "Base Cabinet - …") are grouped as the finishes of one product, as in the current price book. Each row is still its own item with its own name and prices.',
  '',
  `## Conflicts (${report.conflicts.length}) – need a decision, not changed`,
  '',
  '| Row | Item | Issue |', '|---|---|---|',
  ...report.conflicts.map((c) => `| ${c.row} | ${esc(c.name) || '(no name)'} | ${esc(c.message)} |`),
  '',
  `## Duplicates (${report.duplicates.length}) – all copies imported`,
  '',
  '| Name | Rows | Costs | Same price? |', '|---|---|---|---|',
  ...report.duplicates.map((d) => `| ${esc(d.name)} | ${d.rows.join(', ')} | ${d.costs.map((x) => `$${x.toFixed(2)}`).join(' / ')} | ${d.samePrice ? 'Yes' : 'No'} |`),
  '',
  `## Items with no price (${report.zeroPriced.length}) – imported, switched off until priced`,
  '',
  ...report.zeroPriced.map((z) => `- Row ${z.row}: ${esc(z.name)}`),
  '',
  `## Items with a total only (${report.totalOnly.length}) – the total is used as a lump-sum cost`,
  '',
  ...report.totalOnly.map((t) => `- Row ${t.row}: ${esc(t.name)} – $${t.total.toFixed(2)}`),
  '',
  `## Text in a price column (${report.textInNumberColumns.length}) – kept as a note, value $0.00`,
  '',
  ...report.textInNumberColumns.map((t) => `- Row ${t.row}, column ${t.column} (${t.label}): "${esc(t.text)}"`),
  '',
  '## Rows that are not products',
  '',
  ...report.titles.map((t) => `- Row ${t.row}: title "${esc(t.text)}"`),
  ...report.notes.map((n) => `- Row ${n.row}: note "${esc(n.text)}" (added to the description of "${esc(n.attachedTo)}")`),
  '',
  `## Side notes and workings outside the price columns (${report.sideNotes.length}) – not imported as products`,
  '',
  ...report.sideNotes.map((s) => `- Row ${s.row}: ${esc(s.text)}`),
  '',
];
const reportFile = nextRev('PriceBook-Import-Report', 'md');
fs.writeFileSync(reportFile, lines.join('\n'));

console.log(`Verified ${verified} items against ${path.basename(file)}: all values match.`);
console.log(`Conflicts: ${report.conflicts.length} · duplicates: ${report.duplicates.length} · no price: ${report.zeroPriced.length}`);
console.log(`Price book file: ${pbFile}`);
console.log(`Report:          ${reportFile}`);

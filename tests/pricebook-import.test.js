// Amendment 3: the Material + Labour price book is imported exactly as the spreadsheet gives it.
// Every priced row is checked cell by cell against the .xlsx file itself (no rounding, no renaming, no merging).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readXlsx } from '../server/seed/xlsx.js';
import { buildMaterialLabourBook, MATERIAL_LABOUR_FILE } from '../server/seed/material-labour-import.js';
import { indexBook, priceJob, unitCostOf } from '../shared/pricing.js';

const { book, report, items } = buildMaterialLabourBook();
const { rows } = readXlsx(MATERIAL_LABOUR_FILE);
const byRow = new Map(rows.map((r) => [r.row, r.cells]));
const optionAt = new Map();
for (const m of book.modules) for (const o of m.options) optionAt.set(Number(/row (\d+)/.exec(o.source)[1]), { m, o });
const LABOUR = { FACTORY: 'D', DRAFTING: 'E', STUDIO: 'F', INSTALL: 'H' };

test('every priced spreadsheet row is imported once, with its exact name and values', () => {
  const isHeader = (c) => (typeof c.B === 'string' && /MATERIAL/i.test(c.B)) || (typeof c.D === 'string' && /FACTORY/i.test(c.D));
  const priced = rows.filter((r) => !isHeader(r.cells) && ['B', 'C', 'D', 'E', 'F', 'H', 'I'].some((c) => typeof r.cells[c] === 'number'));
  for (const r of priced) assert.ok(optionAt.has(r.row), `row ${r.row} (${r.cells.A}) was not imported`);
  assert.equal(items.length, optionAt.size, 'one option per imported row (nothing merged)');

  let checked = 0;
  for (const [row, { m, o }] of optionAt) {
    const c = byRow.get(row);
    const name = typeof c.A === 'string' ? c.A : '';
    if (name) assert.equal(o.fullName ? o.name : m.name, name, `row ${row}: name unchanged`);
    const total = items.find((i) => i.row === row);
    const pricedAtTotal = report.conflicts.some((x) => x.row === row && x.type === 'total_mismatch');
    if (total.totalOnly) {
      assert.equal(o.material, c.I, `row ${row}: lump-sum total`);
    } else {
      if (!pricedAtTotal) assert.equal(o.material, typeof c.B === 'number' ? c.B : 0, `row ${row}: material`);
      assert.equal(o.hardware, typeof c.C === 'number' ? c.C : 0, `row ${row}: hardware`);
      for (const [trade, col] of Object.entries(LABOUR)) {
        assert.equal(o.labourCost[trade], typeof c[col] === 'number' ? c[col] : undefined, `row ${row}: ${trade}`);
      }
    }
    checked++;
  }
  assert.ok(checked >= 540, `checked ${checked} rows`);
});

test('every product is priced at exactly the spreadsheet TOTAL (the single source of truth)', () => {
  const idx = indexBook(book);
  let n = 0;
  for (const [row, { m, o }] of optionAt) {
    const c = byRow.get(row);
    if (typeof c.I !== 'number') continue;
    assert.equal(unitCostOf(m, o, idx).unitCost, c.I, `row ${row}: price must equal TOTAL`);
    n++;
  }
  assert.ok(n >= 540);
  // Row 385's TOTAL formula leaves out its material column: priced at the TOTAL ($745), flagged for confirmation.
  const chute = report.conflicts.find((x) => x.row === 385);
  assert.equal(chute.type, 'total_mismatch');
  assert.equal(optionAt.get(385).o.material, 0);
  assert.match(optionAt.get(385).o.note, /Material column shows 130/);
});

test('raw-cost tier has no markup; markups exist only as named tiers', () => {
  const raw = book.tiers.find((t) => t.key === 'raw');
  assert.equal(raw.markup, 0);
  assert.match(raw.name, /spreadsheet price/i);
  const job = { tierKey: 'raw', areas: [{ id: 'a', lines: [{ id: 1, moduleKey: 'base-cabinet', optionKey: optionAt.get(508).o.key, qty: 5 }] }] };
  const line = priceJob(job, book, { gstRate: 0.1, floorMargin: 0 }).areas[0].lines[0];
  assert.equal(line.unitSell, 502);
  assert.equal(line.lineSell, 2510, '5 × $502.00 exactly');
});

test('duplicates and conflicts are reported, not resolved', () => {
  assert.equal(report.duplicates.length, 5);
  assert.ok(report.duplicates.every((d) => d.rows.length === 2 && !d.samePrice));
  const types = report.conflicts.map((c) => c.type);
  assert.ok(types.includes('name_section_mismatch'));
  assert.ok(types.includes('no_name'));
  // both copies of each duplicate are still in the price book
  for (const d of report.duplicates) for (const row of d.rows) assert.ok(optionAt.has(row));
});

test('existing module keys are kept, so templates, area finishes and repricing still work', () => {
  const keys = new Set(book.modules.map((m) => m.key));
  for (const k of ['base-cabinet', 'wall-cabinet', 'tall-cabinet', 'appliance-tower', 'base-end-panel', 'tall-end-panel', 'drawer', 'mitred-bulkhead', 'wall-open', 'tall-pantry', 'wip-doors', 'shaving-cabinet-1000', 'benchtop-33', 'appliance-integration']) assert.ok(keys.has(k), k);
  const job = { tierKey: 'retail', areas: [{ id: 'a', defaultFinish: 'FG01', lines: [{ id: 1, moduleKey: 'base-cabinet', qty: 2.75 }] }] };
  const p = priceJob(job, book, { gstRate: 0.1, floorMargin: 0.3 });
  const line = p.areas[0].lines[0];
  assert.equal(line.description, 'Base Cabinet - 16mm White HMR ', 'quote wording is the spreadsheet name');
  assert.equal(line.unitCost, 502);
  assert.equal(line.lineCost, 1380.5, '2.75 LM × $502.00, not rounded to a whole number');
  assert.deepEqual(line.unitLabourByTrade, { FACTORY: 195, DRAFTING: 85, STUDIO: 75, INSTALL: 50 });
});

test('an existing install imports the file as a draft, publishes it, and older jobs can move to it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-mlx-'));
  let db;
  try {
    const { openDatabase } = await import('../server/db/database.js');
    const acct = await import('../server/services/account.service.js');
    const pb = await import('../server/services/pricebook.service.js');
    const jobs = await import('../server/services/jobs.service.js');
    db = openDatabase(path.join(dir, 'test.db'));
    acct.setup(db, { companyName: 'Vicello', name: 'Owner', email: 'o@example.test', password: 'Testing-12345', priceBook: 'legacy' });
    const user = db.get('SELECT * FROM users WHERE id = 1');
    const company = db.get('SELECT * FROM companies WHERE id = 1');
    const tmpl = acct.listTemplates(db, 1)[0];
    const oldJob = jobs.createJob(db, user, company, { name: 'Older job', templateIds: [tmpl.id] });
    const doc = jobs.getJobDoc(db, 1, oldJob);
    doc.areas[0].lines[0].qty = 2.5;
    jobs.saveJob(db, user, company, oldJob, doc);
    const oldSell = jobs.getJobDoc(db, 1, oldJob);

    // Same steps as Price Book → Import file…, then Publish.
    const file = JSON.parse(JSON.stringify({ format: 'joinery-pricing-price-book', book }));
    const draft = pb.insertBook(db, 1, { ...file.book, label: `${file.book.label} (imported)`, effectiveFrom: null }, { userId: 1 });
    assert.deepEqual(pb.validateBook(pb.loadBook(db, 1, draft)), [], 'publishable as imported');
    pb.publishBook(db, 1, draft, { userId: 1 });

    // The older job keeps its old prices until someone chooses Update to latest prices.
    assert.equal(jobs.getJobDoc(db, 1, oldJob).priceBookId, oldSell.priceBookId);
    const preview = jobs.repricePreview(db, company, oldJob, draft);
    assert.deepEqual(preview.warnings, [], 'every line finds its item in the new price book');
    jobs.applyReprice(db, user, company, oldJob, draft, jobs.getJobDoc(db, 1, oldJob).revision);
    assert.equal(jobs.getJobDoc(db, 1, oldJob).priceBookId, draft);
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh install loads this price book by default and keeps every value exactly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ml-'));
  let db;
  try {
    const { openDatabase } = await import('../server/db/database.js');
    const acct = await import('../server/services/account.service.js');
    const { loadBook, currentPublished } = await import('../server/services/pricebook.service.js');
    db = openDatabase(path.join(dir, 'test.db'));
    acct.setup(db, { companyName: 'Vicello', name: 'Owner', email: 'o@example.test', password: 'Testing-12345' });
    const loaded = loadBook(db, 1, currentPublished(db, 1).id);
    assert.equal(loaded.label, book.label);
    assert.equal(loaded.modules.length, book.modules.length);
    for (const m of book.modules) {
      const lm = loaded.modules.find((x) => x.key === m.key);
      for (const o of m.options) {
        const lo = lm.options.find((x) => x.key === o.key);
        assert.equal(lo.name, o.name);
        assert.equal(lo.material, o.material);
        assert.equal(lo.hardware, o.hardware);
        assert.deepEqual(lo.labourCost ?? {}, o.labourCost, `${m.key}/${o.key}`);
      }
    }
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

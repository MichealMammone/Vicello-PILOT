// Price integrity: spreadsheet price = price book price = calculated quote price, for every product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceJob } from '../shared/pricing.js';
import { MATERIAL_LABOUR_FILE } from '../server/seed/material-labour-import.js';

async function freshDb(priceBook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-pc-'));
  const { openDatabase } = await import('../server/db/database.js');
  const acct = await import('../server/services/account.service.js');
  const db = openDatabase(path.join(dir, 'test.db'));
  acct.setup(db, { companyName: 'Check Co', name: 'Owner', email: 'o@example.test', password: 'Testing-12345', priceBook });
  return { db, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('Product A = $12.73, qty 5 = $63.65 exactly at the raw-cost tier', () => {
  const book = {
    trades: [], finishGroups: [], tiers: [{ key: 'raw', name: 'Raw cost (spreadsheet price)', markup: 0, isDefault: true }],
    modules: [{ key: 'a', name: 'Product A', category: 'X', uom: 'EA', labour: {}, options: [{ key: 'standard', name: 'Standard', material: 12.73 }] }],
  };
  const line = priceJob({ tierKey: 'raw', areas: [{ id: 'a', lines: [{ id: 1, moduleKey: 'a', qty: 5 }] }] }, book, { gstRate: 0.1, floorMargin: 0 }).areas[0].lines[0];
  assert.equal(line.unitCost, 12.73);
  assert.equal(line.unitSell, 12.73);
  assert.equal(line.lineCost, 63.65);
  assert.equal(line.lineSell, 63.65);
});

test('the Material + Labour price book matches the spreadsheet product for product', async () => {
  const { db, done } = await freshDb();
  try {
    const { checkPrices } = await import('../server/services/pricecheck.service.js');
    const { currentPublished } = await import('../server/services/pricebook.service.js');
    const r = checkPrices(db, 1, currentPublished(db, 1).id);
    assert.equal(r.summary.spreadsheetProducts, 548);
    assert.equal(r.summary.priceMismatches, 0, JSON.stringify(r.rows.filter((x) => x.status === 'price_mismatch').slice(0, 3)));
    assert.equal(r.summary.missing, 0);
    assert.equal(r.summary.extra, 0);
    assert.equal(r.summary.duplicates, 10, 'the 5 duplicated names (both copies) are flagged');
    assert.ok(r.summary.mapping >= 1, 'row 258 (no description) is flagged');
    assert.equal(r.summary.spreadsheetConflicts, 1, 'row 385 (TOTAL leaves out its material) is listed for checking');
    assert.equal(r.rows.find((x) => x.row === 385).bookPrice, 745);
    assert.deepEqual(r.warnings, []);
    for (const x of r.rows) {
      if (x.status === 'missing' || x.status === 'extra') continue;
      assert.equal(x.bookPrice, x.spreadsheetPrice, `row ${x.row}`);
      assert.equal(x.quote5, x.expected5, `row ${x.row}: 5 units`);
    }
    // An uploaded copy of the spreadsheet gives the same answer.
    const again = checkPrices(db, 1, currentPublished(db, 1).id, { source: fs.readFileSync(MATERIAL_LABOUR_FILE), sourceName: 'copy.xlsx' });
    assert.equal(again.source, 'copy.xlsx');
    assert.deepEqual(again.summary, r.summary);
  } finally { done(); }
});

test('a price book built from a different spreadsheet is flagged, with mismatches listed', async () => {
  const { db, done } = await freshDb('legacy');
  try {
    const { checkPrices } = await import('../server/services/pricecheck.service.js');
    const r = checkPrices(db, 1, 1);
    assert.ok(r.summary.missing > 400, `missing ${r.summary.missing}`);
    assert.ok(r.warnings.some((w) => /different spreadsheet/.test(w)));
    assert.ok(r.warnings.some((w) => /adds 5%/.test(w)), 'the old Raw tier (+5%) is called out');
  } finally { done(); }
});

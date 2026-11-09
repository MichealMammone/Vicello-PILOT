// Amendment 1: prices, measurements and calculations keep their decimals end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceJob, round2, unitCostOf, indexBook } from '../shared/pricing.js';

const book = {
  trades: [{ key: 'INSTALL', name: 'Install', rate: 85 }, { key: 'FACTORY', name: 'Factory', rate: 70 }],
  tiers: [{ key: 'retail', name: 'Retail', markup: 57.5, isDefault: true }],
  finishGroups: [],
  modules: [
    { key: 'panel', name: 'Panel', category: 'Panels', uom: 'LM', labour: { INSTALL: 0.25 }, options: [{ key: 'std', name: 'Standard', material: 10.5, hardware: 0.255, labourFactor: 1 }] },
    { key: 'cab', name: 'Cabinet', category: 'Cabinetry', uom: 'LM', labour: {}, options: [{ key: 'w', name: 'Cabinet - White', fullName: true, material: 72.25, hardware: 25, labourCost: { FACTORY: 195.5, INSTALL: 50.75 } }] },
  ],
};

test('unit costs keep every decimal', () => {
  const idx = indexBook(book);
  const p = unitCostOf(book.modules[0], book.modules[0].options[0], idx);
  assert.equal(p.unitCost, 10.5 + 0.255 + 0.25 * 85);
  const c = unitCostOf(book.modules[1], book.modules[1].options[0], idx);
  assert.equal(c.unitCost, 72.25 + 25 + 195.5 + 50.75);
  assert.equal(c.labour, 246.25);
  assert.equal(c.hours.INSTALL, 50.75 / 85, 'hours are an estimate at the trade rate, not rounded');
});

test('fractional quantities are priced exactly; only line totals round to cents', () => {
  const job = { tierKey: 'retail', areas: [{ id: 'a', lines: [
    { id: 1, moduleKey: 'panel', optionKey: 'std', qty: 2.75 },
    { id: 2, moduleKey: 'cab', optionKey: 'w', qty: 3.05 },
  ] }] };
  const r = priceJob(job, book, { gstRate: 0.1, floorMargin: 0.3 });
  const [l1, l2] = r.areas[0].lines;
  assert.equal(l1.qty, 2.75);
  assert.equal(l1.lineCost, round2(2.75 * (10.5 + 0.255 + 21.25)));
  assert.equal(l1.lineCost, 88.01, 'cents kept (not 88)');
  assert.equal(l2.lineCost, round2(3.05 * 343.5));
  assert.equal(l2.description, 'Cabinet - White', 'full-name options use their own name on the quote');
  assert.notEqual(r.totals.sell % 1, 0, 'sell total has cents');
});

test('decimal prices and quantities survive saving, reloading and the printed quote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-dec-'));
  process.env.DATA_DIR = dir;
  try {
    const { openDatabase } = await import('../server/db/database.js');
    const acct = await import('../server/services/account.service.js');
    const pb = await import('../server/services/pricebook.service.js');
    const jobs = await import('../server/services/jobs.service.js');
    const quotes = await import('../server/services/quotes.service.js');
    const db = openDatabase(path.join(dir, 'test.db'));
    acct.setup(db, { companyName: 'Dec Co', name: 'Owner', email: 'o@example.test', password: 'Testing-12345', priceBook: 'starter' });
    const user = db.get('SELECT * FROM users WHERE id = 1');
    const company = db.get('SELECT * FROM companies WHERE id = 1');
    const draft = pb.cloneBook(db, 1, pb.currentPublished(db, 1).id, { userId: 1, label: 'Decimals' });
    pb.applyChanges(db, 1, draft, [
      { op: 'option.update', moduleKey: 'base-cabinet', optionKey: 'white', fields: { material: 140.125, hardware: 2.755, labourCost: { INSTALL: 49.995 } } },
      { op: 'trade.update', key: 'INSTALL', fields: { rate: 85.75 } },
    ], { userId: 1 });
    const saved = pb.loadBook(db, 1, draft);
    const o = saved.modules.find((m) => m.key === 'base-cabinet').options.find((x) => x.key === 'white');
    assert.equal(o.material, 140.125);
    assert.equal(o.hardware, 2.755);
    assert.deepEqual(o.labourCost, { INSTALL: 49.995 });
    assert.equal(saved.trades.find((t) => t.key === 'INSTALL').rate, 85.75);
    pb.publishBook(db, 1, draft, { userId: 1 });

    const id = jobs.createJob(db, user, company, { name: 'Decimal job', priceBookId: draft, areas: [{ name: 'Kitchen', lines: [{ moduleKey: 'base-cabinet', optionKey: 'white', qty: 2.755 }] }] });
    const doc = jobs.getJobDoc(db, 1, id);
    assert.equal(doc.areas[0].lines[0].qty, 2.755, 'quantity stored exactly');
    const q = quotes.createQuote(db, user, company, id, { revision: doc.revision });
    const html = quotes.renderQuoteHtml(db, 1, q.id);
    assert.match(html, /2\.755 LM/, 'printed quantity keeps its decimals');
    assert.equal(jobs.getJobDoc(db, 1, id).status, 'quoting', 'creating a quote leaves the job status alone');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

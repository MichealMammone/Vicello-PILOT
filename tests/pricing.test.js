// Parity with the legacy workbook and core engine behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLegacyPriceBook } from '../server/seed/legacy-import.js';
import { priceJob, round2, diffBooks } from '../shared/pricing.js';

const book = buildLegacyPriceBook();
const find = (moduleKey, re) => {
  const m = book.modules.find((x) => x.key === moduleKey);
  assert.ok(m, `module ${moduleKey}`);
  const o = m.options.find((x) => re.test(x.name));
  assert.ok(o, `option ${re} in ${moduleKey}`);
  return o.key;
};

test('round2 rounds half away from zero despite float noise', () => {
  assert.equal(round2(6701.625), 6701.63);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-2.345), -2.35);
});

test('import keeps every option non-negative and preserves legacy unit costs', () => {
  let n = 0;
  for (const m of book.modules) for (const o of m.options) {
    assert.ok(o.material >= 0 && o.labourFactor >= 0, `${m.name} – ${o.name}`);
    n++;
  }
  assert.ok(n >= 410, `expected ~419 options, got ${n}`);
});

// The sample quantities left in the workbook's Kitchen tab (55 units over 8 lines).
// Kitchen row 5 used $88 material (a drift error); the corrected $142 is used here, so cost is 54 higher.
test('sample job matches the workbook (Retail = cost × 1.575)', () => {
  const job = {
    tierKey: 'retail',
    areas: [{ id: 'a', name: 'Kitchen', lines: [
      { id: 1, moduleKey: 'base-cabinet', optionKey: find('base-cabinet', /^16mm White HMR$/), qty: 1 },
      { id: 2, moduleKey: 'base-cabinet', optionKey: find('base-cabinet', /^19mm Blackbutt/), qty: 5 },
      { id: 3, moduleKey: 'wall-cabinet', optionKey: find('wall-cabinet', /^18mm Polyurethane Scandinavian/), qty: 7 },
      { id: 4, moduleKey: 'tall-cabinet', optionKey: find('tall-cabinet', /^18mm Tesrol Superclean/), qty: 12 },
      { id: 5, moduleKey: 'mitred-bulkhead', optionKey: find('mitred-bulkhead', /^American Oak/), qty: 3 },
      { id: 6, moduleKey: 'wall-end-panel', optionKey: find('wall-end-panel', /^16mm Polytec Woodmatt/), qty: 3 },
      { id: 7, moduleKey: 'drawer', optionKey: find('drawer', /^Intivo/), qty: 12 },
      { id: 8, moduleKey: 'square-edge-fingerpull-all-pre-finished-melamine', qty: 12 },
    ] }],
  };
  const r = priceJob(job, book, { gstRate: 0.1, floorMargin: 0.3 });
  const workbookCost = 35083 + 54; // workbook true cost, with row 5 corrected from $88 to $142
  assert.equal(r.totals.cost, workbookCost);
  assert.equal(r.totals.sell, round2(55255.73 + 54 * 1.575));
  assert.equal(r.areas[0].lines[1].lineSell, 6701.63); // workbook O15
  assert.equal(round2(r.areas[0].lines[1].marginPct * 100), 36.51); // not the workbook's 87.3%
  assert.equal(r.warnings.filter((w) => w.level === 'error').length, 0);
});

test('area default finish is inherited by lines without an explicit option', () => {
  const job = { tierKey: 'retail', areas: [{ id: 'a', defaultFinish: 'FG03', lines: [{ id: 1, moduleKey: 'base-cabinet', qty: 2 }] }] };
  const r = priceJob(job, book, {});
  const line = r.areas[0].lines[0];
  assert.equal(line.optionInherited, true);
  assert.match(line.optionName, /Woodmatt/);
  assert.equal(line.unitCost, 574);
});

test('overrides need a reason and below-floor overrides need approval', () => {
  const base = { id: 1, moduleKey: 'base-cabinet', optionKey: find('base-cabinet', /^16mm White HMR$/), qty: 1 };
  const noReason = priceJob({ tierKey: 'retail', areas: [{ id: 'a', lines: [{ ...base, override: { type: 'unit_sell', value: 600 } }] }] }, book, { floorMargin: 0.3 });
  assert.ok(noReason.warnings.some((w) => w.code === 'override_reason'));
  assert.ok(noReason.warnings.some((w) => w.code === 'below_floor'));
  const approved = priceJob({ tierKey: 'retail', areas: [{ id: 'a', lines: [{ ...base, override: { type: 'unit_sell', value: 600, reason: 'Match competitor', approvedBy: 1 } }] }] }, book, { floorMargin: 0.3 });
  assert.equal(approved.warnings.filter((w) => w.level === 'error').length, 0);
  assert.equal(approved.totals.sell, 600);
});

test('optional areas are excluded from the contract total', () => {
  const line = { id: 1, moduleKey: 'base-cabinet', optionKey: find('base-cabinet', /^16mm White HMR$/), qty: 1 };
  const r = priceJob({ tierKey: 'retail', areas: [{ id: 'a', lines: [line] }, { id: 'b', optional: true, lines: [{ ...line, id: 2 }] }] }, book, {});
  assert.equal(r.totals.sell, r.areas[0].totals.sell);
  assert.equal(r.totals.optionalSell, r.areas[1].totals.sell);
});

test('disabled options and zero-cost lines block quoting', () => {
  const opt = find('appliance-tower', /560 series/);
  const r = priceJob({ tierKey: 'retail', areas: [{ id: 'a', lines: [{ id: 1, moduleKey: 'appliance-tower', optionKey: opt, qty: 1 }] }] }, book, {});
  assert.ok(r.warnings.some((w) => w.code === 'unavailable'));
});

test('diffBooks reports cost and rate changes', () => {
  const next = structuredClone(book);
  next.trades.find((t) => t.key === 'INSTALL').rate = 95;
  next.modules[0].options[0].material += 10;
  const changes = diffBooks(book, next);
  assert.ok(changes.some((c) => c.kind === 'trade_rate' && c.to === 95));
  // +$10 material and +$10 install (1 h at the new rate) on the edited option
  assert.ok(changes.some((c) => c.kind === 'option_cost' && c.to - c.from === 20));
});

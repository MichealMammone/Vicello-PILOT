// Price integrity check: spreadsheet price vs price book (database) price vs calculated quote price, product by product.
// Flags missing products, duplicates, price mismatches and mapping problems. Runs only when asked for (no background work).
import { indexBook, priceLine, round2, unitCostOf } from '../../shared/pricing.js';
import { buildMaterialLabourBook, MATERIAL_LABOUR_FILE, MATERIAL_LABOUR_SOURCE_NAME } from '../seed/material-labour-import.js';
import { badRequest } from '../http/http.js';
import { loadBook } from './pricebook.service.js';

const near = (a, b) => Math.abs(a - b) < 0.0000001;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const TEST_QTY = 5;

/** The name a product carries on quotes (the spreadsheet row's name for imported items). */
export function productName(m, o) {
  if (o.fullName) return o.name;
  return o.name && o.name !== 'Standard' ? `${m.name} – ${o.name}` : m.name;
}
const sourceRow = (o) => Number((/row (\d+)/i.exec(o.source || '') || [])[1]) || null;

/**
 * @param source  path to an .xlsx, or its bytes (an uploaded file). Defaults to the spreadsheet the price book came from.
 */
export function checkPrices(db, companyId, bookId, { source = MATERIAL_LABOUR_FILE, sourceName = MATERIAL_LABOUR_SOURCE_NAME } = {}) {
  let sheet;
  try { sheet = buildMaterialLabourBook(source); } catch (err) { throw badRequest(`That file could not be read as the price book spreadsheet (${err.message}).`); }
  const book = loadBook(db, companyId, bookId);
  const idx = indexBook(book);
  const ctx = { markup: 0, floorMargin: 0 }; // no markup: the quote price must equal the spreadsheet price

  const products = [];
  for (const m of book.modules) for (const o of m.options) products.push({ m, o, name: productName(m, o), row: sourceRow(o), used: false });
  const byName = new Map();
  for (const p of products) { if (!byName.has(p.name)) byName.set(p.name, []); byName.get(p.name).push(p); }
  const byLoose = new Map();
  for (const p of products) { const k = norm(p.name); if (!byLoose.has(k)) byLoose.set(k, []); byLoose.get(k).push(p); }
  const dupNames = new Set(sheet.report.duplicates.map((d) => d.name));
  const mappingRows = new Map(sheet.report.conflicts.filter((c) => c.type === 'name_section_mismatch' || c.type === 'no_name').map((c) => [c.row, c.message]));
  // Rows whose own columns do not add up to their TOTAL (priced at the TOTAL, but worth checking in the spreadsheet).
  const sheetRows = new Map(sheet.report.conflicts.filter((c) => c.type === 'total_mismatch' || c.type === 'total_mismatch_unresolved').map((c) => [c.row, c.message]));

  const rows = [];
  for (const it of sheet.items) {
    const out = { row: it.row, name: it.name || `(no description – row ${it.row})`, spreadsheetPrice: it.spreadsheetPrice, bookPrice: null, quote1: null, quote5: null, expected5: round2(TEST_QTY * it.spreadsheetPrice), product: null, status: 'ok', notes: [] };
    // Match by exact name; duplicates and unnamed rows are told apart by their spreadsheet row.
    let candidates = (it.name && byName.get(it.name)) || [];
    if (candidates.length > 1 || !it.name) candidates = (candidates.length ? candidates : products).filter((p) => p.row === it.row);
    let p = candidates.find((c) => !c.used) || candidates[0];
    if (!p && it.name) {
      const loose = (byLoose.get(norm(it.name)) || []).find((c) => !c.used);
      if (loose) { p = loose; out.status = 'name_mismatch'; out.notes.push(`Name in the price book differs: "${loose.name}"`); }
    }
    if (!p) {
      out.status = 'missing';
      out.notes.push('Not in this price book');
      rows.push(out);
      continue;
    }
    p.used = true;
    out.product = { moduleKey: p.m.key, optionKey: p.o.key, module: p.m.name, uom: p.m.uom, available: p.o.available !== false };
    out.bookPrice = unitCostOf(p.m, p.o, idx).unitCost;
    const line = (qty) => priceLine({ id: 1, moduleKey: p.m.key, optionKey: p.o.key, qty }, { id: 'a' }, idx, ctx);
    out.quote1 = line(1).lineSell;
    out.quote5 = line(TEST_QTY).lineSell;
    if (!near(out.bookPrice, it.spreadsheetPrice)) { out.status = 'price_mismatch'; out.notes.push(`Price book ${out.bookPrice} vs spreadsheet ${it.spreadsheetPrice}`); }
    if (out.quote1 !== round2(it.spreadsheetPrice) || out.quote5 !== out.expected5) { out.status = 'price_mismatch'; out.notes.push(`Quote at 0% markup: 1 × = ${out.quote1}, ${TEST_QTY} × = ${out.quote5}; expected ${round2(it.spreadsheetPrice)} and ${out.expected5}`); }
    if (dupNames.has(it.name)) { if (out.status === 'ok') out.status = 'duplicate'; out.notes.push('Same name appears more than once in the spreadsheet'); }
    if (mappingRows.has(it.row)) { if (out.status === 'ok') out.status = 'mapping'; out.notes.push(mappingRows.get(it.row)); }
    if (sheetRows.has(it.row)) { if (out.status === 'ok') out.status = 'sheet_conflict'; out.notes.push(sheetRows.get(it.row)); }
    if (!out.product.available && it.spreadsheetPrice) out.notes.push('Switched off in the price book');
    rows.push(out);
  }
  const extra = products.filter((p) => !p.used).map((p) => ({
    row: p.row, name: p.name, spreadsheetPrice: null, bookPrice: unitCostOf(p.m, p.o, idx).unitCost, quote1: null, quote5: null, expected5: null,
    product: { moduleKey: p.m.key, optionKey: p.o.key, module: p.m.name, uom: p.m.uom, available: p.o.available !== false },
    status: 'extra', notes: ['In the price book but not in the spreadsheet'],
  }));
  const all = [...rows, ...extra];
  const count = (s) => all.filter((r) => r.status === s).length;
  const tiers = book.tiers.map((t) => ({ name: t.name, markup: t.markup, isDefault: t.isDefault }));
  const raw = book.tiers.find((t) => t.key === 'raw');
  const warnings = [];
  if (raw && Number(raw.markup) !== 0) warnings.push(`The "${raw.name}" tier adds ${raw.markup}% to the spreadsheet price.`);
  if (rows.length && count('missing') > rows.length / 2) warnings.push('Most spreadsheet products are not in this price book. It was probably built from a different spreadsheet (for example the older V0.1 workbook).');
  return {
    source: Buffer.isBuffer(source) ? sourceName : MATERIAL_LABOUR_SOURCE_NAME,
    book: { id: book.id, label: book.label, status: book.status },
    checkedAt: new Date().toISOString(), testQty: TEST_QTY, tiers, warnings,
    summary: {
      spreadsheetProducts: rows.length, priceBookProducts: products.length,
      ok: count('ok'), priceMismatches: count('price_mismatch'), missing: count('missing'), extra: count('extra'),
      nameMismatches: count('name_mismatch'), duplicates: count('duplicate'), mapping: count('mapping'), spreadsheetConflicts: count('sheet_conflict'),
    },
    rows: all,
  };
}

// Builds a price book from the "Material cost + Labour cost book pricing" spreadsheet (Sheet1).
//
// Rules (from the client brief): every row is imported exactly as provided. Names, descriptions and dollar values
// are not changed, rounded, merged or re-categorised. Rows of one product family (e.g. "Base Cabinet - …") become the
// options of one module, as the existing price book does, so area finishes, templates and repricing keep working.
// Duplicates and conflicts are reported, never resolved automatically.
//
// Columns: A item | B material | C hardware | D factory | E drafting | F studio | G (unused) | H install | I total | J note
// Labour is stored per option in dollars by trade (exact spreadsheet values), not as hours × rate.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './xlsx.js';
import { FINISH_GROUPS, ITEM_CATEGORY, buildLegacyPriceBook, cleanText, finishGroupsFor, slug, uomFor } from './legacy-import.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MATERIAL_LABOUR_FILE = path.join(here, 'source', 'material-labour-pricebook-2026-10.xlsx');
export const MATERIAL_LABOUR_SOURCE_NAME = 'Material cost + Labour cost book pricing .xlsx';

// Hourly rates only turn the spreadsheet's labour dollars into estimated hours (for scheduling and budgets);
// they never change a cost. Factory and Drafting rates are assumptions; edit them on the Labour rates tab.
export const ML_TRADES = [
  { key: 'FACTORY', name: 'Factory', rate: 70 },
  { key: 'DRAFTING', name: 'Drafting', rate: 80 },
  { key: 'STUDIO', name: 'Studio', rate: 80 },
  { key: 'INSTALL', name: 'Install', rate: 85 },
];
const LABOUR_COLS = [['FACTORY', 'D'], ['DRAFTING', 'E'], ['STUDIO', 'F'], ['INSTALL', 'H']];
const EXPECTED_HEADER = { D: /FACTORY/i, E: /DRAFTING/i, F: /STUDIO/i, H: /INSTALL/i, I: /TOTAL/i };

// Section headings (column A of a header row) → category for items in that section.
const SECTIONS = [
  [/^Standard Bulkhead/i, 'Panels & bulkheads'], [/^Mitred Bulkheads/i, 'Panels & bulkheads'], [/^Wall Pan+elling/i, 'Panels & bulkheads'],
  [/^Appliance Tower/i, 'Cabinetry'], [/^Bar Back Panel/i, 'Panels & bulkheads'], [/^Base End Panels/i, 'Panels & bulkheads'],
  [/^25mm base end panels/i, 'Panels & bulkheads'], [/^Wall End Panels/i, 'Panels & bulkheads'], [/^Tall End Panels/i, 'Panels & bulkheads'],
  [/^Sqa?ua?re Edge Benchtops/i, 'Benchtops'], [/^Mirror shaving cabinet/i, 'Cabinetry'], [/^Hardware$/i, 'Hardware & accessories'],
  [/^Hafele Wall Bed/i, 'Hardware & accessories'], [/^Hanging Rails/i, 'Hardware & accessories'], [/^Custom Doors/i, 'Decorative & specialty'],
  [/^LED/i, 'Lighting'], [/^Integration Services/i, 'Services'], [/^Drawer Inserts/i, 'Hardware & accessories'],
  [/^Laundry Hampers/i, 'Hardware & accessories'], [/^Laundry Chute/i, 'Hardware & accessories'], [/^Edging Of Carcass/i, 'Cabinetry'],
  [/^Steccawood/i, 'Decorative & specialty'], [/^Joinery Handles/i, 'Handles'], [/^Shadow line/i, 'Job extras'],
  [/^50mm Floating Shelf/i, 'Decorative & specialty'], [/^Microwave Pocket/i, 'Cabinetry'], [/^WIP doors/i, 'Cabinetry'],
  [/^Hampton/i, 'Decorative & specialty'], [/^Base cabinets/i, 'Cabinetry'], [/^Wall cabinets/i, 'Cabinetry'], [/^Tall cabinets/i, 'Cabinetry'],
];

// Product families. Module keys and names are the existing ones, so templates, area finishes and repricing still match.
// `prefix` is stripped only to build the internal option key; the option keeps the row's full text as its name.
const FAMILIES = [
  { key: 'bulkhead', sec: /^Standard Bulkhead/i, re: /^Bulkhead - /i, name: 'Bulkhead', cat: 'Panels & bulkheads', uom: 'LM' },
  { key: 'mitred-bulkhead', sec: /^Mitred Bulkheads/i, re: /^Mitred Bulkhead - /i, name: 'Mitred bulkhead', cat: 'Panels & bulkheads', uom: 'LM' },
  { key: 'wall-panelling', sec: /^Wall Pan+elling/i, re: /^Wall pan+els - /i, name: 'Wall panelling', cat: 'Panels & bulkheads', uom: 'LM' },
  { key: 'appliance-tower', sec: /^Appliance Tower/i, re: /^Tall Appliance Cabinet - /i, name: 'Appliance tower', cat: 'Cabinetry', uom: 'EA' },
  { key: 'bar-back', sec: /^Bar Back Panel/i, re: /^Bar back - /i, name: 'Bar back panel', cat: 'Panels & bulkheads', uom: 'EA' },
  { key: 'base-end-panel', sec: /^Base End Panels/i, re: /^Base End Panel ?- /i, name: 'Base end panel', cat: 'Panels & bulkheads', uom: 'EA' },
  { key: 'base-end-panel-25', sec: /^25mm base end panels/i, re: /^Base End Panel ?- /i, name: 'Base end panel – 25mm', cat: 'Panels & bulkheads', uom: 'EA' },
  { key: 'wall-end-panel', sec: /^Wall End Panels/i, re: /^Wall End Panels +- /i, name: 'Wall end panel', cat: 'Panels & bulkheads', uom: 'EA' },
  { key: 'tall-end-panel', sec: /^Tall End Panels 18mm/i, re: /^Tall End Panels +- /i, name: 'Tall end panel', cat: 'Panels & bulkheads', uom: 'EA' },
  { key: 'tall-end-panel-25', sec: /^Tall End Panels 25mm/i, re: /^Tall End Panels +- /i, name: 'Tall end panel – 25mm', cat: 'Panels & bulkheads', uom: 'EA' },
  { key: 'benchtop-33', sec: /^Sqa?ua?re Edge Benchtops \(/i, re: /^Square edge benchtop +/i, name: 'Square edge benchtop – 33mm', cat: 'Benchtops', uom: 'EA' },
  { key: 'benchtop-38-50', sec: /^Sqa?ua?re Edge Benchtops 38mm/i, re: /^Square edge benchtop +/i, name: 'Square edge benchtop – 38–50mm', cat: 'Benchtops', uom: 'EA' },
  { key: 'shaving-cabinet-1000', sec: /^Mirror shaving cabinet 1000mm/i, re: /^Mirrored shaving cabinet /i, name: 'Mirrored shaving cabinet – up to 1000mm', cat: 'Cabinetry', uom: 'EA' },
  { key: 'shaving-cabinet-1500', sec: /^Mirror shaving cabinet up to 1500mm/i, re: /^Mirrored shaving cabinet |^$/i, name: 'Mirrored shaving cabinet – up to 1500mm', cat: 'Cabinetry', uom: 'EA' },
  { key: 'drawer', sec: /^Hardware$/i, re: /^Drawer - /i, name: 'Drawer', cat: 'Hardware & accessories', uom: 'EA' },
  { key: 'inner-drawer', sec: /^Hardware$/i, re: /^Inner Drawer - /i, name: 'Inner drawer', cat: 'Hardware & accessories', uom: 'EA' },
  { key: 'hinges', sec: /^Hardware$/i, re: /^Blum 110 Degree Hinges and Plates/i, name: 'Hinges (per kitchen, approx. 30)', cat: 'Hardware & accessories', uom: 'JOB' },
  { key: 'appliance-integration', sec: /^Integration Services/i, re: /^Integration Service - /i, name: 'Appliance integration', cat: 'Services', uom: 'EA' },
  { key: 'mirror-polished', sec: /^Custom Doors/i, re: /^Mirror Polished All Around /i, name: 'Mirror, polished edges (no substrate)', cat: 'Decorative & specialty', uom: 'EA' },
  { key: 'shadowline', sec: /^Shadow line/i, re: /^Shadowline /i, name: 'Shadowline', cat: 'Job extras', uom: 'JOB' },
  { key: 'floating-shelf', sec: /^50mm Floating Shelf/i, re: /^50mm mitred floating shelf /i, name: '50mm mitred floating shelf', cat: 'Decorative & specialty', uom: 'EA' },
  { key: 'microwave-pocket', sec: /^Microwave Pocket/i, re: /^Microwave Pocket - /i, name: 'Microwave pocket base', cat: 'Cabinetry', uom: 'EA' },
  { key: 'wip-doors', sec: /^WIP doors/i, re: /^WIP doors with jamb \(2x hinged doors\) ?- /i, name: 'WIP doors with jamb', cat: 'Cabinetry', uom: 'EA' },
  { key: 'base-cabinet', sec: /^Base cabinets/i, re: /^Base Cabinet - /i, name: 'Base cabinet', cat: 'Cabinetry', uom: 'LM' },
  { key: 'base-open', sec: /^Base cabinets/i, re: /^Base Open cabinet with shelving ?- /i, name: 'Base open cabinet with shelving', cat: 'Cabinetry', uom: 'LM' },
  { key: 'wall-cabinet', sec: /^Wall cabinets/i, re: /^Wall +cabinet - /i, name: 'Wall cabinet', cat: 'Cabinetry', uom: 'LM' },
  { key: 'wall-open', sec: /^Wall cabinets/i, re: /^Wall Open cabinet with shelving ?- /i, name: 'Wall open cabinet with shelving', cat: 'Cabinetry', uom: 'LM' },
  // Rows 646–650 are named "Wall Cabinet - …" but sit in the Tall cabinets section with tall prices: imported where they
  // are listed (Tall cabinet) and reported as a conflict.
  { key: 'tall-cabinet', sec: /^Tall cabinets/i, re: /^(Tall|Wall) Cabinet - /i, name: 'Tall cabinet', cat: 'Cabinetry', uom: 'LM', expect: /^Tall Cabinet - /i },
  { key: 'tall-pantry', sec: /^Tall cabinets/i, re: /^Tall Open cabinet with shelving ?- /i, name: 'Tall open cabinet with shelving', cat: 'Cabinetry', uom: 'LM' },
];

const TITLE_ROWS = /^(ITEM by QTY|CHARGED BY LM)\s*$/i;
const isHeader = (c) => (typeof c.B === 'string' && /MATERIAL/i.test(c.B)) || (typeof c.D === 'string' && /FACTORY/i.test(c.D));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sumParts = (o) => (o.material || 0) + (o.hardware || 0) + Object.values(o.labourCost || {}).reduce((s, v) => s + v, 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;
const sideNotes = (cells, cols) => cols.filter((c) => cells[c] != null).map((c) => `${c}: ${cells[c]}`);
const SIDE_COLS = 'KLMNOPQRSTU'.split('');

// Same precedence as the existing price book import: carcass work is cabinetry, handles stay handles.
function categoryFor(name, sectionTitle) {
  if (/carcass/i.test(name)) return 'Cabinetry';
  if (/^Joinery Handles/i.test(sectionTitle || '')) return 'Handles';
  for (const [re, cat] of ITEM_CATEGORY) if (re.test(name)) return cat;
  for (const [re, cat] of SECTIONS) if (re.test(sectionTitle || '')) return cat;
  return 'Hardware & accessories';
}

/**
 * Read the spreadsheet and build a price book in the shape insertBook() expects, plus an import report.
 * @returns {{ book, report, items }} items = one record per imported spreadsheet row (for verification)
 */
export function buildMaterialLabourBook(file = MATERIAL_LABOUR_FILE) {
  const { sheet, rows } = readXlsx(file);
  const legacy = buildLegacyPriceBook();
  const modules = [];
  const byKey = new Map();
  const usedKeys = new Set();
  const items = [];
  const report = { source: MATERIAL_LABOUR_SOURCE_NAME, sheet, rowsRead: rows.length, sections: [], titles: [], notes: [], sideNotes: [], duplicates: [], conflicts: [], zeroPriced: [], totalOnly: [], textInNumberColumns: [], headerProblems: [] };

  let section = { title: '', note: '', row: 0 };
  let lastModule = null;
  let sort = 0;
  const uniqueModuleKey = (base) => { let k = base, i = 2; while (usedKeys.has(k)) k = `${base}-${i++}`; usedKeys.add(k); return k; };

  for (const { row, cells, formulas } of rows) {
    const side = sideNotes(cells, SIDE_COLS);
    if (side.length) report.sideNotes.push({ row, text: side.join(' | ') });
    const name = typeof cells.A === 'string' ? cells.A : cells.A != null ? String(cells.A) : '';

    if (isHeader(cells)) {
      for (const [col, re] of Object.entries(EXPECTED_HEADER)) {
        if (cells[col] != null && !re.test(String(cells[col]))) report.headerProblems.push({ row, message: `Column ${col} is headed "${cells[col]}"; expected ${re.source}.` });
      }
      if (name.trim()) {
        section = { title: name, note: typeof cells.J === 'string' ? cells.J : '', row };
        report.sections.push({ row, title: name });
      }
      continue;
    }

    const hasValues = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].some((c) => cells[c] != null);
    if (!hasValues) {
      if (!name.trim()) continue; // notes-only row (side columns already reported)
      if (TITLE_ROWS.test(name)) { report.titles.push({ row, text: name }); continue; }
      if (/^\*/.test(name.trim())) {
        report.notes.push({ row, text: name, attachedTo: lastModule ? lastModule.name : null });
        if (lastModule) lastModule.description = [lastModule.description, name].filter(Boolean).join(' · ');
        continue;
      }
    }

    // ---- an item row ----
    const option = { material: 0, hardware: 0, labourCost: {} };
    const notes = [];
    const numberCol = (col, label) => {
      const v = cells[col];
      if (v == null) return 0;
      if (isNum(v)) return v;
      report.textInNumberColumns.push({ row, column: col, label, text: String(v) });
      notes.push(`${label} column says "${v}"`);
      return 0;
    };
    option.material = numberCol('B', 'Material');
    option.hardware = numberCol('C', 'Hardware');
    for (const [trade, col] of LABOUR_COLS) {
      const v = cells[col];
      if (v == null) continue;
      if (isNum(v)) option.labourCost[trade] = v;
      else { report.textInNumberColumns.push({ row, column: col, label: trade, text: String(v) }); notes.push(`${trade} column says "${v}"`); }
    }
    if (cells.G != null) report.conflicts.push({ row, name, type: 'unexpected_column', message: `Column G (no heading) has "${cells.G}". Not imported.` });
    const total = isNum(cells.I) ? cells.I : null;
    const parts = sumParts(option);
    let totalOnly = false;
    if (total != null && parts === 0 && total !== 0) {
      // Only a total is given (e.g. integration services): the total is the cost.
      option.material = total;
      totalOnly = true;
      report.totalOnly.push({ row, name, total });
      notes.push('Spreadsheet gives a total only (no material/labour split); imported as a lump-sum cost');
    } else if (total != null && !near(parts, total)) {
      // The TOTAL column is the spreadsheet's price and the single source of truth. Where the row's own TOTAL formula
      // leaves out a column (row 385 sums D:H and skips material), the price follows TOTAL: the material counted in
      // the cost is TOTAL minus the other columns, and the material figure as written is kept in the note.
      const rest = parts - option.material;
      if (total - rest >= 0) {
        notes.push(`Material column shows ${option.material}, but the spreadsheet TOTAL (${formulas.I ? `=${formulas.I}` : total}) is ${total}; priced at the TOTAL`);
        report.conflicts.push({ row, name, type: 'total_mismatch', message: `TOTAL column is ${total}${formulas.I ? ` (=${formulas.I})` : ''} but the columns add up to ${parts}. Priced at the spreadsheet TOTAL ${total}; material counted as ${total - rest} instead of ${option.material}. Please confirm which is right.` });
        option.material = total - rest;
      } else {
        report.conflicts.push({ row, name, type: 'total_mismatch_unresolved', message: `TOTAL column is ${total} but hardware and labour alone add up to ${rest}. Imported the columns (${parts}); please correct the spreadsheet.` });
      }
    } else if (total == null && parts) {
      report.conflicts.push({ row, name, type: 'no_total', message: `No TOTAL value; the columns add up to ${parts}.` });
    }
    if (typeof cells.J === 'string' && cells.J.trim()) notes.push(cells.J);

    const fam = FAMILIES.find((f) => f.sec.test(section.title) && f.re.test(name));
    let mod;
    let optKeyBase;
    let optionName;
    let fullName = true;
    if (fam) {
      mod = byKey.get(fam.key);
      if (!mod) {
        mod = { key: uniqueModuleKey(fam.key), name: fam.name, category: fam.cat, uom: fam.uom, description: [section.title, section.note].filter((s) => s && s.trim()).join(' · '), sort: sort++, labour: {}, options: [] };
        byKey.set(fam.key, mod);
        modules.push(mod);
      }
      if (fam.expect && !fam.expect.test(name)) {
        report.conflicts.push({ row, name, type: 'name_section_mismatch', message: `Named "${name.split(' - ')[0]}" but listed under "${section.title.trim()}" with ${fam.name.toLowerCase()} prices. Imported under ${fam.name} as listed.` });
      }
      optionName = name;
      optKeyBase = slug(cleanText(name.replace(fam.re, '')));
      if (!name.trim()) {
        optionName = `(no description in spreadsheet – row ${row})`;
        optKeyBase = `row-${row}`;
        report.conflicts.push({ row, name: '', type: 'no_name', message: `Row ${row} has prices (total ${total ?? parts}) but no description. Imported as unavailable until it is named.` });
      }
    } else {
      if (!name.trim()) {
        report.conflicts.push({ row, name: '', type: 'no_name', message: `Row ${row} has prices but no description and no product family. Not imported.` });
        continue;
      }
      mod = { key: uniqueModuleKey(slug(cleanText(name))), name, category: categoryFor(name, section.title), uom: uomFor(name), description: section.note && section.note.trim() ? section.note : '', sort: sort++, labour: {}, options: [] };
      modules.push(mod);
      optionName = 'Standard';
      optKeyBase = 'standard';
      fullName = false;
    }
    lastModule = mod;

    let key = optKeyBase || 'item';
    for (let i = 2; mod.options.some((o) => o.key === key); i++) key = `${optKeyBase}-${i}`;
    const unitCost = sumParts(option);
    const available = unitCost > 0 && !!name.trim();
    if (unitCost === 0) report.zeroPriced.push({ row, name: name || optionName });
    if (unitCost === 0) notes.push('No price in the spreadsheet. Set a cost to enable.');
    mod.options.push({
      key, name: optionName, fullName,
      finishGroups: fam ? finishGroupsFor(name.replace(fam.re, '')) : [],
      material: option.material, hardware: option.hardware, labourFactor: 1, labourCost: option.labourCost,
      available, costBasis: 'component', note: notes.join(' · '), source: `Spreadsheet row ${row}`, sort: mod.options.length,
    });
    // spreadsheetPrice: the price as the spreadsheet states it (TOTAL; the column sum when a row has no TOTAL).
    items.push({ row, name, moduleKey: mod.key, optionKey: key, material: option.material, hardware: option.hardware, labourCost: { ...option.labourCost }, total, totalOnly, unitCost, spreadsheetPrice: total ?? parts });
  }

  // Duplicates: identical names, then names that only differ by case or spacing.
  const groups = new Map();
  for (const it of items.filter((i) => i.name.trim())) {
    const k = it.name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const [name, list] of groups) {
    if (list.length < 2) continue;
    const same = list.every((i) => near(i.unitCost, list[0].unitCost));
    report.duplicates.push({ name, rows: list.map((i) => i.row), samePrice: same, costs: list.map((i) => i.unitCost), kind: 'identical name' });
    if (!same) report.conflicts.push({ row: list[0].row, name, type: 'duplicate_different_price', message: `The same name appears on rows ${list.map((i) => i.row).join(', ')} with different costs (${list.map((i) => i.unitCost).join(' / ')}). All imported; please confirm which is right.` });
  }
  const loose = new Map();
  for (const it of items.filter((i) => i.name.trim())) {
    const k = it.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!loose.has(k)) loose.set(k, []);
    loose.get(k).push(it);
  }
  for (const list of loose.values()) {
    if (list.length < 2 || list.every((i) => i.name === list[0].name)) continue;
    report.duplicates.push({ name: list[0].name, rows: list.map((i) => i.row), samePrice: list.every((i) => near(i.unitCost, list[0].unitCost)), costs: list.map((i) => i.unitCost), kind: 'same name apart from capitals or spaces' });
  }

  report.itemsImported = items.length;
  report.modules = modules.length;
  report.options = modules.reduce((n, m) => n + m.options.length, 0);

  const book = {
    label: 'Material + Labour cost book (Oct 2026)',
    note: `Imported from "${MATERIAL_LABOUR_SOURCE_NAME}" (${sheet}). Material, hardware and labour dollars (factory, drafting, studio, install) are exactly as in the spreadsheet.`,
    trades: ML_TRADES.map((t, i) => ({ ...t, sort: i })),
    finishGroups: FINISH_GROUPS.map(([key, name], i) => ({ key, name, sort: i })),
    // Retail and Builder markups as before. "Raw" was copied from the old workbook as cost + 5%; for this price book it
    // is the spreadsheet price itself (0%), so raw-cost pricing equals the spreadsheet exactly.
    tiers: legacy.tiers.map((t) => (t.key === 'raw' ? { ...t, name: 'Raw cost (spreadsheet price)', markup: 0 } : t)),
    modules,
    materials: legacy.materials,
  };
  return { book, report, items };
}

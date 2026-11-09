// Converts the legacy Excel price book (legacy-pricebook.json, extracted from the Butlers Kitchen tab) into
// normalised price book data: modules + options + finish groups + trades + tiers + reference materials.
//
// Parity rule: every option's unit cost equals the workbook's (trade $400 + material) exactly.
// Where the workbook back-solved a negative material, material becomes 0 and the labour factor is scaled
// down instead (cost_basis 'legacy'), so costs stay non-negative and the sell price is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const LEGACY_TRADES = [
  { key: 'STUDIO', name: 'Studio', rate: 80 },
  { key: 'LABOUR', name: 'Labour', rate: 70 },
  { key: 'BUILD', name: 'Build', rate: 35 },
  { key: 'INSTALL', name: 'Install', rate: 85 },
  { key: 'DELIVERY', name: 'Delivery', rate: 90 },
  { key: 'CUT', name: 'Cut', rate: 40 },
  { key: 'BUFFER', name: 'Buffer', rate: 0 },
];
const LEGACY_LABOUR = { STUDIO: 1, LABOUR: 1, BUILD: 1, INSTALL: 1, DELIVERY: 1, CUT: 1 };
const LEGACY_TRADE_COST = 400;

export const FINISH_GROUPS = [
  ['FG01', '16mm White HMR / Raw MDF', /white hmr|raw mdf/i],
  ['FG02', '16mm Polytec Matt / Black HMR', /\bmatt\b|black hmr/i],
  ['FG03', '16mm Polytec Woodmatt / Smooth / Ravine', /woodmatt|ravine|polytec (woodmatt|smooth)/i],
  ['FG04', '18mm Nikpol Feelwood / Polytec Boston Oak', /feelwood|boston oak/i],
  ['FG05', '18mm Polyurethane flat profile / NAV Elements', /polyurethane flat profile|nav elements|^polyurethane( \/|$)|^18mm polyurethane flat|polyurethane \/ feelwood/i],
  ['FG06', '18mm NAV Urban Smooth / 21mm Poly flat / Sincro Evenex', /nav ?urban smooth|sincro evenex|nav smooth|evenex 'tuscan oak'|21mm polyurethane flat|diamond & smooth/i],
  ['FG07', '18mm Tesrol Superclean / NAV Diamond / Polytec Venette', /supe?r?clean|diamond|venn?ette/i],
  ['FG08', '18mm Poly shaker, 40mm rail, 3mm recess', /shaker profile rail 40mm/i],
  ['FG09', '21mm Poly shaker, 5mm recess', /polyurethane shaker profile \(5mm/i],
  ['FG10', '19mm American Oak veneer, clear poly', /american oak/i],
  ['FG11', '19mm Blackbutt veneer, clear poly', /black ?butt/i],
  ['FG12', '18mm Naveneer G2S', /naveneer/i],
  ['FG13', '18mm Poly Scandinavian profile', /18mm polyurethane scandinavian/i],
  ['FG14', '13mm Compact laminate, no frame', /compact laminate (with )?no frame/i],
  ['FG15', '25mm Poly Scandinavian profile', /25mm polyurethane scandinavian/i],
  ['FG16', '19mm Eveneer Dusk G2S', /eveneer dusk/i],
  ['FG17', '13mm Compact laminate, with frame', /compact laminate with frame/i],
  ['FG18', 'Farmers Doors slimline oak, 3mm recess', /farmers.*3mm/i],
  ['FG19', 'Farmers Doors slimline oak, 8mm recess', /farmers.*8mm/i],
  ['TD560', 'Tesrol Design / Profile 560 series', /profile 560 series/i],
  ['TD600', 'Tesrol Design / Profile 600 series', /profile 600 series/i],
];

// Module families: lines sharing a prefix become one module with one option per finish.
const FAMILIES = [
  { key: 'base-cabinet', re: /^Base Cabinet - /i, name: 'Base cabinet', cat: 'Cabinetry', uom: 'LM', desc: 'Up to 650mm deep × 900mm high.' },
  { key: 'base-open', re: /^Base Open cabinet with shelving - /i, name: 'Base open cabinet with shelving', cat: 'Cabinetry', uom: 'LM', desc: '1× adjustable shelf.' },
  { key: 'wall-cabinet', re: /^Wall Cabinet - /i, name: 'Wall cabinet', cat: 'Cabinetry', uom: 'LM', desc: 'Up to 370mm deep × 1000mm high, including underpanel and 30mm shadowline.' },
  { key: 'wall-open', re: /^Wall Open cabinet with shelving - /i, name: 'Wall open cabinet with shelving', cat: 'Cabinetry', uom: 'LM', desc: '2× adjustable shelves.' },
  { key: 'tall-cabinet', re: /^Tall Cabinet - /i, name: 'Tall cabinet', cat: 'Cabinetry', uom: 'LM', desc: 'Up to 650mm deep × 2700mm high, including 30mm shadowline.' },
  { key: 'tall-pantry', re: /^Tall Open Pantry with shelving - /i, name: 'Tall open pantry with shelving', cat: 'Cabinetry', uom: 'LM', desc: '' },
  { key: 'bulkhead', re: /^Bulkhead - /i, name: 'Bulkhead', cat: 'Panels & bulkheads', uom: 'LM', desc: 'Up to 350mm high.' },
  { key: 'mitred-bulkhead', re: /^Mitred Bulkhead - /i, name: 'Mitred bulkhead', cat: 'Panels & bulkheads', uom: 'LM', desc: 'Small–medium job (no more than 6 LM of bulkhead).' },
  { key: 'wall-panelling', re: /^Wall pan+elling - /i, name: 'Wall panelling', cat: 'Panels & bulkheads', uom: 'LM', desc: '' },
  { key: 'appliance-tower', re: /^Tall Appliance Cabinet - /i, name: 'Appliance tower', cat: 'Cabinetry', uom: 'EA', desc: 'Up to 600mm deep × 2700mm high. 1× 600mm oven tower including 2 drawers below ovens.' },
  { key: 'bar-back', re: /^Bar Back +- /i, name: 'Bar back panel', cat: 'Panels & bulkheads', uom: 'EA', desc: '1 panel, 3000 × 880mm.' },
  { key: 'base-end-panel', section: /^Base End Panels/i, re: /^Base End Panel - /i, name: 'Base end panel', cat: 'Panels & bulkheads', uom: 'EA', desc: '1 panel, 650 × 900mm.' },
  { key: 'base-end-panel-25', section: /^25mm base end panels/i, re: /^Base End Panel - /i, name: 'Base end panel – 25mm', cat: 'Panels & bulkheads', uom: 'EA', desc: '1 panel, 650 × 900mm, 25mm thick.' },
  { key: 'wall-end-panel', re: /^Wall End Panel - /i, name: 'Wall end panel', cat: 'Panels & bulkheads', uom: 'EA', desc: '1 panel, 370 × 1000mm.' },
  { key: 'tall-end-panel', section: /^Tall End Panels/i, re: /^Tall End Panel ?- /i, name: 'Tall end panel', cat: 'Panels & bulkheads', uom: 'EA', desc: '1 panel, 650 × 2700mm.' },
  { key: 'tall-end-panel-25', section: /^25mm \/ 32mm tall end panels/i, re: /^Tall End Panel ?- /i, name: 'Tall end panel – 25/32mm', cat: 'Panels & bulkheads', uom: 'EA', desc: '1 panel, 650 × 2700mm, 25mm or 32mm thick.' },
  { key: 'benchtop-33', re: /^Square edge benchtop 33 - /i, name: 'Square edge benchtop – 33mm', cat: 'Benchtops', uom: 'EA', desc: 'Per 1000 × 650mm.' },
  { key: 'benchtop-38-50', re: /^Square edge benchtop 38-50mm - /i, name: 'Square edge benchtop – 38–50mm', cat: 'Benchtops', uom: 'EA', desc: 'Per 1000 × 650mm.' },
  { key: 'shaving-cabinet-1000', section: /^Mirror shaving cabinet <1000mm/i, re: /^Mirrored shaving cabinet w\/ end panels - /i, name: 'Mirrored shaving cabinet – up to 1000mm', cat: 'Cabinetry', uom: 'EA', desc: 'Up to 1000mm wide × 900mm high × 180mm deep, with end panels.' },
  { key: 'shaving-cabinet-1500', section: /^Mirror shaving cabinet up to 1500mm/i, re: /^Mirrored shaving cabinet w\/ end panels - /i, name: 'Mirrored shaving cabinet – up to 1500mm', cat: 'Cabinetry', uom: 'EA', desc: 'Up to 1500mm wide × 900mm high × 180mm deep, with end panels.' },
  { key: 'floating-shelf', re: /^50mm mitred floating shelf up to 1200mm wide - /i, name: '50mm mitred floating shelf', cat: 'Decorative & specialty', uom: 'EA', desc: 'Up to 1200mm wide.' },
  { key: 'microwave-pocket', re: /^Microwave pocket - /i, name: 'Microwave pocket base', cat: 'Cabinetry', uom: 'EA', desc: '600mm wide, 1× drawer below.' },
  { key: 'wip-doors', re: /^WIP doors with jamb \(2x hinged doors\) - /i, name: 'WIP doors with jamb', cat: 'Cabinetry', uom: 'EA', desc: '2× hinged doors, frame to match door material. 2700H × 150D × 1200W.' },
  { key: 'drawer', re: /^Drawer - /i, name: 'Drawer', cat: 'Hardware & accessories', uom: 'EA', desc: '' },
  { key: 'inner-drawer', re: /^Inner Drawer - /i, name: 'Inner drawer', cat: 'Hardware & accessories', uom: 'EA', desc: '' },
  { key: 'hinges', re: /^Hinges - /i, name: 'Hinges (per kitchen, approx. 30)', cat: 'Hardware & accessories', uom: 'JOB', desc: 'Silver hinges are already included in the cabinet LM rates. Check before adding.' },
  { key: 'appliance-integration', re: /^Integration Service - /i, name: 'Appliance integration', cat: 'Services', uom: 'EA', desc: '' },
  { key: 'mirror-polished', re: /^Mirror Polished All Around /i, name: 'Mirror, polished edges (no substrate)', cat: 'Decorative & specialty', uom: 'EA', desc: '', optionFrom: (n) => n.replace(/^Mirror Polished All Around /i, '').replace(/\(No Substrate\)/i, '').trim() },
  { key: 'shadowline', re: /^Shadowline /i, name: 'Shadowline', cat: 'Job extras', uom: 'JOB', desc: 'Choose by job size.', optionFrom: (n) => n.replace(/^Shadowline /i, '').replace(/ job$/i, '') },
  { key: 'delivery', re: /^Delivery /i, name: 'Delivery', cat: 'Services', uom: 'JOB', desc: '', optionFrom: (n) => n.replace(/^Delivery /i, '') },
];

const SECTION_CATEGORY = [
  [/^Hardware|^Drawer Inserts|^Laundry Hampers|^Hanging Rails|^Laundry Chute/i, 'Hardware & accessories'],
  [/^Joinery Handles/i, 'Handles'],
  [/^Steccawood|^Hampton|^Laminating/i, 'Decorative & specialty'],
  [/^MISCELLANEOUS/i, 'Services'],
  [/^WIP doors/i, 'Cabinetry'],
];
export const ITEM_CATEGORY = [
  [/consultation|technician|return visit|extra install fee/i, 'Services'],
  [/^curve|pivot door|mesh insert|mitred|proud kick|boxed legs|v-groove|shaker profile using/i, 'Decorative & specialty'],
  [/shoe shelf|inward/i, 'Cabinetry'],
  [/\bled\b/i, 'Lighting'],
];

const TYPO_FIXES = [
  [/Sqaure/g, 'Square'], [/Pannelling/gi, 'Panelling'], [/Supeclean/g, 'Superclean'], [/hamoper/g, 'hamper'],
  [/aluminim/g, 'aluminium'], [/mathcing/g, 'matching'], [/Perferated/g, 'Perforated'], [/polyruethane/g, 'polyurethane'],
  [/Scandianvian/g, 'Scandinavian'], [/rangehoos/g, 'rangehood'], [/Vennette/g, 'Venette'], [/Anataro/g, 'Antaro'],
  [/Navurban/g, 'NAV Urban'], [/\bpul out\b/g, 'pull out'], [/ tp /g, ' to '], [/Paritical/g, 'Particle'], [/Amerian/g, 'American'],
  [/ then /g, ' than '], [/16m Polytec/g, '16mm Polytec'], [/Black Butt/g, 'Blackbutt'], [/\s+/g, ' '],
];
export const cleanText = (s) => TYPO_FIXES.reduce((t, [re, rep]) => t.replace(re, rep), s).trim();

// Names that carried pricing notes or people's names move into notes.
const NAME_REWRITES = [
  [/^Tibo’?'?s pricing for 3mm Solid Brass Frame with Waxed Finish for mirror size 900x1200mm with radius corners/i, '3mm solid brass mirror frame, waxed finish (900 × 1200mm, radius corners)', "Source: Tibo's pricing."],
  [/^Jeremey Price for 3mm Stainless Steel Frame w\/ Brass look powdercoated finish for the same size above/i, '3mm stainless steel mirror frame, brass-look powdercoat (900 × 1200mm)', "Source: Jeremey's price."],
  [/^Shaker profile using a prefinished board – Leon told me to price as \$500 per door\/drawer/i, 'Shaker profile using prefinished board (per door/drawer)', 'Pricing instruction from Leon: $500 per door/drawer.'],
  [/^Curve - Tall curved void box laminated \(North Kellyville Project\)/i, 'Curve - Tall curved void box, laminated', 'Reference: North Kellyville project.'],
  [/^\*Cabinets to conceal chute is an additional cost/i, null, null],
  [/^Extras$/i, 'Extras (legacy placeholder)', 'Use a custom item instead.'],
  [/^\*2x doors in Polytec Woodmatt/i, 'Laminating by Super Benchtops – 2× doors, Polytec Woodmatt', 'Subcontract.'],
  [/^\*1x top in Polytec Woodmatt/i, 'Laminating by Super Benchtops – 1× top, Polytec Woodmatt', 'Subcontract.'],
  [/^Handles $|^Handles$/i, 'Handles (legacy allowance)', ''],
];

export function slug(s) {
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
}

export function finishGroupsFor(text) {
  const keys = [];
  if (/25mm polyurethane scandinavian/i.test(text)) keys.push('FG15');
  for (const [key, , re] of FINISH_GROUPS) {
    if (key === 'FG13' && keys.includes('FG15') && !/18mm polyurethane scandinavian/i.test(text)) continue;
    if (re.test(text) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function categoryFor(section, name) {
  if (/carcass/i.test(name)) return 'Cabinetry';
  if (/^Joinery Handles/i.test(section || '')) return 'Handles';
  for (const [re, cat] of ITEM_CATEGORY) if (re.test(name)) return cat;
  for (const [re, cat] of SECTION_CATEGORY) if (re.test(section || '')) return cat;
  return 'Hardware & accessories';
}

export function uomFor(name) {
  if (/pm2|per m2|\bm2\b/i.test(name)) return 'M2';
  if (/per kitchen|\bjob\b/i.test(name)) return 'JOB';
  return 'EA';
}

function costing(material) {
  // Preserve the workbook's unit cost (400 + material) without negative materials.
  if (material >= 0) return { material, labourFactor: 1, basis: 'legacy' };
  const total = LEGACY_TRADE_COST + material;
  return { material: 0, labourFactor: Math.max(0, total) / LEGACY_TRADE_COST, basis: 'legacy' };
}

export function buildLegacyPriceBook(file = path.join(here, 'legacy-pricebook.json')) {
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  const modules = [];
  const byKey = new Map();
  const usedKeys = new Set();
  const issues = [];

  const uniqueKey = (base) => {
    let k = base, i = 2;
    while (usedKeys.has(k)) k = `${base}-${i++}`;
    usedKeys.add(k);
    return k;
  };

  let sort = 0;
  for (const row of legacy.rows) {
    if (!row.name || /\(TOTAL\)\s*$/i.test(row.name)) continue;
    let name = row.name.trim();
    let note = '';
    for (const [re, rep, n] of NAME_REWRITES) {
      if (re.test(name)) { name = rep; note = n || ''; break; }
    }
    if (name === null) continue; // a note row, not a priced item
    const fam = FAMILIES.find((f) => f.re.test(name) && (!f.section || f.section.test(row.section || '')));
    const { material, labourFactor, basis } = costing(row.material);
    const unitCost = LEGACY_TRADE_COST * labourFactor + material;

    let mod;
    let optionName;
    if (fam) {
      mod = byKey.get(fam.key);
      if (!mod) {
        mod = { key: uniqueKey(fam.key), name: fam.name, category: fam.cat, uom: fam.uom, description: fam.desc, sort: sort++, labour: { ...LEGACY_LABOUR }, options: [] };
        byKey.set(fam.key, mod);
        modules.push(mod);
      }
      optionName = cleanText(fam.optionFrom ? fam.optionFrom(name) : name.replace(fam.re, ''));
    } else {
      const clean = cleanText(name);
      mod = { key: uniqueKey(slug(clean)), name: clean, category: categoryFor(row.section, clean), uom: uomFor(clean), description: '', sort: sort++, labour: { ...LEGACY_LABOUR }, options: [] };
      modules.push(mod);
      optionName = 'Standard';
    }
    optionName = optionName.charAt(0).toUpperCase() + optionName.slice(1);

    let available = true;
    if (/does not come in 25mm/i.test(optionName)) { available = false; note = 'Board is not made in 25mm.'; optionName = optionName.replace(/\s*\(Board does not come in 25mm\)/i, ''); }
    if (unitCost === 0) { available = false; note = note || 'No price in the legacy price book. Set a cost to enable.'; issues.push(`${mod.name} – ${optionName}: zero cost, disabled`); }
    if (row.material < 0) issues.push(`${mod.name} – ${optionName}: negative material ${row.material} → labour factor ${labourFactor.toFixed(4)}`);

    const okey = mod.options.some((o) => o.key === slug(optionName)) ? `${slug(optionName)}-${mod.options.length + 1}` : slug(optionName);
    mod.options.push({
      key: okey, name: optionName, finishGroups: fam ? finishGroupsFor(optionName) : [],
      material, hardware: 0, labourFactor: Math.round(labourFactor * 1e6) / 1e6, available, costBasis: basis,
      note, source: `Legacy workbook row ${row.row}`, sort: mod.options.length,
    });
  }

  const materials = legacy.materials.map((m, i) => {
    let sheetSize = m.sheetSize;
    let note = m.note || '';
    if (/NAVENEER/i.test(m.product) && /^300x1200$/i.test(sheetSize)) { sheetSize = '3000 x 1200'; note = 'Sheet size corrected from "300x1200".'; }
    return { supplier: cleanText(m.supplier), product: cleanText(m.product), thickness: m.thickness, sheetSize, m2Rate: m.m2Rate, sheetRate: m.sheetRate, note, sort: i };
  });

  return {
    label: 'Legacy import (V0.1 workbook)',
    note: 'Imported from Vicello_Master Job Managment Suite_V0.1.xlsx. Sell prices match the workbook. Labour is the legacy flat split pending calibration.',
    trades: LEGACY_TRADES.map((t, i) => ({ ...t, sort: i })),
    finishGroups: FINISH_GROUPS.map(([key, name], i) => ({ key, name, sort: i })),
    tiers: [
      { key: 'retail', name: 'Retail', markup: 57.5, isDefault: true, sort: 0 },
      { key: 'builder', name: 'Builder', markup: 47, isDefault: false, sort: 1 },
      { key: 'raw', name: 'Raw (cost + 5%)', markup: 5, isDefault: false, sort: 2 },
    ],
    modules,
    materials,
    issues,
  };
}

export const DEFAULT_TEMPLATES = [
  { name: 'Kitchen – standard', areaType: 'kitchen', defaultFinish: 'FG03', lines: ['base-cabinet', 'wall-cabinet', 'tall-cabinet', 'appliance-tower', 'base-end-panel', 'tall-end-panel', 'drawer', 'mitred-bulkhead'] },
  { name: "Butler's pantry", areaType: 'butlers', defaultFinish: 'FG03', lines: ['base-cabinet', 'wall-open', 'tall-pantry', 'base-end-panel', 'drawer'] },
  { name: 'Wardrobe / walk-in robe', areaType: 'wardrobe', defaultFinish: 'FG01', lines: ['tall-cabinet', 'tall-end-panel', 'drawer', 'wip-doors'] },
  { name: 'Laundry', areaType: 'laundry', defaultFinish: 'FG02', lines: ['base-cabinet', 'wall-cabinet', 'tall-cabinet', 'base-end-panel'] },
  { name: 'Linen press', areaType: 'linen', defaultFinish: 'FG01', lines: ['tall-cabinet', 'tall-end-panel'] },
  { name: 'Vanity', areaType: 'vanity', defaultFinish: 'FG03', lines: ['base-cabinet', 'shaving-cabinet-1000', 'base-end-panel'] },
  { name: 'Alfresco', areaType: 'alfresco', defaultFinish: 'FG14', lines: ['base-cabinet', 'base-end-panel', 'benchtop-33'] },
];

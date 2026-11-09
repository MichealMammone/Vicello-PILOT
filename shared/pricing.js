// Pricing engine. Pure functions only: no I/O, no clock, no globals.
// Shared verbatim by the browser (live totals) and the server (authoritative pricing on save/quote).

export const CUSTOM_MODULE = '__custom';

export const OVERRIDE_TYPES = {
  unit_sell: 'Unit sell price',
  markup: 'Markup %',
  line_sell: 'Line sell total',
  unit_cost: 'Unit cost',
};

/** Round half away from zero to cents, tolerant of binary float noise (e.g. 1.005). */
export function round2(n) {
  if (!Number.isFinite(n)) return 0;
  const v = Math.round(Math.abs(n) * 100 + 1e-6) / 100;
  return n < 0 ? -v : v;
}

const num = (v, d = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : d;
};

/** Build lookup maps for a price book snapshot (see server/services/pricebook.service.js#loadBook). */
export function indexBook(book) {
  const trades = new Map(book.trades.map((t) => [t.key, t]));
  const modules = new Map();
  const options = new Map();
  for (const m of book.modules) {
    modules.set(m.key, m);
    for (const o of m.options) options.set(`${m.key}::${o.key}`, o);
  }
  const tiers = new Map(book.tiers.map((t) => [t.key, t]));
  const finishGroups = new Map(book.finishGroups.map((f) => [f.key, f]));
  return { book, trades, modules, options, tiers, finishGroups };
}

/** Pick the option a line uses: explicit choice, else one matching the area's default finish, else the only option. */
export function resolveOption(mod, line, area) {
  if (!mod) return { option: null, inherited: false };
  if (line.optionKey) {
    return { option: mod.options.find((o) => o.key === line.optionKey) || null, inherited: false };
  }
  if (area && area.defaultFinish) {
    const match = mod.options.find((o) => o.available !== false && (o.finishGroups || []).includes(area.defaultFinish));
    if (match) return { option: match, inherited: true };
  }
  const usable = mod.options.filter((o) => o.available !== false);
  if (usable.length === 1) return { option: usable[0], inherited: true };
  return { option: null, inherited: false };
}

/**
 * Unit cost build-up for an option: material + hardware + labour.
 * Labour is either dollars per trade set on the option (labourCost, used exactly as entered; hours are estimated at
 * the trade's hourly rate) or the module's hours x trade rates x the option's labour factor.
 */
export function unitCostOf(mod, option, idx) {
  const hours = {};
  const labourByTrade = {};
  let labour = 0;
  const fixed = option.labourCost && Object.keys(option.labourCost).length ? option.labourCost : null;
  if (fixed) {
    for (const [tradeKey, dollars] of Object.entries(fixed)) {
      const d = num(dollars);
      if (d === 0) continue;
      labour += d;
      labourByTrade[tradeKey] = d;
      const rate = num(idx.trades.get(tradeKey)?.rate);
      if (rate > 0) hours[tradeKey] = d / rate;
    }
  } else {
    const factor = num(option.labourFactor, 1);
    for (const [tradeKey, h] of Object.entries(mod.labour || {})) {
      const trade = idx.trades.get(tradeKey);
      if (!trade) continue;
      const hrs = num(h) * factor;
      if (hrs === 0) continue;
      hours[tradeKey] = hrs;
      labourByTrade[tradeKey] = hrs * num(trade.rate);
      labour += labourByTrade[tradeKey];
    }
  }
  const material = num(option.material);
  const hardware = num(option.hardware);
  return { material, hardware, labour, hours, labourByTrade, unitCost: material + hardware + labour };
}

/**
 * Price one line.
 * @param line   { id, moduleKey, optionKey, qty, description, custom?: {unitCost, uom}, override?: {type, value, reason, approvedBy} }
 * @param area   { id, defaultFinish }
 * @param idx    indexBook() result
 * @param ctx    { markup (fraction), floorMargin (fraction) }
 */
export function priceLine(line, area, idx, ctx) {
  const qty = num(line.qty);
  const warnings = [];
  const warn = (level, code, message) => warnings.push({ level, code, message, lineId: line.id, areaId: area && area.id });
  const r = {
    id: line.id, qty, moduleKey: line.moduleKey, optionKey: null, optionInherited: false,
    moduleName: '', optionName: '', uom: 'EA', description: line.description || '',
    unitMaterial: 0, unitHardware: 0, unitLabour: 0, unitCost: 0, hoursPerUnit: {}, unitLabourByTrade: {},
    markup: ctx.markup, unitSell: 0, lineCost: 0, lineSell: 0, margin: 0, marginPct: 0,
    hours: {}, overridden: false, warnings,
  };

  let base;
  if (line.moduleKey === CUSTOM_MODULE) {
    const c = line.custom || {};
    r.moduleName = 'Custom item';
    r.uom = c.uom || 'EA';
    base = { material: num(c.unitCost), hardware: 0, labour: 0, hours: {}, unitCost: num(c.unitCost) };
    if (!r.description.trim()) warn('error', 'custom_description', 'Custom item needs a description.');
  } else {
    const mod = idx.modules.get(line.moduleKey);
    if (!mod) {
      warn('error', 'missing_module', `Module "${line.moduleKey}" is not in this price book.`);
      return r;
    }
    r.moduleName = mod.name;
    r.uom = mod.uom;
    const { option, inherited } = resolveOption(mod, line, area);
    if (!option) {
      if (qty !== 0) warn('error', 'choose_option', `Choose a finish or option for "${mod.name}".`);
      return r;
    }
    r.optionKey = option.key;
    r.optionInherited = inherited;
    r.optionName = option.name;
    // fullName: the option's name is already the complete item description (imported price book rows).
    if (!r.description) r.description = option.fullName ? option.name : option.name && option.name !== 'Standard' ? `${mod.name} – ${option.name}` : mod.name;
    if (option.available === false && qty !== 0) warn('error', 'unavailable', `"${r.description}" is not available${option.note ? `: ${option.note}` : '.'}`);
    base = unitCostOf(mod, option, idx);
  }

  r.unitMaterial = base.material;
  r.unitHardware = base.hardware;
  r.unitLabour = base.labour;
  r.unitCost = base.unitCost;
  r.hoursPerUnit = base.hours;
  r.unitLabourByTrade = base.labourByTrade || {};

  const ov = line.override && line.override.type ? line.override : null;
  if (ov && ov.type === 'unit_cost') r.unitCost = num(ov.value);

  r.lineCost = round2(r.unitCost * qty);
  r.unitSell = r.unitCost * (1 + ctx.markup);
  r.lineSell = round2(r.unitSell * qty);

  if (ov) {
    r.overridden = true;
    const v = num(ov.value);
    if (ov.type === 'unit_sell') { r.unitSell = v; r.lineSell = round2(v * qty); }
    else if (ov.type === 'markup') { r.markup = v / 100; r.unitSell = r.unitCost * (1 + r.markup); r.lineSell = round2(r.unitSell * qty); }
    else if (ov.type === 'line_sell') { r.lineSell = round2(v); r.unitSell = qty ? v / qty : 0; }
    if (!String(ov.reason || '').trim()) warn('error', 'override_reason', `Override on "${r.description}" needs a reason.`);
  }

  for (const [k, h] of Object.entries(r.hoursPerUnit)) r.hours[k] = h * qty;
  r.margin = round2(r.lineSell - r.lineCost);
  r.marginPct = r.lineSell === 0 ? 0 : r.margin / r.lineSell;

  if (qty !== 0 && r.unitCost === 0 && line.moduleKey !== CUSTOM_MODULE) warn('error', 'zero_cost', `"${r.description}" has no cost in this price book.`);
  if (qty !== 0 && r.lineSell > 0 && r.marginPct < ctx.floorMargin) {
    if (ov && ov.approvedBy) warn('info', 'below_floor_approved', `"${r.description}" is below the ${(ctx.floorMargin * 100).toFixed(0)}% floor (approved).`);
    else warn('error', 'below_floor', `"${r.description}" is at ${(r.marginPct * 100).toFixed(1)}% margin, below the ${(ctx.floorMargin * 100).toFixed(0)}% floor. Needs approval.`);
  }
  if (qty < 0) warn('warn', 'negative_qty', `"${r.description}" has a negative quantity.`);
  return r;
}

function addHours(target, src) {
  for (const [k, h] of Object.entries(src)) target[k] = (target[k] || 0) + h;
}

/**
 * Price a whole job document against a price book.
 * @param job      { tierKey, areas: [{ id, name, optional, defaultFinish, lines: [...] }], adjustments?: { discountPct, discountReason } }
 * @param book     price book snapshot
 * @param settings { gstRate, floorMargin }
 */
export function priceJob(job, book, settings = {}) {
  const idx = book && book.modules ? (book.__idx || indexBook(book)) : null;
  const gstRate = num(settings.gstRate, 0.1);
  const floorMargin = num(settings.floorMargin, 0.3);
  const warnings = [];
  if (!idx) return { areas: [], totals: emptyTotals(), warnings: [{ level: 'error', code: 'no_book', message: 'No price book loaded.' }] };

  const tier = idx.tiers.get(job.tierKey) || book.tiers.find((t) => t.isDefault) || book.tiers[0];
  if (!tier) warnings.push({ level: 'error', code: 'no_tier', message: 'No price tier selected.' });
  const ctx = { markup: tier ? num(tier.markup) / 100 : 0, floorMargin };

  const totals = emptyTotals();
  const areas = (job.areas || []).map((area) => {
    const at = { cost: 0, sell: 0, margin: 0, marginPct: 0, hours: {}, lineCount: 0 };
    const lines = (area.lines || []).map((line) => {
      const r = priceLine(line, area, idx, ctx);
      warnings.push(...r.warnings);
      if (r.qty !== 0) at.lineCount++;
      at.cost += r.lineCost;
      at.sell += r.lineSell;
      addHours(at.hours, r.hours);
      return r;
    });
    at.cost = round2(at.cost);
    at.sell = round2(at.sell);
    at.margin = round2(at.sell - at.cost);
    at.marginPct = at.sell ? at.margin / at.sell : 0;
    if (area.optional) {
      totals.optionalSell += at.sell;
    } else {
      totals.cost += at.cost;
      totals.sellBeforeDiscount += at.sell;
      addHours(totals.hours, at.hours);
    }
    return { id: area.id, name: area.name, optional: !!area.optional, totals: at, lines };
  });

  const adj = job.adjustments || {};
  const discountPct = num(adj.discountPct);
  totals.cost = round2(totals.cost);
  totals.sellBeforeDiscount = round2(totals.sellBeforeDiscount);
  totals.optionalSell = round2(totals.optionalSell);
  totals.discount = round2(totals.sellBeforeDiscount * discountPct / 100);
  if (discountPct && !String(adj.discountReason || '').trim()) warnings.push({ level: 'error', code: 'discount_reason', message: 'Job discount needs a reason.' });
  totals.sell = round2(totals.sellBeforeDiscount - totals.discount);
  totals.margin = round2(totals.sell - totals.cost);
  totals.marginPct = totals.sell ? totals.margin / totals.sell : 0;
  totals.gst = round2(totals.sell * gstRate);
  totals.totalInc = round2(totals.sell + totals.gst);
  totals.hoursTotal = Object.values(totals.hours).reduce((a, b) => a + b, 0);
  if (totals.sell > 0 && totals.marginPct < floorMargin && discountPct && !adj.discountApprovedBy) {
    warnings.push({ level: 'error', code: 'job_below_floor', message: `Job margin ${(totals.marginPct * 100).toFixed(1)}% is below the ${(floorMargin * 100).toFixed(0)}% floor after discount. Needs approval.` });
  }
  return { areas, totals, warnings, tier: tier ? { key: tier.key, name: tier.name, markup: tier.markup } : null };
}

function emptyTotals() {
  return { cost: 0, sellBeforeDiscount: 0, discount: 0, sell: 0, margin: 0, marginPct: 0, gst: 0, totalInc: 0, optionalSell: 0, hours: {}, hoursTotal: 0 };
}

/** Errors that block creating a quote. */
export function blockingWarnings(result) {
  return result.warnings.filter((w) => w.level === 'error');
}

/** Compare two price book snapshots: changed option costs, labour rates, tiers, added/removed modules. */
export function diffBooks(from, to) {
  const changes = [];
  const fi = indexBook(from), ti = indexBook(to);
  for (const [k, t] of ti.trades) {
    const f = fi.trades.get(k);
    if (!f) changes.push({ kind: 'trade_added', key: k, name: t.name, to: t.rate });
    else if (num(f.rate) !== num(t.rate)) changes.push({ kind: 'trade_rate', key: k, name: t.name, from: f.rate, to: t.rate });
  }
  for (const [k, t] of ti.tiers) {
    const f = fi.tiers.get(k);
    if (!f) changes.push({ kind: 'tier_added', key: k, name: t.name, to: t.markup });
    else if (num(f.markup) !== num(t.markup)) changes.push({ kind: 'tier_markup', key: k, name: t.name, from: f.markup, to: t.markup });
  }
  for (const [k, m] of ti.modules) {
    const fm = fi.modules.get(k);
    if (!fm) { changes.push({ kind: 'module_added', key: k, name: m.name }); continue; }
    if (JSON.stringify(fm.labour || {}) !== JSON.stringify(m.labour || {})) changes.push({ kind: 'module_labour', key: k, name: m.name, from: fm.labour, to: m.labour });
    for (const o of m.options) {
      const fo = fi.options.get(`${k}::${o.key}`);
      const label = `${m.name} – ${o.name}`;
      if (!fo) { changes.push({ kind: 'option_added', key: `${k}::${o.key}`, name: label }); continue; }
      if (num(fo.material) !== num(o.material) || num(fo.hardware) !== num(o.hardware) || num(fo.labourFactor, 1) !== num(o.labourFactor, 1)
        || JSON.stringify(fo.labourCost || {}) !== JSON.stringify(o.labourCost || {})) {
        const before = unitCostOf(fm, fo, fi).unitCost;
        const after = unitCostOf(m, o, ti).unitCost;
        changes.push({ kind: 'option_cost', key: `${k}::${o.key}`, name: label, from: round2(before), to: round2(after) });
      }
      if ((fo.available !== false) !== (o.available !== false)) changes.push({ kind: o.available === false ? 'option_disabled' : 'option_enabled', key: `${k}::${o.key}`, name: label });
    }
    for (const fo of fm.options) if (!m.options.find((o) => o.key === fo.key)) changes.push({ kind: 'option_removed', key: `${k}::${fo.key}`, name: `${m.name} – ${fo.name}` });
  }
  for (const [k, fm] of fi.modules) if (!ti.modules.has(k)) changes.push({ kind: 'module_removed', key: k, name: fm.name });
  return changes;
}

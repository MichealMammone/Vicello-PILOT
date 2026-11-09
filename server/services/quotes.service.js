// Quote revisions: immutable snapshots of a priced job, hashed so the issued document is provable.
import { badRequest, conflict, notFound } from '../http/http.js';
import { sha256 } from '../http/security.js';
import { blockingWarnings, priceJob } from '../../shared/pricing.js';
import { audit } from './audit.service.js';
import { loadBook } from './pricebook.service.js';
import { getJobDoc, pricingSettings, LOCKED_STATUSES } from './jobs.service.js';
import { companySettings } from './account.service.js';

const now = () => new Date().toISOString();

export function listQuotes(db, companyId, jobId) {
  return db.all(`SELECT q.id, q.rev, q.status, q.subtotal, q.gst, q.total, q.cost, q.created_at, q.accepted_at, q.snapshot_hash, u.name AS created_by_name, p.label AS price_book_label
                 FROM quotes q JOIN jobs j ON j.id = q.job_id LEFT JOIN users u ON u.id = q.created_by JOIN price_books p ON p.id = q.price_book_id
                 WHERE q.job_id = ? AND j.company_id = ? ORDER BY q.rev DESC`, jobId, companyId);
}

export function createQuote(db, actor, companyRow, jobId, { revision, showUnitPrices = false, groupByArea = true, showItems = true }) {
  const doc = getJobDoc(db, companyRow.id, jobId);
  if (Number(revision) !== doc.revision) throw conflict('Save the job before creating a quote.');
  if (LOCKED_STATUSES.includes(doc.status)) throw conflict('This job\'s status is Won or later, so its prices are locked. Change the status back to create another quote.');
  const book = loadBook(db, companyRow.id, doc.priceBookId);
  const pricing = priceJob(doc, book, pricingSettings(companyRow));
  const blocking = blockingWarnings(pricing);
  if (blocking.length) throw badRequest('Resolve these issues before creating a quote.', { problems: blocking.map((w) => w.message) });
  if (!pricing.totals.sell) throw badRequest('The quote total is $0. Add quantities first.');

  const company = companySettings(companyRow);
  const rev = (db.get('SELECT MAX(rev) AS r FROM quotes WHERE job_id = ?', jobId).r || 0) + 1;
  const issuedAt = now();
  const validUntil = new Date(Date.now() + company.quoteValidityDays * 86400e3).toISOString().slice(0, 10);
  const snapshot = {
    rev, issuedAt, issuedBy: actor.name, validUntil, showUnitPrices: !!showUnitPrices, groupByArea: !!groupByArea, showItems: showItems !== false,
    company: { name: company.name, legalName: company.legalName, abn: company.abn, address: company.address, phone: company.phone, email: company.email, website: company.website, terms: company.quoteTerms, gstRate: company.gstRate, currency: company.currency,
      licenceNo: company.licenceNo, inclusions: company.quoteInclusions, logo: company.quoteLogo },
    job: { id: doc.id, jobNumber: doc.jobNumber, name: doc.name, clientName: doc.clientName, clientEmail: doc.clientEmail, clientPhone: doc.clientPhone, siteAddress: doc.siteAddress, designerName: doc.designerName, discountPct: doc.adjustments.discountPct,
      builderName: doc.builderName, contactDetails: doc.contactDetails, quoteBasis: doc.quoteBasis },
    priceBook: { id: book.id, label: book.label },
    tier: pricing.tier,
    areas: pricing.areas.map((a, ai) => ({
      name: a.name, optional: a.optional, notes: doc.areas[ai].notes, quoteLabel: doc.areas[ai].quoteLabel || '',
      sell: a.totals.sell,
      lines: a.lines.filter((l) => l.qty).map((l) => ({ description: l.description, qty: l.qty, uom: l.uom, unitSell: l.unitSell, lineSell: l.lineSell })),
    })),
    totals: pricing.totals,
    pricing,
  };
  const json = JSON.stringify(snapshot);
  const hash = sha256(json);
  return db.tx(() => {
    db.run("UPDATE quotes SET status = 'superseded' WHERE job_id = ? AND status = 'issued'", jobId);
    const id = Number(db.run(`INSERT INTO quotes (job_id, rev, status, price_book_id, snapshot, snapshot_hash, subtotal, gst, total, cost, created_by, created_at)
                              VALUES (?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId, rev, book.id, json, hash, pricing.totals.sell, pricing.totals.gst, pricing.totals.totalInc, pricing.totals.cost, actor.id, issuedAt).lastInsertRowid);
    // Creating a quote does not change the job's status, send anything or wait for the client: staff set statuses by hand.
    audit(db, { companyId: companyRow.id, userId: actor.id, entity: 'job', entityId: jobId, action: 'quote_issued', detail: { rev, total: pricing.totals.totalInc, hash } });
    return { id, rev };
  });
}

function quoteRow(db, companyId, quoteId) {
  const q = db.get('SELECT q.* FROM quotes q JOIN jobs j ON j.id = q.job_id WHERE q.id = ? AND j.company_id = ?', quoteId, companyId);
  if (!q) throw notFound('Quote not found.');
  return q;
}

export const QUOTE_STATUSES = ['issued', 'accepted', 'declined', 'superseded'];

/** Manual quote status. Records the status only: the job's status, schedule and prices are not touched. */
export function setQuoteStatus(db, actor, companyRow, quoteId, status) {
  const q = quoteRow(db, companyRow.id, quoteId);
  if (!QUOTE_STATUSES.includes(status)) throw badRequest('Unknown quote status.');
  if (q.status === status) return;
  db.tx(() => {
    const acceptedAt = status === 'accepted' ? (q.accepted_at || now()) : null;
    db.run('UPDATE quotes SET status = ?, accepted_at = ? WHERE id = ?', status, acceptedAt, quoteId);
    audit(db, { companyId: companyRow.id, userId: actor.id, entity: 'job', entityId: q.job_id, action: 'quote_status', detail: { rev: q.rev, from: q.status, to: status } });
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
// Whole units read "1x" as on Vicello's quotes; measured units keep at least two decimals ("3.20 LM"). No digits are dropped.
const qtyFmt = (n, uom) => Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: uom === 'EA' || uom === 'JOB' ? 0 : 2, maximumFractionDigits: 4 });
const UOM_TEXT = { LM: 'LM', M2: 'm²', HR: 'hrs', JOB: 'x', EA: 'x' };
const dotDate = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };

/**
 * Light formatting for quote text (area notes, standard inclusions, terms), matching Vicello's quote documents:
 *   a line in CAPITALS ending with ":"  → bold heading          "- " or "• " → bullet       "  - " → sub-bullet
 *   "# text"   → underlined sub-heading (e.g. "# Elevation 01 Inclusions – approx. 5030mm wide")
 *   "! text"   → red (exclusions); lines starting "*No allowance" are red automatically
 *   "~ text"   → blue (references to provisional sums)
 *   **bold**   ***bold italic***   __underline__   [red]part of a line[/red]   [blue]part of a line[/blue]
 */
export function richText(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/\[(red|blue)\](.+?)\[\/\1\]/g, '<span class="$1">$2</span>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`<ul class="${list}">${listItems.join('')}</ul>`); list = null; listItems = []; } };
  let listItems = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    let line = raw.replace(/\s+$/, '');
    if (!line.trim()) { close(); out.push('<div class="gap"></div>'); continue; }
    let cls = '';
    const t = line.trimStart();
    if (t.startsWith('! ') || t.startsWith('!*') || t.startsWith('!')) { cls = 'red'; line = line.replace(/^(\s*)!\s?/, '$1'); }
    else if (t.startsWith('~')) { cls = 'blue'; line = line.replace(/^(\s*)~\s?/, '$1'); }
    else if (/^\*?\s*no allowance/i.test(t)) cls = 'red';
    const bullet = line.match(/^(\s*)(?:[-•o])\s+(.*)$/);
    if (bullet && (bullet[1].length > 0 || !/^o\s/.test(line))) {
      const kind = bullet[1].length >= 2 ? 'sub' : 'dot';
      if (list !== kind) { close(); list = kind; }
      listItems.push(`<li${cls ? ` class="${cls}"` : ''}>${inline(bullet[2])}</li>`);
      continue;
    }
    close();
    if (/^#\s+/.test(line.trim())) out.push(`<div class="sub-h${cls ? ` ${cls}` : ''}">${inline(line.trim().replace(/^#\s+/, ''))}</div>`);
    else if (/^[A-Z0-9 ()/&,'.-]{3,}:$/.test(line.trim())) out.push(`<div class="heading">${inline(line.trim())}</div>`);
    else out.push(`<div class="ln${cls ? ` ${cls}` : ''}">${inline(line.trim())}</div>`);
  }
  close();
  while (out.length && out[out.length - 1] === '<div class="gap"></div>') out.pop();
  return out.join('');
}

/** Item numbers as on Vicello's quotes: 1, 2, 2A (a provisional sum belongs to the area before it), 3 … */
function areaNumbers(areas) {
  let n = 0, letter = 0;
  return areas.map((a, i) => {
    if (a.quoteLabel === 'provisional' && i > 0 && n > 0) { letter++; return `${n}${String.fromCharCode(64 + letter)}.`; }
    n++; letter = 0;
    return `${n}.`;
  });
}

/** Printable quote document in Vicello's quote layout (print or save as PDF from the browser). */
export function renderQuoteHtml(db, companyId, quoteId) {
  const q = quoteRow(db, companyId, quoteId);
  const s = JSON.parse(q.snapshot);
  const c = s.company;
  const j = s.job;
  const t = s.totals;
  const shown = s.areas.filter((a) => a.lines.length || (a.notes || '').trim() || a.optional);
  const numbers = areaNumbers(shown);
  const itemLines = (a) => (s.showItems === false || !a.lines.length ? '' : `<div class="items">${a.lines.map((l) => {
    const qty = l.uom === 'EA' || l.uom === 'JOB' ? `${qtyFmt(l.qty, l.uom)}x` : `${qtyFmt(l.qty, l.uom)} ${UOM_TEXT[l.uom] || l.uom}`;
    return `<div class="ln">*${esc(qty)} ${esc(l.description)}${s.showUnitPrices ? ` <span class="unit">(${money(l.unitSell)} each, ${money(l.lineSell)})</span>` : ''}</div>`;
  }).join('')}</div>`);
  const priceCell = (a) => {
    if (a.optional) return 'Not included in total';
    if (!a.lines.length && !a.sell) return 'Not included in total';
    if (a.quoteLabel === 'provisional') return `${money(a.sell)}<div class="ps">Provisional sum</div>`;
    return money(a.sell);
  };
  const title = (a) => `${esc(a.name.toUpperCase())}${a.optional ? ` <span class="opt">– OPTIONAL${a.sell ? ` – Add ${money(a.sell)} + GST` : ''}</span>` : ''}`;
  const areaRows = shown.map((a, i) => `
      <tr class="spacer"><td></td><td></td><td></td></tr>
      <tr class="area"><td class="no">${numbers[i]}</td><td class="item"><div class="a-title">${title(a)}</div>${a.quoteLabel === 'provisional' && !(a.notes || '').trim() ? '<div class="ln"><em>The following works are provided as a provisional allowance only, and subject to reprice during pre-production phase</em></div>' : ''}${richText(a.notes)}${itemLines(a)}</td><td class="price">${priceCell(a)}</td></tr>`).join('');
  const inclusions = (c.inclusions || '').trim()
    ? `<tr class="area"><td class="no"></td><td class="item"><div class="a-title">${esc((c.name || '').toUpperCase())} Standard Inclusions</div>${richText(c.inclusions)}</td><td class="price"><strong>Included</strong></td></tr>` : '';
  const totalRow = (label, value, cls = '') => `<tr class="total ${cls}"><td></td><td class="t-label">${label}</td><td class="price">${value}</td></tr>`;
  const contact = j.contactDetails || [j.clientPhone, j.clientEmail].filter(Boolean).join(' · ');
  const info = [
    ['BUILDER', esc(j.builderName || ''), 'CLIENT NAME', esc(j.clientName || '')],
    ['JOB #', `<strong>${esc(j.jobNumber)}</strong>`, 'VERSION', String(s.rev).padStart(2, '0')],
    ['SITE ADDRESS', esc(j.siteAddress || ''), 'CONTACT #', esc(contact)],
    ['CONSULTANT', esc(j.designerName || s.issuedBy || ''), 'DATE', dotDate(s.issuedAt)],
  ];
  const brand = c.logo ? `<img class="logo" src="${esc(c.logo)}" alt="${esc(c.name)}">` : `<div class="wordmark">${esc((c.name || '').toUpperCase())}</div>`;
  const footer = [[c.address, c.licenceNo ? `Licence #${c.licenceNo}` : '', c.abn ? `ABN: ${c.abn}` : ''], [c.phone ? `P: ${c.phone}` : '', c.email ? `E: ${c.email}` : '', c.website ? `W: <strong>${esc(c.website)}</strong>` : '']]
    .map((parts) => parts.filter(Boolean).map((p) => (p.startsWith('W: <strong>') ? p : esc(p))).join('&nbsp;&nbsp;|&nbsp;&nbsp;')).filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quotation ${esc(j.jobNumber)} version ${String(s.rev).padStart(2, '0')}</title>
<style>
  :root { --ink:#111; --grid:#c9c9c9; --shade:#f2f2f2; --red:#e00000; --blue:#4472c4; }
  * { box-sizing: border-box; }
  body { font: 13.5px/1.42 "Century Gothic", "Avenir Next", "Segoe UI", system-ui, sans-serif; color: var(--ink); margin: 0; background: #e9e9e9; }
  .bar { max-width: 860px; margin: 16px auto 0; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 0 4px; font-size: 13px; color: #555; }
  .bar button { font: inherit; padding: 8px 16px; border: 0; background: #222; color: #fff; border-radius: 4px; cursor: pointer; }
  .sheet { max-width: 860px; margin: 12px auto 32px; background: #fff; padding: 40px 48px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  table { border-collapse: collapse; width: 100%; }
  table.doc > thead > tr > td, table.doc > tfoot > tr > td, table.doc > tbody > tr > td { padding: 0; }
  .brand { text-align: center; padding: 4px 0 18px; }
  .logo { max-width: 72%; max-height: 120px; }
  .wordmark { font: 300 64px/1 "Bodoni MT", Didot, "Times New Roman", serif; letter-spacing: .32em; padding-left: .32em; }
  h1 { text-align: center; font-size: 17px; font-weight: 700; margin: 4px 0 10px; letter-spacing: .02em; }
  .info { width: 92%; margin: 0 auto 22px; font-size: 14px; }
  .info td { border: 1px solid var(--grid); padding: 2px 9px; vertical-align: top; }
  .info .k { font-weight: 700; text-align: right; white-space: nowrap; width: 1%; }
  .info .v { width: 37%; }
  .lines { border: 1px solid var(--ink); font-size: 14px; }
  .lines th { text-align: left; font-weight: 700; border-bottom: 1px solid var(--ink); padding: 3px 8px 1px; }
  .lines td { vertical-align: top; padding: 3px 8px; }
  .lines .no { width: 46px; border-right: 1px solid var(--ink); }
  .lines .price { width: 150px; border-left: 1px solid var(--ink); white-space: nowrap; }
  .lines th.h-item { padding-left: 54px; }
  .lines tr.spacer td { height: 22px; border-top: 1px solid var(--grid); border-bottom: 1px solid var(--grid); }
  .lines tr.basis td { font-weight: 700; font-style: italic; border-bottom: 1px solid var(--grid); }
  .a-title { font-weight: 700; }
  .opt { font-weight: 700; }
  .ps { font-weight: 700; font-style: italic; margin-top: 2px; }
  .ln { white-space: pre-wrap; }
  .gap { height: .9em; }
  .heading { font-weight: 700; margin: 1.1em 0 .4em; }
  .sub-h { text-decoration: underline; margin-top: .3em; }
  .red { color: var(--red); }
  .blue { color: var(--blue); }
  ul { margin: .3em 0 .3em 0; padding-left: 2.2em; }
  ul.sub { padding-left: 4.2em; list-style: circle; }
  li { margin: .12em 0; }
  .items { margin-top: .5em; }
  .unit { color: #555; font-size: 12.5px; }
  .lines tr.total td { border-top: 1px solid var(--grid); padding-top: 6px; padding-bottom: 6px; font-weight: 700; }
  .lines tr.total .t-label { text-align: right; }
  .note-ex { text-align: center; font-weight: 700; margin: 4px 0 26px; font-size: 14px; }
  .terms { font-size: 13.5px; }
  .terms ul { padding-left: 2.6em; }
  .terms ul.sub { padding-left: 5em; }
  .terms li { margin: .45em 0; }
  .ref { margin-top: 18px; font-size: 10.5px; color: #888; }
  .approval { width: 92%; margin: 26px auto 10px; font-size: 14px; }
  .approval .cap { font-weight: 700; padding-left: 36%; }
  .approval table { border-top: 1.5px solid #666; }
  .approval td { padding: 3px 8px; }
  .approval tr:nth-child(odd) td { background: var(--shade); }
  .approval .k { text-align: right; width: 39%; border-right: 1px solid var(--grid); }
  .footer { text-align: center; font-size: 13px; line-height: 1.5; padding-bottom: 6px; }
  tr, .area td { break-inside: auto; }
  tr.total, tr.spacer { break-inside: avoid; }
  @page { size: A4; margin: 12mm 10mm 10mm; @bottom-right { content: counter(page); font: 13px "Century Gothic", sans-serif; } }
  @media print {
    body { background: #fff; } .bar { display: none; } .sheet { margin: 0; padding: 0; box-shadow: none; max-width: none; }
    table.doc > thead { display: table-header-group; } table.doc > tfoot { display: table-footer-group; }
    /* Kept compact so browsers repeat the header (logo + job details) and the approval block on every page. */
    .brand { padding: 0 0 8px; } .logo { max-height: 74px; } .wordmark { font-size: 46px; }
    h1 { font-size: 15px; margin: 2px 0 8px; } .info { font-size: 12.5px; margin-bottom: 12px; } .info td { padding: 1px 8px; }
    .approval { margin: 14px auto 6px; font-size: 12.5px; } .approval td { padding: 2px 8px; } .footer { font-size: 11.5px; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  @media (max-width: 700px) { .sheet { padding: 20px 14px; } .wordmark { font-size: 36px; } .info, .approval { width: 100%; } .lines .price { width: 96px; white-space: normal; } .lines .no { width: 34px; } }
</style></head><body>
<div class="bar"><span>Quotation version ${String(s.rev).padStart(2, '0')} · ${q.status === 'issued' ? 'Current' : esc(q.status)}</span><button type="button" id="print">Print / Save as PDF</button></div>
<div class="sheet">
<table class="doc">
  <thead><tr><td>
    <div class="brand">${brand}</div>
    <h1>QUOTATION</h1>
    <table class="info">${info.map(([k1, v1, k2, v2]) => `<tr><td class="k">${k1}</td><td class="v">${v1}</td><td class="k">${k2}</td><td class="v">${v2}</td></tr>`).join('')}</table>
  </td></tr></thead>
  <tfoot><tr><td>
    <div class="approval"><div class="cap">CLIENT APPROVAL</div><table>
      <tr><td class="k">CLIENT NAME :</td><td></td></tr><tr><td class="k">CLIENT SIGNATURE :</td><td></td></tr><tr><td class="k">DATE :</td><td></td></tr></table></div>
    <div class="footer">${footer.map((l) => `<div>${l}</div>`).join('')}</div>
  </td></tr></tfoot>
  <tbody><tr><td>
    <table class="lines">
      <thead><tr><th colspan="2" class="h-item">ITEM</th><th class="price">PRICE EX GST</th></tr></thead>
      <tbody>
      ${(j.quoteBasis || '').trim() ? `<tr class="basis"><td colspan="3">${esc(j.quoteBasis)}</td></tr>` : ''}
      ${inclusions}
      ${areaRows}
      <tr class="spacer"><td></td><td></td><td></td></tr>
      ${t.discount ? totalRow('Subtotal', money(t.sellBeforeDiscount)) + totalRow(`Discount (${esc(j.discountPct)}%)`, `−${money(t.discount)}`) : ''}
      ${totalRow('Total', money(t.sell))}
      ${totalRow('GST', money(t.gst))}
      ${totalRow('Total including GST', money(t.totalInc))}
      </tbody>
    </table>
    <p class="note-ex">NOTE: ALL PRICES ARE EXCLUDING GST.</p>
    ${(c.terms || '').trim() ? `<div class="terms">${richText(c.terms)}</div>` : ''}
    <div class="ref">Document reference ${q.snapshot_hash.slice(0, 16).toUpperCase()} · ${esc(s.priceBook?.label || '')}</div>
  </td></tr></tbody>
</table>
</div>
<script src="/js/print.js"></script>
</body></html>`;
}


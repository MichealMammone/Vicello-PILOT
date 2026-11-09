// 0.4.0 amendments: configurable statuses, reopening closed jobs, full job history, quote layout (Vicello template),
// workflow milestones and quote settings. Runs end to end against a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-v040-'));
process.env.DATA_DIR = dir;
const { openDatabase } = await import('../server/db/database.js');
const { createServer } = await import('../server/index.js');
const { richText } = await import('../server/services/quotes.service.js');

let server, base, db, cookie = '';
const OWNER = { email: 'owner@example.test', password: 'Testing-12345' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'app', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const job = async (id) => (await call('GET', `/api/jobs/${id}`)).data.job;
const save = (j, extra = {}) => call('PUT', `/api/jobs/${j.id}`, { ...j, ...extra });
const history = async (id) => (await call('GET', `/api/jobs/${id}/history`)).data;

before(async () => {
  db = openDatabase(path.join(dir, 'test.db'));
  server = createServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/setup', { companyName: 'Vicello', name: 'Olive Owner', ...OWNER })).status, 200);
  assert.equal((await call('POST', '/api/login', OWNER)).status, 200);
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let jobId;
test('new jobs start with the eight main statuses, "Missed" included; database is at version 4', async () => {
  const s = (await call('GET', '/api/state')).data;
  assert.deepEqual(s.statuses.filter((x) => x.builtin).map((x) => x.key), ['enquiry', 'quoting', 'quoted', 'won', 'in_production', 'installing', 'complete', 'lost']);
  assert.equal(s.statuses.find((x) => x.key === 'lost').label, 'Missed');
  assert.equal(db.get('SELECT MAX(version) AS v FROM schema_migrations').v, 4);
  const created = await call('POST', '/api/jobs', { name: 'Woolwich residence', clientName: 'Sharon & Garbis Simonian', areas: [
    { name: 'GF Kitchen', type: 'kitchen', lines: [{ moduleKey: 'base-cabinet', qty: 2 }, { moduleKey: 'shaving-cabinet-1000', qty: 1 }] },
    { name: 'GF Bar architrave', type: 'other', lines: [{ moduleKey: 'base-cabinet', qty: 1 }] },
    { name: 'Project support service', type: 'services', optional: true, lines: [{ moduleKey: 'base-cabinet', qty: 1 }] },
    { name: 'GF Laundry', type: 'laundry', notes: '*No allowance for joinery within scope', lines: [] },
  ] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  jobId = created.data.id;
});

test('admins add, rename, turn off and delete statuses; a status in use cannot be deleted', async () => {
  const add = await call('POST', '/api/statuses', { label: 'Awaiting builder', baseStatus: 'quoted' });
  assert.equal(add.status, 200);
  const v = add.data.find((s) => s.label === 'Awaiting builder');
  assert.equal(v.baseStatus, 'quoted');
  // the variation is listed straight after its main status
  const keys = add.data.map((s) => s.key);
  assert.equal(keys.indexOf(v.key), keys.indexOf('quoted') + 1);
  assert.equal((await call('PUT', '/api/statuses/won', { label: 'Contract signed' })).status, 200);
  assert.equal((await call('GET', '/api/state')).data.statuses.find((s) => s.key === 'won').label, 'Contract signed');
  assert.equal((await call('DELETE', '/api/statuses/won')).status, 409, 'main statuses cannot be deleted');

  let j = await job(jobId);
  assert.equal((await save(j, { status: 'quoting', statusDetail: v.key })).status, 400, 'a variation must match its main status');
  const ok = await save(j, { status: 'quoted', statusDetail: v.key });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.job.statusDetail, v.key);
  assert.equal(ok.data.job.status, 'quoted', 'reports still see the main status');
  const list = (await call('GET', '/api/jobs')).data;
  assert.equal(list.find((x) => x.id === jobId).status_detail, v.key);

  const del = await call('DELETE', `/api/statuses/${v.key}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.details.used, 1);
  assert.equal((await call('PUT', `/api/statuses/${v.key}`, { label: 'Awaiting builder', active: false })).status, 200);
  j = await job(jobId);
  assert.equal((await save(j)).status, 200, 'a job keeps a status that was turned off');
  const spare = (await call('POST', '/api/statuses', { label: 'On hold', baseStatus: 'quoting' })).data.find((s) => s.label === 'On hold');
  assert.equal((await call('DELETE', `/api/statuses/${spare.key}`)).status, 200);
  const audit = db.all("SELECT action FROM audit_log WHERE entity = 'job_status'").map((r) => r.action);
  assert.ok(audit.includes('status_create') && audit.includes('status_update') && audit.includes('status_delete'));
});

test('reopening a closed job needs a reason, and the history records who, when, from, to and why', async () => {
  let j = await job(jobId);
  const closed = await save(j, { status: 'lost', statusDetail: null });
  assert.equal(closed.status, 200);
  j = closed.data.job;
  const noReason = await save(j, { status: 'quoting' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.details.field, 'reopenReason');
  assert.equal((await job(jobId)).status, 'lost', 'nothing was saved');
  const reopened = await save(j, { status: 'quoting', reopenReason: 'Builder came back with revised plans' });
  assert.equal(reopened.status, 200);
  const h = await history(jobId);
  const entry = h.find((r) => r.action === 'job_reopened');
  assert.ok(entry && entry.user_name === 'Olive Owner' && entry.at);
  assert.deepEqual({ from: entry.detail.fromLabel, to: entry.detail.toLabel, reason: entry.detail.reason }, { from: 'Missed', to: 'Quoting', reason: 'Builder came back with revised plans' });
  const statusChange = h.find((r) => r.action === 'save' && r.detail.changes?.some((c) => c.field === 'Status' && c.from === 'Missed'));
  assert.ok(statusChange, 'the save also lists the status change');
  // moving between open statuses needs no reason
  assert.equal((await save(reopened.data.job, { status: 'quoted' })).status, 200);
});

test('job history lists field changes and item additions, deletions and modifications with previous and new values', async () => {
  const j = await job(jobId);
  j.builderName = 'Levon Construction';
  j.notes = 'Client prefers matte finishes';
  j.areas[0].name = 'GF KITCHEN';
  j.areas[0].lines[0].qty = 3.25;           // modified
  j.areas[0].lines.splice(1, 1);             // deleted (shaving cabinet)
  j.areas[0].lines.push({ moduleKey: 'base-cabinet', qty: 1, description: 'Extra base' }); // added
  j.areas[1].quoteLabel = 'provisional';
  const r = await save(j);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const changes = (await history(jobId)).find((x) => x.action === 'save').detail.changes;
  const find = (pred) => changes.find(pred);
  assert.deepEqual(find((c) => c.field === 'Builder'), { kind: 'field', field: 'Builder', from: '', to: 'Levon Construction' });
  assert.equal(find((c) => c.field === 'Internal notes').to, 'Client prefers matte finishes');
  assert.deepEqual({ ...find((c) => c.field === 'Area name') }, { kind: 'area', area: 'GF KITCHEN', field: 'Area name', from: 'GF Kitchen', to: 'GF KITCHEN' });
  const qty = find((c) => c.field === 'Quantity');
  assert.equal(qty.from, '2'); assert.equal(qty.to, '3.25'); assert.equal(qty.kind, 'item');
  assert.ok(find((c) => c.action === 'removed' && c.kind === 'item' && /shaving/i.test(c.item)), 'deleted item recorded');
  assert.ok(find((c) => c.action === 'added' && c.kind === 'item'), 'added item recorded');
  assert.equal(find((c) => c.field === 'Provisional sum').to, 'Yes');
  // an unchanged save records "no changes" rather than inventing any
  const again = await save((await job(jobId)));
  assert.equal(again.status, 200);
  assert.deepEqual((await history(jobId)).find((x) => x.action === 'save').detail.changes, []);
});

test('company quote settings: licence, standard inclusions, terms (Vicello wording by default) and logo', async () => {
  const c = (await call('GET', '/api/company')).data;
  assert.match(c.quoteTerms, /^JOINERY TERMS:/);
  assert.match(c.quoteTerms, /PROGRESS PAYMENT SCHEDULE \(JOINERY\):/);
  assert.match(c.quoteInclusions, /1x On-site joinery check measure\. Additional measures may incur a fee at the discretion of VICELLO\./);
  assert.equal((await call('PUT', '/api/company', { quoteLogo: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400, 'only pictures are accepted');
  const saved = await call('PUT', '/api/company', { licenceNo: '339569C', abn: '31 621 269 985', address: 'Unit 1 37-39 Stanley Rd, Ingleburn NSW 2565', phone: '02 4607 2696', email: 'info@vicello.com.au', website: 'vicello.com.au', quoteLogo: PNG });
  assert.equal(saved.status, 200);
  const st = (await call('GET', '/api/state')).data.company;
  assert.equal(st.hasLogo, true);
  assert.equal(st.quoteLogo, undefined, 'the picture is not sent with every page load');
  const upd = db.all("SELECT detail FROM audit_log WHERE entity = 'company' AND action = 'update'").map((r) => JSON.parse(r.detail)).pop();
  assert.ok(upd.changes.some((x) => x.field === 'licenceNo' && x.to === '339569C'));
  assert.ok(upd.changes.some((x) => x.field === 'quoteLogo' && x.to === '(new logo)'));
});

test('the quote follows the Vicello template, and its totals are exactly the job pricing', async () => {
  const j = await job(jobId);
  const book = (await call('GET', `/api/price-books/${j.priceBookId}`)).data;
  for (const a of j.areas) for (const l of a.lines) if (!l.optionKey) l.optionKey = book.modules.find((m) => m.key === l.moduleKey).options.find((o) => o.available !== false).key;
  Object.assign(j, { contactDetails: 'Levon Setrakian – 0432 881 678', quoteBasis: 'Quote is based off client provided joinery plans Revision Dated 08.09.2026' });
  j.areas[0].notes = '*Doors finished in 16mm Laminex \'Milano Walnut\' Natural\n# Elevation 01 Inclusions – approx. 5030mm wide\n*1x single door tall cabinet\n! *No allowance for LED extrusions\n~ *Cladding not included within joinery item (itemised provisional sum)\n**NOTE: Material cannot be edged**';
  const saved = await save(j);
  assert.equal(saved.status, 200);
  const pricing = saved.data.pricing;
  const q = await call('POST', `/api/jobs/${jobId}/quotes`, { revision: saved.data.job.revision, showItems: true });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  const row = db.get('SELECT * FROM quotes WHERE id = ?', q.data.id);
  assert.equal(row.subtotal, pricing.totals.sell);
  assert.equal(row.gst, pricing.totals.gst);
  assert.equal(row.total, pricing.totals.totalInc);
  const html = (await call('GET', `/quotes/${q.data.id}`)).data;
  for (const text of ['QUOTATION', 'BUILDER', 'Levon Construction', 'CLIENT NAME', 'Sharon &amp; Garbis Simonian', 'JOB #', 'VERSION', '>01<', 'SITE ADDRESS', 'CONTACT #',
    'Levon Setrakian – 0432 881 678', 'CONSULTANT', 'Olive Owner', 'PRICE EX GST', 'VICELLO Standard Inclusions', '<strong>Included</strong>', 'Quote is based off client provided joinery plans',
    'GF KITCHEN', 'Provisional sum', 'Not included in total', 'OPTIONAL', 'Total including GST', 'NOTE: ALL PRICES ARE EXCLUDING GST.', 'JOINERY TERMS:', 'CLIENT APPROVAL', 'CLIENT SIGNATURE :',
    'Licence #339569C', 'ABN: 31 621 269 985', `src="${PNG}"`]) {
    assert.ok(html.includes(text), `quote should contain ${text}`);
  }
  assert.match(html, /<td class="no">1\.<\/td>[\s\S]*GF KITCHEN[\s\S]*<td class="no">1A\.<\/td>[\s\S]*GF BAR ARCHITRAVE/, 'a provisional sum is numbered after the area before it');
  assert.match(html, /<div class="sub-h">Elevation 01 Inclusions – approx\. 5030mm wide<\/div>/);
  assert.match(html, /<div class="ln red">\*No allowance for LED extrusions<\/div>/);
  assert.match(html, /<div class="ln blue">\*Cladding not included/);
  assert.match(html, /<div class="ln red">\*No allowance for joinery within scope<\/div>/, '"*No allowance" lines are red automatically');
  assert.match(html, /<strong>NOTE: Material cannot be edged<\/strong>/);
  assert.match(html, /\*3\.25x |\*1x /, 'items listed as "*1x …"');
  const dollars = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
  assert.ok(html.includes(dollars(pricing.totals.sell)) && html.includes(dollars(pricing.totals.gst)) && html.includes(dollars(pricing.totals.totalInc)));
  assert.ok(!/<script>(?!.*print)/.test(html.replace('<script src="/js/print.js"></script>', '')), 'no script from data');
});

test('quote text formatting is escaped and understands headings and bullets', () => {
  const out = richText('JOINERY TERMS:\n- one <b>\n  - nested\n**bold** text\n***NOTE:*** [blue]see provisional sum[/blue]');
  assert.match(out, /<strong><em>NOTE:<\/em><\/strong> <span class="blue">see provisional sum<\/span>/);
  assert.match(out, /<div class="heading">JOINERY TERMS:<\/div>/);
  assert.match(out, /<ul class="dot"><li>one &lt;b&gt;<\/li><\/ul><ul class="sub"><li>nested<\/li><\/ul>/);
  assert.match(out, /<strong>bold<\/strong> text/);
});

test('workflow milestones: add, delete (re-timing milestones that followed it), and protection when in use', async () => {
  const a = await call('POST', '/api/event-types', { name: 'Plan review', staffCategory: 'designer', duration: 90, unit: 'minutes', anchor: 'check_measure:end', offsetDays: 3, rule: 'always' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.key, 'plan_review');
  const b = await call('POST', '/api/event-types', { name: 'Plan sign-off', staffCategory: 'project_manager', anchor: 'plan_review:end', offsetDays: 2 });
  assert.equal(b.status, 200);
  assert.equal((await call('POST', '/api/event-types', { name: '', staffCategory: 'designer' })).status, 400);
  const del = await call('DELETE', '/api/event-types/plan_review');
  assert.equal(del.status, 200);
  assert.deepEqual(del.data.retimed, ['Plan sign-off']);
  const signoff = del.data.types.find((t) => t.key === 'plan_sign_off');
  assert.equal(signoff.anchor, 'check_measure:end');
  assert.equal(signoff.offsetDays, 5);
  // a milestone already on a job's schedule cannot be deleted
  await call('POST', `/api/jobs/${jobId}/schedule/propose`);
  assert.equal((await call('POST', `/api/jobs/${jobId}/schedule/confirm`)).status, 200);
  const used = await call('DELETE', '/api/event-types/consultation');
  assert.equal(used.status, 409);
  assert.ok(used.data.details.used >= 1);
  const audit = db.all("SELECT action FROM audit_log WHERE entity = 'event_type'").map((r) => r.action);
  assert.ok(audit.includes('create') && audit.includes('delete'));
});

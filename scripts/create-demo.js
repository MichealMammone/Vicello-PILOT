// Creates a demo company with sample jobs, quotes, costs, staff and schedules on the Material + Labour price book.
// Uses DATA_DIR if set (the UAT launchers set it), otherwise the DEV data folder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR ||= path.join(process.env.LOCALAPPDATA || os.homedir(), 'JoineryPricing-dev');
const here = path.dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(fs.readFileSync(path.join(here, 'demo-credentials.json'), 'utf8'));

const { config } = await import('../server/config.js');
const { openDatabase } = await import('../server/db/database.js');
const acct = await import('../server/services/account.service.js');
const jobs = await import('../server/services/jobs.service.js');
const quotes = await import('../server/services/quotes.service.js');
const pb = await import('../server/services/pricebook.service.js');

const sched = await import('../server/services/schedule.service.js');
const D = await import('../shared/dates.js');
const { CUSTOM_MODULE } = await import('../shared/pricing.js');

const db = openDatabase(config.dbFile);
sched.ensureAllDefaults(db);

/** Demo scheduling: proposals for every job, two jobs confirmed onto the calendar, some leave. */
function seedSchedule() {
  const owner = db.get("SELECT * FROM users WHERE role = 'owner' ORDER BY id LIMIT 1");
  const company = db.get('SELECT * FROM companies WHERE id = ?', owner.company_id);
  const jobRows = db.all("SELECT id, name, status FROM jobs WHERE company_id = ? AND archived_at IS NULL AND status <> 'lost' ORDER BY id", company.id);
  for (const j of jobRows) sched.proposeSchedule(db, owner, company, j.id);
  for (const j of jobRows.filter((x) => /Nguyen residence – whole|Patel/.test(x.name))) sched.confirmSchedule(db, owner, company, j.id);
  // a couple of confirmed events, and leave next week for one installer
  const first = db.all("SELECT id FROM job_events WHERE company_id = ? AND status = 'pending' ORDER BY start_at LIMIT 2", company.id);
  for (const e of first) sched.updateEvent(db, owner, company, e.id, { status: 'confirmed' });
  const installer = db.get("SELECT id FROM staff WHERE company_id = ? AND category = 'installer' ORDER BY name LIMIT 1", company.id);
  const nextMon = D.addDays(D.weekStart(D.today()), 7);
  sched.addLeave(db, owner, { staffId: installer.id, start: nextMon, end: D.addDays(nextMon, 2), reason: 'Annual leave' });
  console.log(`Schedules created for ${jobRows.length} jobs.`);
}

if (!acct.needsSetup(db)) {
  if (!db.get('SELECT 1 FROM job_events LIMIT 1')) { seedSchedule(); process.exit(0); }
  console.log(`Demo data already exists in ${config.dataDir}. Delete that folder to start again.`);
  process.exit(0);
}
// The demo uses the Material + Labour cost book (the default price book from 0.3.0). Quantities include decimals
// (e.g. 2.75 LM) so precision can be checked on screen and on printed quotes.
acct.setup(db, { companyName: creds.companyName, jobPrefix: creds.jobPrefix, ...creds.owner, priceBook: 'material-labour' });
const owner = db.get('SELECT * FROM users WHERE email = ?', creds.owner.email);
const company = db.get('SELECT * FROM companies WHERE id = ?', owner.company_id);
acct.createUser(db, owner, { ...creds.designer, role: 'designer' });
db.run('UPDATE users SET must_change_password = 0');

const book = pb.loadBook(db, company.id, pb.currentPublished(db, company.id).id);
const opt = (mk, re) => {
  const m = book.modules.find((x) => x.key === mk);
  const o = m && m.options.find((x) => x.available !== false && re.test(x.name));
  if (!o) throw new Error(`Demo item not found: ${mk} ${re}`);
  return o.key;
};
const L = (moduleKey, qty, re) => ({ moduleKey, qty, optionKey: re ? opt(moduleKey, re) : null });

// 1. A kitchen with explicit finishes and decimal quantities.
const j1 = jobs.createJob(db, owner, company, {
  name: 'Henderson residence – kitchen', clientName: 'Sam Henderson', siteAddress: 'Baulkham Hills NSW',
  areas: [{ name: 'Kitchen', type: 'kitchen', lines: [
    L('base-cabinet', 2.75, /16mm White HMR/), L('base-cabinet', 1.5, /19mm Blackbutt/), L('wall-cabinet', 3.25, /25mm Polyurethane Scandinavian/),
    L('tall-cabinet', 1.2, /Tesrol/), L('mitred-bulkhead', 2.4, /American Oak/), L('wall-end-panel', 3, /Woodmatt/),
    L('drawer', 12, /Merivo/), L('square-edge-fingerpull-all-pre-finished-melamine', 1)] }],
});

// 2. A multi-area home: kitchen, butler's, four robes, laundry, optional alfresco, job extras.
const robe = (n) => ({ name: `Wardrobe ${n}`, type: 'wardrobe', defaultFinish: 'FG01', lines: [L('tall-cabinet', 2.4), L('tall-end-panel', 2), L('drawer', 3, /Merivo/)] });
const j2 = jobs.createJob(db, owner, company, {
  name: 'Nguyen residence – whole home joinery', clientName: 'Linh Nguyen', clientEmail: 'linh@example.com', siteAddress: '14 Hezlett Rd, Kellyville NSW',
  areas: [
    { name: 'Kitchen', type: 'kitchen', defaultFinish: 'FG03', lines: [L('base-cabinet', 4.25), L('wall-cabinet', 3.1), L('tall-cabinet', 1.8, /Tesrol/), L('appliance-tower', 1), L('base-end-panel', 2), L('drawer', 8, /Merivo/), L('mitred-bulkhead', 3), L('appliance-integration', 1, /Dishwasher 60cm/)] },
    { name: "Butler's pantry", type: 'butlers', defaultFinish: 'FG03', lines: [L('base-cabinet', 2.4), L('wall-open', 2.4), L('tall-pantry', 0.9)] },
    robe(1), robe(2), robe(3), robe(4),
    { name: 'Laundry', type: 'laundry', defaultFinish: 'FG02', lines: [L('base-cabinet', 1.8), L('wall-cabinet', 1.8), L('tall-cabinet', 0.6)] },
    { name: 'Alfresco', type: 'alfresco', defaultFinish: 'FG14', optional: true, lines: [L('base-cabinet', 3), L('base-end-panel', 2, /Compact Laminate/)] },
    { name: 'Job extras', type: 'services', lines: [L('shadowline', 1, /medium/)] },
  ],
});
const doc2 = jobs.getJobDoc(db, company.id, j2);
quotes.createQuote(db, owner, company, j2, { revision: doc2.revision });
// Job statuses are set by hand (quotes never change them).
const setStatus = (id, status) => { const d = jobs.getJobDoc(db, company.id, id); jobs.saveJob(db, owner, company, id, { ...d, status }); };
setStatus(j2, 'quoted');

// 3. An accepted job with costs recorded.
const j3 = jobs.createJob(db, owner, company, {
  name: 'Patel laundry & linen', clientName: 'Asha Patel', siteAddress: 'Castle Hill NSW',
  areas: [
    { name: 'Laundry', type: 'laundry', defaultFinish: 'FG02', lines: [L('base-cabinet', 2.4), L('wall-cabinet', 2.4), L('tall-cabinet', 0.6)] },
    { name: 'Linen press', type: 'linen', defaultFinish: 'FG01', lines: [L('tall-cabinet', 1.2)] },
  ],
});
const q3 = quotes.createQuote(db, owner, company, j3, { revision: jobs.getJobDoc(db, company.id, j3).revision });
quotes.setQuoteStatus(db, owner, company, q3.id, 'accepted');
setStatus(j3, 'won');
jobs.addCost(db, owner, company, j3, { costCode: 'MATERIAL', description: 'Polytec Matt board order', supplier: 'Polytec', amount: 1340 });
jobs.addCost(db, owner, company, j3, { costCode: 'LAB:INSTALL', description: 'Install crew', hours: 9, amount: 765 });

// 4. More won and lost jobs across two staff members, for the dashboard win/loss and staff performance drill-downs.
const designer = db.get('SELECT * FROM users WHERE email = ?', creds.designer.email);
const quickJob = (who, name, client, notes, lines, outcome) => {
  const id = jobs.createJob(db, who, company, { name, clientName: client, notes, areas: [{ name: 'Area 1', type: 'other', defaultFinish: 'FG03', lines }] });
  const q = quotes.createQuote(db, who, company, id, { revision: jobs.getJobDoc(db, company.id, id).revision });
  const set = (status) => { const d = jobs.getJobDoc(db, company.id, id); jobs.saveJob(db, who, company, id, { ...d, status }); };
  if (outcome === 'won') { quotes.setQuoteStatus(db, who, company, q.id, 'accepted'); set('won'); }
  if (outcome === 'production') { quotes.setQuoteStatus(db, who, company, q.id, 'accepted'); set('won'); set('in_production'); }
  if (outcome === 'lost') { quotes.setQuoteStatus(db, who, company, q.id, 'declined'); set('lost'); }
  if (outcome === 'quoted') set('quoted');
  return id;
};
quickJob(designer, 'Clarke laundry', 'Ben Clarke', 'Client wants install before Christmas.', [L('base-cabinet', 2.1), L('wall-cabinet', 1.5)], 'production');
quickJob(designer, 'Morrison ensuite vanity', 'Kate Morrison', 'Missed on price: went with a cheaper flat-pack quote.', [L('base-cabinet', 1.2), L('shaving-cabinet-1000', 1)], 'lost');
const taylor = quickJob(owner, 'Taylor walk-in robe', 'Chris Taylor', 'Project put on hold by the client.', [L('tall-cabinet', 3.6), L('drawer', 6, /Merivo/)], 'lost');
// 0.4.0: a closed (Missed) job reopened with a reason, shown in its History.
jobs.saveJob(db, owner, company, taylor, { ...jobs.getJobDoc(db, company.id, taylor), status: 'quoting', reopenReason: 'Client back in touch after the hold; wants a revised quote for the robe.' });
quickJob(designer, 'Bennett kitchen refresh', 'Pat Bennett', '', [L('base-cabinet', 3.4), L('wall-cabinet', 2.8), L('appliance-tower', 1)], 'quoted');
quickJob(designer, 'Lee butler\'s pantry', 'Jordan Lee', 'Signed quote received.', [L('base-cabinet', 1.8), L('wall-open', 1.8)], 'won');

// 5. A price-check job on the raw-cost tier (no markup): every line's sell price equals the spreadsheet price × quantity.
jobs.createJob(db, owner, company, {
  name: 'Price check – raw cost (spreadsheet prices)', clientName: 'Internal test', tierKey: 'raw',
  notes: 'Raw cost tier = spreadsheet price with no markup. Compare each line with the spreadsheet: book price × quantity.',
  areas: [{ name: 'Spreadsheet products', type: 'other', lines: [
    L('base-cabinet', 5, /16mm White HMR/), L('wall-cabinet', 2.75, /16mm Black HMR/), L('tall-cabinet', 1.5, /- NAV Urban\s*$/),
    L('drawer', 5, /Merivo/), L('appliance-integration', 1, /Dishwasher 60cm/), L('white-hmr-laundry-chute', 1), L('bulkhead', 3.2, /Polytec Matt/),
  ] }],
});

// 5b. 0.4.0 quote layout (Vicello template): company details and logo, builder, contact, "quote is based on",
// inclusions written per area, a provisional sum (numbered 2A), "Not included in total" areas and an optional service.
// The builder, client and contact here are made up for the demo.
const logoFile = path.join(here, '..', 'docs', '2026-11-09_Rev01_Vicello-Quote-Logo.png');
const qd = await import('../server/seed/quote-defaults.js');
acct.updateCompany(db, owner, {
  name: 'Vicello', licenceNo: '339569C', quoteInclusions: qd.withCompany(qd.DEFAULT_INCLUSIONS, 'Vicello'), quoteTerms: qd.withCompany(qd.DEFAULT_TERMS, 'Vicello'), abn: '31 621 269 985', address: 'Unit 1 37-39 Stanley Rd, Ingleburn NSW 2565',
  phone: '02 4607 2696', email: 'info@vicello.com.au', website: 'vicello.com.au',
  ...(fs.existsSync(logoFile) ? { quoteLogo: `data:image/png;base64,${fs.readFileSync(logoFile).toString('base64')}` } : {}),
});
Object.assign(company, db.get('SELECT * FROM companies WHERE id = ?', company.id)); // quotes from here use the new details
const custom = (description, unitCost) => ({ moduleKey: CUSTOM_MODULE, qty: 1, description, custom: { unitCost, uom: 'EA' } });
const showcase = jobs.createJob(db, owner, company, {
  name: 'Harbour View residence – joinery package', clientName: 'Alex & Sam Rivera', siteAddress: '12 Example Street, Woolwich NSW 2110',
  builderName: 'Northshore Builders (demo)', contactDetails: 'Jordan Blake – 0400 000 000',
  quoteBasis: 'Quote is based off client provided joinery plans Revision Dated 08.09.2026 and quote presentation 08.09.2026',
  areas: [
    { name: 'FF Main Bedroom', type: 'other', notes: '*No allowance for joinery works within scope', lines: [] },
    { name: 'FF Main Bedroom Robe', type: 'wardrobe', defaultFinish: 'FG01', lines: [L('tall-cabinet', 5.03), L('tall-end-panel', 2), L('drawer', 6, /Merivo/)],
      notes: "*Doors finished in 16mm Lamitech Mondo 'RLB06PE' leather laminate G1S, Polyurethane finish to rear side – Base and Tall cabinetry\n***NOTE: Material cannot be edged,*** [blue]custom metal frame to surround not included within joinery item (itemised provisional sum)[/blue]\n*Internal carcass finished in 16mm Laminex 'Milano Walnut' Natural (including edging)\n*Overall cabinetry height up to 2340mm, with shadowline to suit builders header\n*Blum soft close hinges (silver) and Legrabox drawer runners (white)\n\n# Elevation 01 Inclusions – approx. 5030mm wide\n*1x single door tall cabinet to conceal single hanging and 3x angled shoe shelves\n*1x tall open cabinet with adjustable shelving throughout, and 1x bank of 3x drawers\n\n# Elevation 03 Inclusions\n*No allowance for full height mirror – care of builder" },
    { name: 'FF Main Bedroom Robe Metal Works Provisional Allowance', type: 'other', quoteLabel: 'provisional', lines: [custom('Aluminium angle frame, powder coated "brass-look", mitred at corners', 7936.51)],
      notes: '***The following works are provided as a provisional allowance only, and subject to reprice during pre-production phase***\n\n*Provide 20mm x 10mm x 3mm Aluminium angle to be mitred at corners and powder coated "brass-look" finish with brass screws, throughout Lamitech doors' },
    { name: 'GF Kitchen', type: 'kitchen', defaultFinish: 'FG03', lines: [L('base-cabinet', 5.5), L('wall-cabinet', 2.9), L('appliance-tower', 1), L('drawer', 6, /Merivo/), L('appliance-integration', 1, /Dishwasher 60cm/)],
      notes: '*Doors and panels finished in 18mm Polyurethane flat panel (painted single sided)\n*Internal carcass finished in 16mm White HMR with Polytec edging\n*Overall benchtop height up to 850-900mm\n\n# Elevation 01 Inclusions – approx. 5508mm wide\n*1x butlers style sink cabinet, with 1x drawer below with Blum undersink storage pull-out\n*1x integrated twin bin provision. Integrated panel fit by specialist\n**NOTE: Island details including kickboard detail to rear of Island ends, and to be discussed**' },
    { name: 'GF Laundry', type: 'laundry', notes: '*No allowance for joinery within scope', lines: [] },
    { name: 'Project Support Service', type: 'services', optional: true, lines: [custom('Project Support Service', 19047.62)],
      notes: 'A collaborative and comprehensive service to facilitate a seamless transition from Design Concept through to Manufacture.\n- Design, layout and spatial planning alterations and/or modifications\n- One preliminary site check of third-party joinery plans against site works\n! ☐ YES, I wish to engage VICELLO for Project Support Service.\n! ☐ NO, I do not wish to engage VICELLO for Project Support Service.' },
  ],
});
quotes.createQuote(db, owner, company, showcase, { revision: jobs.getJobDoc(db, company.id, showcase).revision, showItems: true });
// A company-defined status: a variation of Quoted.
const statusesSvc = await import('../server/services/statuses.service.js');
const awaiting = statusesSvc.saveStatus(db, owner, { label: 'Awaiting builder', baseStatus: 'quoted' });
statusesSvc.saveStatus(db, owner, { label: 'Revised quote requested', baseStatus: 'quoting' });
jobs.saveJob(db, owner, company, showcase, { ...jobs.getJobDoc(db, company.id, showcase), status: 'quoted', statusDetail: awaiting });

// 6. A draft price book ready to publish (3% material increase), to try "Apply Updated Pricing To Existing Jobs".
const draftId = pb.cloneBook(db, company.id, book.id, { userId: owner.id, label: 'December 2026 supplier increase (demo draft)' });
const draftBook = pb.loadBook(db, company.id, draftId);
const uplift = [];
for (const m of draftBook.modules) for (const o of m.options) if (o.material) uplift.push({ op: 'option.update', moduleKey: m.key, optionKey: o.key, fields: { material: Math.round(o.material * 1.03 * 1e6) / 1e6 } });
pb.applyChanges(db, company.id, draftId, uplift, { userId: owner.id });

seedSchedule();
console.log(`Demo company created in ${config.dataDir}`);
console.log('Sign-in details are in scripts/demo-credentials.json');
db.close();

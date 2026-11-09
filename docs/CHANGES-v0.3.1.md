# Vicello Pricing Platform 0.3.1 – change report

Two amendments only: dashboard drill-down reporting, and the price book pricing fix with a price integrity check.
No redesign, no workflow changes outside these, no new dependencies, **no database changes** (no migration).
Builds on 0.3.0 (`docs/CHANGES-v0.3.0.md`).

## 1. Amendment 2 – pricing did not match the spreadsheet: root cause and fix

### How it was investigated

Every stage was checked for one product, **"Base Cabinet - 16mm White HMR"**: spreadsheet TOTAL **$502.00**, so 5 units should be **$2,510.00**. The stages checked were:

- spreadsheet import, product mapping, stored prices and the pricing engine;
- quantity, line, area and quote totals;
- API values and on-screen formatting.

All 548 spreadsheet rows were then checked the same way. The import and storage were already exact: the stored values
equal the spreadsheet cells, with no rounding or scaling. The deviations came from five places:

| # | Cause (root cause, not display) | What the user saw (qty 5) | Fix |
|---|---|---|---|
| 1 | **Price tier markup applied on top, and the spreadsheet price was not shown anywhere on a job line.** Lines showed only "Unit" and "Total", which were sell prices including the tier markup (Retail +57.5% by default). | $3,953.25 instead of $2,510.00 | Every line now shows **Book price** (the spreadsheet price), **Book total** (quantity × book price) and **Sell**. The tier and its % are in the heading, e.g. "Sell (Retail +57.5%)". No markup is applied without being shown. |
| 2 | **The "Raw" tier was not raw.** It was copied from the old V0.1 workbook as "Raw (cost + 5%)", so even raw-cost pricing added 5%. | $2,635.50 at Raw | In the Material + Labour price book, Raw is now **"Raw cost (spreadsheet price)" at 0%**. Raw-cost lines equal the spreadsheet exactly. |
| 3 | **Product substitution when adding items.** Search and the Full Price Book added the product *family* (e.g. "Base cabinet"), and the price came from the area's default finish rather than the product the user picked. Choosing White HMR in a Woodmatt kitchen priced it at Woodmatt. | $528.00 a unit instead of $502.00 | Search and the Full Price Book now list **each spreadsheet product** (545 products) with its own book price. Choosing one adds **exactly that product**, so no area finish can replace it. The old "use this area's finish" choice is still offered, clearly labelled, for templates and area finishes. |
| 4 | **An older price book.** The demo opened on 19 October (port 4320) and any site set up with "older V0.1 price book" use the V0.1 workbook prices, not the new spreadsheet. The price check of that database found **1 of 548** products matching. | $542.00 a unit | Use the 0.3.1 demo or a new install (both use the Material + Labour price book). The new **Spreadsheet check** shows this immediately: "built from a different spreadsheet". |
| 5 | **One row's columns did not add up to its TOTAL.** Row 385 (White HMR laundry chute): TOTAL is `=SUM(D385:H385)` = $745.00, which leaves out its $130 material. The import used the columns ($875.00). | $875.00 instead of $745.00 | The spreadsheet TOTAL is now the price, for every product. Row 385 is priced at **$745.00**. The $130 is kept in the item's note, and the row is listed under "Rows to check in spreadsheet" for a decision. |

**Result:** spreadsheet price = database price = calculated quote price for all 548 products (0 mismatches). Example:
Product $12.73 × 5 = **$63.65** exactly. This is tested, along with all 548 products at 1 and 5 units.

What was not changed: the pricing engine's formula (unit cost = material + hardware + labour, × (1 + tier markup)).
Tier markups (Retail 57.5%, Builder 47%) and the 30% margin floor rule are also unchanged; they are business rules, now
always visible. Retail stays the default tier for new jobs. If new jobs should default to Raw cost instead, it is a
one-line setting in the price book's Price tiers tab ("Default").

### Price integrity check (new)

- **Price book → Spreadsheet check** (owners and admins). For every product it shows the spreadsheet price, the
  database price, and the quote price calculated by the program for 1 and 5 units with no markup. It flags price
  mismatches, products missing from the price book, products not in the spreadsheet, duplicate names, mapping problems
  and spreadsheet rows whose columns disagree with their TOTAL. It also warns if the Raw tier adds anything, or if the
  price book came from a different spreadsheet.
- It checks against the spreadsheet bundled with the program, or **any .xlsx you choose**, so a future updated
  spreadsheet can be checked before importing.
- The results can be filtered, searched and downloaded as a CSV.
- From the command line: `npm run check-prices` writes the same report as Markdown and CSV.
- **Discrepancy report for the demo:** `docs/2026-10-28_Rev01_Price-Integrity-Report.md` (and `.csv`).
  - 536 exact matches, 0 price mismatches, 0 missing, 0 extra.
  - To review: 10 rows with a duplicated name (5 names, 2 copies each), 1 unnamed row (258) and 1 row to check (385).

## 2. Amendment 1 – dashboard drill-down

The dashboard looks the same. Every figure now opens the records behind it, loaded from the server only when it is
clicked. A figure shows a light highlight when you hover over it.

| Click | Shows |
|---|---|
| Open quotes | Jobs in enquiry, quoting or quoted |
| Quoted margin | Quoted jobs with value and margin |
| Won this month | Jobs whose quote was accepted this month |
| Active jobs | Won, in production and installing jobs |
| **Win rate** | Win %, Loss %, Conversion %, Quote success rate, total quotes, jobs won, jobs lost, revenue won, revenue lost. Then **staff performance** (one row per staff member) and **team performance**, with a period filter: all time, last 12 months, this year, this month |
| Jobs won (inside Win rate) | Job, client, staff member, quote value, **award date**, status, notes |
| Jobs lost (inside Win rate) | Job, client, staff member, quote value, **date lost**, **loss reason** (declined quote and the job's notes) |
| Pipeline bars | The jobs in that status (with "Open in Jobs list" to keep the old path) |
| Pipeline by designer rows | That staff member's jobs |
| "Open jobs on older prices" | Those jobs |

Every list can be sorted by any column, filtered by typing, and shows a count and total value. Clicking a row opens
the job.

Definitions (also shown on screen):

- **Staff member** = the job's designer.
- **Won** = status Won, In production, Installing or Complete. The award date is when the quote was accepted or the
  status was first set to Won.
- **Lost** = status Lost; the date comes from the status change.
- **Win %** = won ÷ (won + lost). **Conversion %** = quoted jobs that were won.
- **Quote success rate** = accepted quotes ÷ quotes issued, not counting superseded revisions.

There is no separate "loss reason" field in the program, so the declined quote and the job's notes are shown.

## 3. Files

**Modified:**
- `shared/` — none (the pricing engine is unchanged).
- `server/` — `seed/material-labour-import.js` (TOTAL is the price; Raw tier 0%), `seed/xlsx.js` (reads uploaded
  files too), `services/reports.service.js` (drill-down data), `routes.js` (2 endpoints), `config.js` (version).
- `public/` — `js/views/dashboard.js` (figures clickable), `js/views/job-editor.js` (book price columns;
  product-level search and Full Price Book), `js/views/pricebook-editor.js` (Spreadsheet check tab), `css/app.css`.
- `scripts/` — `build-pricebook.js`, `create-demo.js` (more won/lost jobs, a raw-cost price-check job).
- `tests/` — `pricebook-import.test.js`.
- Project files — `package.json`, `package-lock.json`, `README.md`, `READ ME FIRST.txt`, `docs/DEPLOYMENT.md`.

**New:**
- `server/services/pricecheck.service.js`, `public/js/views/drilldown.js`, `scripts/check-prices.js`.
- `tests/pricecheck.test.js`, `tests/drilldown.test.js`.
- `docs/CHANGES-v0.3.1.md`, `docs/2026-10-28_Rev01_Price-Integrity-Report.md` and `.csv`,
  `docs/2026-10-28_Rev02_PriceBook-Import-Report.md`, `docs/2026-10-28_Rev02_Vicello-PriceBook-Material-Labour.json`.
- `UAT/2026-10-28_Rev02_v0.3.1-Test-Checklist.txt`.

**Removed (superseded):** `docs/2026-10-28_Rev01_PriceBook-Import-Report.md` and
`docs/2026-10-28_Rev01_Vicello-PriceBook-Material-Labour.json` (they had the +5% Raw tier and $875 for row 385).

**API added:**
- `GET /api/dashboard/drill?metric=…&period=…` (any signed-in user).
- `POST /api/price-books/:id/price-check` (owners and admins).

**Database:** no schema change.
- A **new install** gets the corrected price book automatically.
- On an install that **already published** the 0.3.0 price book, import `2026-10-28_Rev02_…json` (Price Book menu →
  Import price book file…) and publish it. Then run the Spreadsheet check. The live site is not set up yet, so it will
  simply get the corrected book.

## 4. Testing

`npm test`: **46 tests, all pass** (8 new):

| Area | What is tested |
|---|---|
| Price integrity | Product $12.73 × 5 = $63.65 at the raw tier. All 548 products: spreadsheet = database = quote, at 1 and 5 units. An uploaded copy of the spreadsheet gives the same result. A price book from another spreadsheet is flagged, and the old +5% Raw tier is called out |
| Spreadsheet-to-product matching | Every product priced at exactly its TOTAL. Duplicates, the unnamed row and row 385 are reported. Raw tier = 0% |
| Quantity and quote calculations | 5 × $502.00 = $2,510.00 at the raw tier. Decimal quantities (earlier tests still pass) |
| Drill-down | Sign-in required. Unknown figure refused. Won/lost lists with staff, value, award date, date lost and reason. Open, active, status, won-this-month and staff drill-downs. Win %, loss %, conversion %, quote success, revenue won/lost per staff member and for the team. Period filter |

Browser checks on the demo build:
- **Win rate drill-down:** 60% win, 40% loss, 42.9% conversion; per-staff and team tables shown.
- **Lost jobs:** both lost jobs listed, with reasons.
- **Pipeline bar:** sorting by quote value works both ways; count and total shown.
- **Raw-cost job:** every line equals the spreadsheet price × quantity.
- **Search:** lists individual products, and adds exactly the product chosen.
- **Spreadsheet check tab:** 0 price mismatches.
- **Errors:** none in the browser console or the server log.

Performance: drill-down data is built from a few small queries only when a figure is clicked. The dashboard itself
makes the same single request as before. The Spreadsheet check reads the 66 KB spreadsheet only when asked; it checks
548 products in about 0.2 s.

# Vicello Pricing Platform 0.3.0 – change report

Targeted amendments only. Architecture, workflows outside these amendments, layout and business rules are unchanged.
No new dependencies (still Node.js only). Previous version: 0.2.3.

## 1. What changed

### Amendment 1 – Decimal precision

- **Stored values are no longer rounded.** Price book unit rates (material, hardware, labour, trade rates, material
  reference rates) were rounded to cents when saved; they are now stored exactly as entered or imported. Quantities were
  already stored exactly.
- **Calculations** keep full precision. Only line totals and job totals are rounded, to cents (currency), as before.
  Bulk % change no longer rounds results to cents.
- **Screens never show whole-dollar amounts.** Every money figure now shows cents. This covers the dashboard, the jobs
  list, area totals, search results ("from $985.95/ea"), budget and costs, the price update and publish dialogs.
- **Quantities and hours** show at least two decimals (3 → 3.00, 2.755 → 2.755) in tables, the job summary, the
  printed quote, and in quantity and price boxes.
- **Number boxes accept any decimal.** Several boxes only allowed steps of 0.5, 0.25 or 0.1, so the browser refused
  values like 2.75. These were cost hours, the discount %, bulk change %, trade rate, tier markup, labour factor,
  GST %, margin floor % and hours per day.
- The company settings form no longer cuts GST and margin floor to one decimal when shown.

### Amendment 2 – Manual quotation workflow

- Creating a quote **no longer changes the job status** (it used to move the job to "Quoted").
- Quote status is a **dropdown set by hand**: Issued, Accepted, Declined or Superseded, in any order. It does not
  change the job, cancel calendar events or lock anything.
- Accepting a quote **no longer moves the job to Won**, and declining **no longer moves it to Lost or cancels its events**.
- Job status is changed only with the job's **Status** box. A job set to Won (or later) is locked as before, and can
  be unlocked by setting the status back.
- Nothing is emailed or sent. The program has no email function, and none was added. The quotes tab and the
  Create quote dialog now say so.
- Unchanged: quote creation, revisions, frozen snapshots and hashes, Print / Save as PDF, and marking older issued
  revisions Superseded when a new one is created. A job manually set to Lost still cancels its open calendar events,
  as before.

### Amendment 3 – Price book update

- New price book **"Material + Labour cost book (Oct 2026)"** built from `Material cost + Labour cost book pricing .xlsx`:
  **548 items** in **122 products** (29 product families with several finishes, 93 single items), 9 existing categories.
- Material, hardware and the four labour columns (factory, drafting, studio, install) are stored **exactly** per item,
  as dollars. The pricing engine was extended so an item can carry labour in dollars per trade. Older price books still
  use hours × rate.
- Item names are kept exactly as typed in the spreadsheet and are used as the quote wording.
- **Verification:** every item is re-checked against the spreadsheet, cell by cell (`npm run pricebook` and the
  automatic tests). All 548 match. The unit cost equals the spreadsheet TOTAL for every row except one reported conflict.
- **Report:** `docs/2026-10-28_Rev01_PriceBook-Import-Report.md`. It lists 12 conflicts and 5 duplicate names, plus
  2 items with no price, 5 total-only rows and notes. None were resolved automatically.
- **Delivery:** it is the default on the setup screen. For a site that is already set up, use
  `docs/2026-10-28_Rev01_Vicello-PriceBook-Material-Labour.json` with Price Book → Import price book file…
  (it imports as a draft to review and publish).
- Existing price references keep working: the existing product keys are reused (base-cabinet, wall-cabinet, drawer …),
  so area templates, area default finishes and "Update to latest prices" map onto the new items. Jobs on older price
  books keep their prices.

### Amendment 4 – Simpler setup key / first-time setup

See `docs/SETUP-OLD-VS-NEW.md`. In short: one readable key (`XXXX-XXXX-XXXX`) that stays the same until setup is
done, a clear banner in the logs, an instant **Check key** step, field-level messages, no confirm-password box, and a
"next step" message after setup. Security is kept, and wrong keys are now also throttled (5 per 15 minutes).

### Amendment 5 – Full Price Book

- Under the add-item search in every area: **Full Price Book**, with every item grouped by its category. Categories
  start collapsed and open or close with a click.
- Clicking an item adds it to the area with the same action as a search result (same `addLine`, same area finish,
  same quantity focus). The search is unchanged and works on its own.
- Categories build their item list only when first opened, and stay open after you add an item.

## 2. Files

**Modified:** `shared/pricing.js`, `server/config.js`, `server/index.js`, `server/routes.js`, `server/db/migrations.js`,
`server/seed/legacy-import.js` (exports only), `server/services/account.service.js`, `jobs.service.js`,
`pricebook.service.js`, `quotes.service.js`, `public/css/app.css`, `public/js/app.js`, `public/js/ui.js`,
`public/js/views/auth.js`, `job-editor.js`, `pricebook-editor.js`, `settings.js`, `tests/api.test.js`,
`tests/render.test.js`, `scripts/create-demo.js` (sets demo job statuses by hand), `package.json`,
`package-lock.json`, `render.yaml`, `README.md`, `READ ME FIRST.txt`.

**New:** `server/seed/xlsx.js` (spreadsheet reader), `server/seed/material-labour-import.js`,
`server/seed/source/material-labour-pricebook-2026-10.xlsx` (the client's spreadsheet, unchanged),
`server/services/setupkey.service.js`, `scripts/build-pricebook.js`, `tests/precision.test.js`,
`tests/pricebook-import.test.js`, `.env.example`, `docs/DEPLOYMENT.md`, `docs/SETUP-OLD-VS-NEW.md`,
`docs/CHANGES-v0.3.0.md`, `docs/2026-10-28_Rev01_PriceBook-Import-Report.md`,
`docs/2026-10-28_Rev01_Vicello-PriceBook-Material-Labour.json`.

## 3. Database changes and migration

Migration **3** (`server/db/migrations.js`) runs automatically on the first start of 0.3.0:

```sql
ALTER TABLE pb_options ADD COLUMN labour_cost TEXT;                      -- {"FACTORY":195,"INSTALL":50,...} dollars per unit; NULL = hours x rate as before
ALTER TABLE pb_options ADD COLUMN full_name INTEGER NOT NULL DEFAULT 0;  -- 1 = the item name is the full quote wording
```

Nothing is removed or rewritten. Money columns stay `REAL`, which holds the decimals exactly as entered.
Published price books stay locked by the existing triggers. Tested on a copy of a database with jobs, quotes, costs and
schedules: it upgraded from version 2 to 3 and all 6 jobs priced to the cent as before.
Seed data: the new price book is built from `server/seed/source/…xlsx` at setup or import time. There is no separate
seed step.

## 4. Testing summary

`npm test`: **38 tests, 38 passed** (was 28). Plus checks in a browser and a load test, described below.

| # | Area | How it was tested | Result |
|---|---|---|---|
| 1 | Decimal precision | `precision.test.js`: 2.75 LM × $32.005 = $88.01 (not $88); $140.125, $2.755, $49.995, $85.75/h saved and reloaded exactly; qty 2.755 saved and printed "2.755 LM". Browser: 2.75 LM base cabinet = $2,286.90; boxes show 1.00, 9.00 | Pass |
| 2 | Quote workflow | `api.test.js`: creating a quote leaves the job "Quoting"; quote HTML prints "4.20 LM". Browser: quote created, job status unchanged | Pass |
| 3 | Status management | `api.test.js`: quote status Accepted → Declined → Issued → Accepted, with no job change; unknown status refused; job set to Won by hand is then locked. Browser: dropdown shows "The job's status is unchanged" | Pass |
| 4 | Price book import | `pricebook-import.test.js`: all priced rows imported once; name, material, hardware and 4 labour values equal the .xlsx cells; totals match apart from the reported conflict; duplicates kept; loaded from the database unchanged; imported into an existing install as a draft, published, and an older job moved onto it with no missing items | Pass |
| 5 | Setup (registration) | `render.test.js`: readable key in logs, same key after restart, key checked on its own, case and dashes ignored, wrong key refused with a field-level message, key file deleted after setup, 6th wrong try blocked (429). `setupkey.test.js`: own `SETUP_KEY` still works. Browser: wrong key message, accepted key, weak password message, setup and sign-in | Pass |
| 6 | Full Price Book | Browser: 9 categories, all collapsed; Cabinetry opened (17 items, prices in cents); item added to the area; category stayed open; quantity box focused with 1.00 | Pass |
| 7 | Add to area | Browser: same item, finish inheritance and pricing as adding from search | Pass |
| 8 | Regression | All 28 earlier tests still pass (workbook parity, overrides, optional areas, price book locking, backups, permissions, CSRF, scheduling, reminders, Render start-up); no browser console or server errors | Pass |
| 9 | Performance | 4 users at once, 60 rounds each of open job + price book + dashboard + calendar, with saves: see below | Pass |
| 10 | Render deployment | Simulated: `render.test.js` starts the app as Render does (`RENDER=true`, `PORT`, no settings) and checks 0.0.0.0, HTTPS headers, secure cookies and setup. **Not yet deployed to your Render account**: do this with the update guide, then check the logs show 0.3.0 | Simulated pass; confirm on upload |

## 5. Performance review

Measured on this PC against a fresh 0.3.0 install with the new price book (4 users × 60 rounds, 984 requests in 1.7 s):

| Request | Median | 95th percentile |
|---|---|---|
| Open a job (priced on the server) | 12.0 ms | 16.5 ms |
| Price book (548 items) | 3.5 ms | 17.6 ms |
| Dashboard | 2.2 ms | 11.6 ms |
| Calendar (2 months) | 10.2 ms | 15.9 ms |
| Save a job | 4.2 ms | 18.6 ms |

Server memory 75 MB, CPU time 0.9 s for the whole run. Render Starter (512 MB, 0.5 CPU) has plenty of room.

Changes made for efficiency:

- **Reminders:** the bell checked the server every 60 seconds in every open tab. Now it skips hidden tabs and catches up
  when a tab is shown again. This means fewer requests when people leave the program open in the background.
- **Full Price Book:** a category's items are only built when it is first opened.
- **Search:** the "from" price now uses the pricing engine instead of a duplicate calculation.
- **Price book cache:** published price books stay cached in memory (as before). The cache key now includes the
  database file, which is a correctness fix for tests.
- No polling, background jobs or libraries were added. The only background task is still the hourly backup check.

Not changed, but noted: the price book is about 229 KB of data. It is downloaded once when a job is opened, then
reused in that tab. Compressing it would save bandwidth but cost CPU, and is not needed at this size.

## 6. Assumptions

1. **Spreadsheet columns:**
   - B = material, C = hardware, D = factory, E = drafting, F = studio, H = install, all in dollars per unit.
   - G has no heading and is empty.
   - I (TOTAL) is used to check the other columns.
   - J is kept as a note on the item. Columns K–U hold side workings (Farmers door prices, board costing). They are
     listed in the report, not imported as products.
2. **Hourly rates are used only to estimate hours** (for the job summary, budget hours and install-day sizing), never
   to price. Studio $80 and Install $85 are the existing rates. **Factory $70 and Drafting $80 are assumed**: edit them
   on the price book's Labour rates tab.
3. **Total-only rows** (4 integration services and the Hafele technician call-out) have no breakdown. Their TOTAL is
   used as a lump-sum cost and recorded under material, with a note.
4. **Grouping:**
   - Rows of the same product ("Base Cabinet - …", "Drawer - …") are the finishes of one product, as in the current
     price book. The existing product names and keys are kept, so templates and repricing still work.
   - The spreadsheet's section heading becomes the product description, e.g. "Base cabinets up to 650mm d x 900mm h".
   - Every other row is its own single item.
5. **Categories** are the existing ones, assigned by spreadsheet section with the same rules the current price book
   uses. No new categories were created.
6. **Units:**
   - Products keep their existing units: cabinets, bulkheads and panelling are LM, the rest EA.
   - Hinges and shadowline are per job, as before.
   - "Acoufelt … Priced Pm2" is per m².
7. **Price tiers, finish groups and the material reference list** are copied unchanged from the current price book
   (Retail 57.5%, Builder 47%, Raw 5%). The spreadsheet does not contain them.
8. **Conflicts were not resolved:**
   - Rows 646–650 are named "Wall Cabinet …" but are listed and priced under Tall cabinets. They were imported under
     Tall cabinet, as listed.
   - Row 258 has prices but no name. It was imported switched off.
   - The laundry chute TOTAL leaves out its $130 material. The columns were imported.
   - Rows 137 and 309 have no price. They were imported switched off.
9. **Quotes:**
   - Older issued revisions are still marked Superseded when a new revision is created. This is quote bookkeeping, not
     a job or workflow change, and staff can change it back.
   - The printed quote still has the "Accepted by / Date" signature lines for a paper sign-off. Nothing is requested
     from the client by the program. Say if you want these lines removed.
10. **Precision:** money totals (line, area, job, GST) are rounded to cents because they are currency. Every unit rate
    and quantity keeps its full value.
11. **Not changed:** adding staff logins (Settings → Users & access). The illustrated user guide (HTML/PDF from
    3 October) still describes the old setup key and "Mark accepted" steps. It needs a small refresh, not included here.

## 7. Verification checklist

| Check | Status |
|---|---|
| Prices retain two decimal places | ✅ |
| Measurements retain two decimal places | ✅ |
| No automatic rounding occurs (unit values exact; only money totals to cents) | ✅ |
| Quotes do not send emails | ✅ (no email function exists or was added) |
| Quotes do not require acceptance | ✅ |
| Job status is manually controlled | ✅ |
| Price book imports correctly (548/548 items verified) | ✅ |
| Registration process is simplified (6 steps → 4) | ✅ |
| Full price book is visible | ✅ |
| Products can be added directly from the full list | ✅ |
| Existing functionality remains intact (38/38 tests, upgrade of existing data checked) | ✅ |
| Application remains lightweight (no dependencies, 75 MB, ms responses) | ✅ |
| Efficient with 3–4 concurrent users | ✅ (4 users measured) |
| Render deployment succeeds | ⏳ Simulated locally; confirm after uploading (DEPLOYMENT.md §2) |

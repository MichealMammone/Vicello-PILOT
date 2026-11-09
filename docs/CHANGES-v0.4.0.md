# Vicello Pricing Platform 0.4.0 – change log and release notes

Release date 9 November 2026. Package `2026-11-09_Rev08_Vicello-Platform-GitHub-Upload.zip`.
Upgrades 0.2.x and 0.3.x in place. **No pricing, tax or reporting calculations were changed.**

## Summary by amendment

| # | Amendment | Result |
|---|---|---|
| 1 | KPI terminology: remove "Quotes", keep "Jobs Quoted" | Already done in 0.3.2 and re-verified. KPIs: Jobs Quoted, Jobs Won, Jobs Missed, Win %, Missed %, Revenue Won, Revenue Missed (+ Conversion %). |
| 2 | "Lost" → "Missed" everywhere | Already done in 0.3.2 and re-verified (dashboard, drill-downs, staff, filters, legends, job status). The stored value stays `lost`, so no calculation changed. Demo note wording also changed. |
| 3 | Price book update control | Already done in 0.3.2 and re-verified: "Apply Updated Pricing To Existing Jobs" with a checkbox per open job, Select all / Deselect all, nothing ticked by default, full audit. History now also shows the price book name and the sell price before → after for each job that was updated. |
| 4 | Collapsible Price Book list | The Full Price Book (since 0.3.0) sits under the item search in every area, grouped by category. It now folds away as a whole under its heading, and has **Expand all categories / Collapse all**. Each category still opens on its own; adding works exactly as before. *Note:* the live site still runs 0.2.3, which never had this list, and the list is hidden on jobs that are Won or later (they are locked). |
| 5 | Job areas and statuses; reopening | Areas: rename in the title box, by double-clicking the area in the list, or ⋯ → Rename area…. Statuses: Settings → **Job statuses** – rename any status, add your own (each counts as one of the eight main statuses), turn off, delete if unused. **Reopening** a Complete or Missed job asks for a reason; recorded with user, date, time, previous and new status. |
| 6 | Audit history | Every job save now records each change with **previous and new value**: job fields, notes, status, tier, discount, areas added/deleted/renamed, items added/deleted/changed (quantity, finish, wording, custom price, override), items moved between areas. History tab has a filter. See "Audit logging" below. |
| 7 | Workflow milestones | Settings → Workflow events: **+ Add milestone**, rename (as before), **Delete** with a warning. A milestone already on any job's schedule cannot be deleted (turn it off instead); milestones that were timed from a deleted one are re-timed automatically. |
| 8 | Quote template | The quote now follows Vicello's template (Levon Construction_Woolwich_Quote V03): logo, QUOTATION, Builder / Client name / Job # / Version / Site address / Contact # / Consultant / Date, ITEM | PRICE EX GST table, "Quote is based off…", Standard Inclusions (Included), numbered areas (1, 2, 2A…), provisional sums, "Not included in total", optional items ("OPTIONAL – Add $X + GST"), Total / GST / Total including GST, "NOTE: ALL PRICES ARE EXCLUDING GST.", Vicello's terms, definitions and payment schedule, client approval and footer on every page, page numbers. |
| 9 | Backups and test environment | Encrypted off-site backups every 15 minutes (when data changes) plus daily and monthly copies, locked against deletion; every copy checked; a copy before every upgrade and restore; restore from Settings, from the setup screen of a new site, or on a PC; a weekly automatic restore test; a TEST SITE setup. Docs: `backup-strategy.md`, `disaster-recovery.md`, `test-environment.md`. |

## Database migration (version 4)

Additive only: nothing is removed or rewritten, and existing rows and prices are untouched. The program copies the
database to `backups/…-pre-upgrade.db` before applying it.

```sql
ALTER TABLE jobs ADD COLUMN builder_name TEXT;        -- quote header: BUILDER
ALTER TABLE jobs ADD COLUMN contact_details TEXT;     -- quote header: CONTACT #
ALTER TABLE jobs ADD COLUMN quote_basis TEXT;         -- "Quote is based off …" line
ALTER TABLE jobs ADD COLUMN status_detail TEXT;       -- optional company-defined status (variation of jobs.status)
ALTER TABLE job_areas ADD COLUMN quote_label TEXT;    -- NULL = priced area, 'provisional' = provisional sum
ALTER TABLE companies ADD COLUMN licence_no TEXT;
ALTER TABLE companies ADD COLUMN quote_inclusions TEXT;
ALTER TABLE companies ADD COLUMN quote_logo TEXT;     -- small picture (data URL)
CREATE TABLE job_statuses (id, company_id, key, label, base_status, builtin, sort, active);  -- names and variations
```

`jobs.status` keeps the eight main statuses, so dashboard, win/missed rates, price locking (Won and later) and the
schedule work exactly as before; a custom status is stored beside it.

## Updated price book workflow (summary)

Price Book → open a draft → **Publish…** → choose the effective date → under **Apply Updated Pricing To Existing
Jobs** every open job (Enquiry, Quoting, Quoted) on an older price book is listed with its client and the price before
→ after. Nothing is ticked. Tick the jobs that should take the new prices (or Select all), then **Apply Selected (N)
and Publish**, or **Publish – leave all jobs unchanged**, or Cancel. Ticked jobs move to the new version; every other
job keeps its pinned version and prices (agreed prices are protected; issued quotes never change). Recorded: user,
date and time, price book version, effective date, jobs updated, jobs excluded; each job's History shows "Price book
update applied" (book before → after, sell before → after) or "Price book update not applied".

## Job reopening workflow (summary)

Complete and Missed are *closed* statuses. Choosing any other status on a closed job opens **Reopen job**: the reason
is required (Cancel puts the status back). Save the job. Recorded in the job's History as **Job reopened** with user,
date, time, previous status, new status and reason (highlighted), and in Settings → Activity log. The server refuses
a reopen without a reason, so it cannot be skipped.

## Audit logging (review and improvements)

| Required | Before 0.4.0 | 0.4.0 |
|---|---|---|
| Record creation | ✓ created / Save As / imported | ✓ unchanged |
| Item additions, deletions, modifications | revision number and total only | ✓ each item, with previous → new (qty, finish/option, wording, custom cost/unit, price override), moves between areas |
| Field changes | ✗ | ✓ job name, client name/email/phone, site address, builder, contact, quote basis, internal notes, price tier, discount and reason |
| Area changes | ✗ | ✓ added, deleted (with item count), renamed, type, finish, optional, provisional sum, area notes |
| Status changes | "from → to" code | ✓ with the company's status names, including custom statuses |
| Workflow changes | ✓ proposed / confirmed / event added, changed, removed | ✓ unchanged; milestone settings now logged with previous → new values; milestone create/delete |
| Notes added | ✗ | ✓ job notes and area notes, previous → new |
| File uploads | n/a | n/a – the platform has no file uploads (quotes are stored in the database). Restores and the quote logo are logged. |
| Job reopening | ✗ | ✓ new entry with reason |
| Price book updates | applied / kept | ✓ plus price book names and sell before → after |
| Costs | add (code, amount) / delete (id only) | ✓ add with description; delete now records what was deleted |
| Settings | whole request | ✓ each changed setting, previous → new; statuses; templates; leave deleted |
| Backups | backup, download | ✓ plus off-site run, restore checked, restore (who, source, safety copy) |

Each entry shows user, date/time, action, and previous → new values. Entries cannot be edited or deleted from the app.

## Quote template: how it maps, and limitations

| Template element | Comes from |
|---|---|
| Logo | Settings → Company & quotes → Quote logo (the VICELLO logo is supplied as `docs/2026-11-09_Rev01_Vicello-Quote-Logo.png`; without a logo the company name is printed large) |
| Builder, Contact # | job → Details → "Printed at the top of the quote" (new fields). Contact # falls back to the client phone/email |
| Client name, Site address, Job #, Consultant (the job's designer), Date (dd.mm.yyyy), Version (quote revision, 01, 02…) | the job and quote |
| "Quote is based off …" | job → Details → Quote is based on |
| Standard Inclusions / Terms | Settings → Company & quotes (filled with Vicello's wording; edit there) |
| Area text | each area's "inclusions & notes" box, with simple formatting: `# ` underlined heading, `! ` red line, `~ ` blue line, `[red]…[/red]` / `[blue]…[/blue]`, `**bold**`, `***bold italic***`, `- ` bullet. Lines starting "*No allowance" are red automatically |
| Item lines "*1x …" | the area's items (untick "List the items" when creating the quote to show only the written inclusions) |
| 2A, 2B… / Provisional sum | area → "On the quote: Provisional sum" |
| Not included in total | Optional areas, and areas with notes but no items |
| Licence #, ABN, address, P/E/W footer | Settings → Company & quotes |

Limitations: (1) The template font is Century Gothic; the quote uses it where the PC has it (Windows with Office),
otherwise a similar font. (2) The logo/details header, approval block and footer repeat on every page when printed
from Chrome or Edge (tested); other browsers may print them on the first and last page only. (3) Page breaks fall
where the content falls, so long areas can continue on the next page (with the column headings repeated), as in
Word. (4) The template's tick boxes for Project Support Service are printed as text (☐), not fillable boxes. (5) Prices
per area are the platform's calculated area totals; where a hand-written quote rounds an area (e.g. $54,950.00),
use a price override or custom item as today. (6) Quotes issued before 0.4.0 are shown in the new layout; their
contents and totals are unchanged (they have no builder/contact/basis lines). (7) The template's spelling in the terms
("Alternations", "PRODUCITON") was kept word for word; correct it in Settings if wanted.

## Backup and recovery validation results

| Check | Result |
|---|---|
| Upgrade of the real 0.3.2 demo database (10 jobs, 8 quotes) | ✓ before-upgrade copy made; version 3 → 4; stored totals changed: 0; quotes changed: 0; all old quotes render |
| Restore test on that upgraded database | ✓ integrity OK; all 10 jobs reprice to exactly their saved totals; all 8 quote reference numbers match; owner present |
| Off-site upload schedule (recent / daily 11 pm / monthly / catch-up) | ✓ automated tests against a stand-in S3 server, with Object Lock dates (30 days / 7 years) and MD5 checks |
| Request signing | ✓ matches Amazon's published Signature V4 example exactly |
| Encryption | ✓ round trip; wrong key refused; one changed byte refused |
| Restore over a running site | ✓ check first (nothing changes), owner password, safety copy, everyone signed out, data back to the backup, logged |
| Restore into a brand-new site (setup screen) | ✓ from an encrypted off-site file; users sign in with their existing passwords |
| Bad backups | ✓ non-database file and a backup from a newer version refused before anything changes |
| PC tools | ✓ `restore-test` PASSED on the upgraded demo; `restore` restored it into an empty data folder |
| Real Backblaze account, Render TEST SITE, GitHub weekly run | **not yet possible** – the accounts are created by Vicello (see `backup-strategy.md` steps 1–10 and `test-environment.md`) |

## Testing summary

- `npm test`: **72 tests, all pass** (52 existing + 20 new: statuses, reopening, history, quote template, quote
  formatting, milestones, company quote settings, on-disk checks, before-upgrade copy, encryption, off-site schedule
  and uploads, failures, restore over a site, restore into a new site, encryption key prompts, weekly restore test).
- Browser check on the 0.4.0 demo: jobs list (custom status), job editor (status list, "On the quote", Full Price
  Book collapse/expand), History (reopen with reason, previous → new), Settings → Backups & restore, reopen dialog
  and Cancel; no console errors.
- Printed the demo quote to PDF with Edge (8 pages): header, ITEM/PRICE heading, approval block, footer and page
  numbers repeat on every page. A sample is in `Work\Vicello\2026-11-09_Rev01_Demo-Quote-Vicello-Layout.pdf`.

## Modified and new files

New: `server/services/statuses.service.js`, `server/backup/s3.js`, `server/backup/restore-test.js`,
`server/seed/quote-defaults.js`, `public/js/views/restore.js`, `scripts/restore.js`, `scripts/restore-test.js`,
`scripts/offsite-backup.js`, `Restore From Backup.cmd`, `deploy/github/backup-restore-test.yml`,
`tests/amendments-v040.test.js`, `tests/backup-restore.test.js`, `docs/backup-strategy.md`,
`docs/disaster-recovery.md`, `docs/test-environment.md`, `docs/CHANGES-v0.4.0.md`,
`docs/2026-11-09_Rev01_Vicello-Quote-Logo.png`, `UAT/2026-11-09_Rev04_v0.4.0-Test-Checklist.txt`.

Changed: `server/db/migrations.js` (migration 4), `server/db/database.js` (copy before upgrade; restore support),
`server/config.js`, `server/index.js`, `server/http/http.js`, `server/routes.js`,
`server/services/{account,backup,jobs,quotes,reports,schedule}.service.js`, `public/js/{api,app,ui}.js`,
`public/js/views/{auth,dashboard,drilldown,job-editor,jobs,settings}.js`, `public/css/app.css`, `scripts/create-demo.js`,
`render.yaml`, `package.json`, `README.md`, `READ ME FIRST.txt`, `docs/DEPLOYMENT.md`.

## Backwards compatibility and production readiness

- Migration 4 is additive; existing jobs keep their exact prices (verified on real 0.3.2 data). Rolling back to 0.3.2
  is possible: it ignores the new columns (custom statuses then show as their main status).
- No new dependencies. Same start command, same disk, same environment; every new setting is optional.
- Off-site backups switch on only when their settings are added. Until then the site behaves as 0.3.2 did, and
  Settings → Backups & restore shows a clear warning.

## Still open

- Create the Backblaze account, keys and Render settings; run steps 9–10 of `backup-strategy.md`.
- Create the TEST SITE (`test-environment.md`), then put 0.4.0 on it before live.
- The live site is still 0.2.3 and not set up; 0.4.0 can go straight on (DEPLOYMENT.md).
- The illustrated user guide still describes 0.2/0.3 screens.
- From earlier: the 12 price book import questions and the assumed Factory $70 / Drafting $80 rates.

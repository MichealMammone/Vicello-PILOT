# Vicello Pricing Platform

Modular pricing, quoting and job-costing software for kitchen and joinery manufacturers. It replaces the
`Vicello_Master Job Managment Suite_V0.1.xlsx` workbook, imports its price book with matching sell prices,
and fixes the calculation errors found in the audit (material missing from "true cost", line margin using
unit cost, stacked markups, price drift between room tabs).

Runs locally on one PC or an office network today, built to move to cloud hosting later.

## Run it

Requires **Node.js 22.13 or newer** (uses Node's built-in SQLite; there are no other dependencies and no `npm install`).

- Windows: double-click **`Start Pricing Platform.cmd`**, or
- Any OS: `npm start`, then open http://localhost:4310

On first run you create the company and the **owner** account, and choose a starting price book:
the **Material + Labour cost book (October 2026)** (default), the older V0.1 Excel price book, or a small example.
When hosted, a first-time setup key is shown in the logs (see `README_FIRST.md` and `DEPLOY_TO_RENDER.md`).

What changed in 0.3.0 (decimal precision, manual quote/job statuses, new price book, simpler setup, Full Price Book):
see `docs/CHANGES-v0.3.0.md`. In 0.3.1 (dashboard drill-down; prices = spreadsheet 1:1 with a price integrity check):
see `docs/CHANGES-v0.3.1.md`. In 0.3.2 ("Missed" wording, Jobs-quoted-only KPIs, choose which open jobs take new
prices when publishing): see `docs/CHANGES-v0.3.2.md`. In 0.4.0 (quotes in Vicello's template, configurable statuses,
reopening with a reason, full change history, workflow milestones, encrypted off-site backups and restore):
see `docs/CHANGES-v0.4.0.md`, `docs/backup-strategy.md`, `docs/disaster-recovery.md`. In 0.4.1 (one simple Render Web Service, email over SMTP): see `docs/CHANGES-v0.4.1.md`.

| Setting (environment variable) | Default | Purpose |
|---|---|---|
| `PORT` | `4310` | Web port |
| `HOST` | `127.0.0.1` | `0.0.0.0` lets other PCs on the office network connect |
| `DATA_DIR` | `%LOCALAPPDATA%\JoineryPricing` | Database and backups. Kept outside OneDrive on purpose |
| `SESSION_HOURS` | `12` | Sign-in session length |
| `SECURE_COOKIES` | off | Set `1` when served over HTTPS |
| `SETUP_KEY` | generated when hosted | First-time setup key (see `.env.example` for all settings) |

## What it does

- **Jobs as documents.** File → New, Open (Ctrl+O), Save (Ctrl+S), Save As (Ctrl+Shift+S), Close,
  Export/Import job file (`.job.json`). Unsaved changes are tracked (● in the title, status bar), guarded on
  navigation and sign-out, with undo/redo (Ctrl+Z / Ctrl+Y). Saves use optimistic locking: if someone else saved
  first you are offered Save As instead of overwriting their work.
- **Unlimited areas per job**: Kitchen, Butler's, Wardrobe 1–n, Laundry, Vanity, Alfresco, etc. Start from templates,
  duplicate areas, mark areas optional (quoted as add-ons). Each area has a default finish; items inherit it unless set.
- **Live pricing** as you type (the same engine runs in the browser and on the server), margin per line,
  estimated hours by trade, and checks that block quoting: missing finish, unavailable or unpriced items,
  overrides without a reason, below-floor margins without owner/admin approval.
- **Quotes**: immutable, hashed revisions; print-ready quote page (Print / Save as PDF). Nothing is emailed.
  Quote status (issued / accepted / declined / superseded) and job status are both set by hand; neither changes
  the other. A job set to Won (or later) is locked; the budget comes from its accepted quote.
- **Full Price Book** under the add-item search in each area: every product by category at its book price,
  collapsed by default; click a product to add exactly that product. Job lines show book price, book total and sell
  (with the tier markup named).
- **Dashboard drill-down**: every figure opens the records behind it (won/lost jobs, win/loss/conversion %, revenue
  won/lost, staff and team performance), loaded on demand, sortable and filterable.
- **Spreadsheet check** (price book tab, owners/admins; `npm run check-prices`): spreadsheet vs database vs quote price
  for every product, with missing, duplicate and mapping issues.
- **Budget vs actual**: budget by cost code (board, hardware, labour by trade) from the accepted quote; record
  supplier costs and labour hours; on-track / watch / over / loss status.
- **Secure pricing area (owner/admin)**: versioned price books. Published versions are locked, enforced by
  database triggers as well as the app. Edit a draft (modules, options, finish groups, labour hours, trade rates,
  tiers, material reference), bulk % changes, review the diff, see the impact on open quotes, publish with an
  effective date. When publishing, owners/admins tick which open jobs take the new prices ("Apply Updated Pricing To
Existing Jobs"; none by default, audited); other jobs keep their pinned version until someone chooses "Update to
latest prices".
- **Scheduling, built into jobs.** Creating a job automatically proposes its workflow events: consultation,
  site inspection, check measure, install, fit-off, client walk-through, feedback session and 6-month check-in.
  Rules decide which events the job needs, each with a stated reason (e.g. no site inspection for a robe-only job;
  fit-off only when there is hardware, lighting or integration). Install length is sized from the job's estimated
  install hours, check measures from the number of areas, and dates from configurable lead times on business days.
  The engine suggests free staff of the right category and moves an event to the next day someone is free.
  Designers review on the job's **Schedule** tab (untick, re-date, re-staff, Recalculate) and **Confirm** to put
  events on the calendar. A job marked lost cancels its open events.
- **Calendar**: week, month, staff-availability (who is free / partly / fully booked / on leave over two weeks)
  and list views; drag events to another day or time, or onto another person to reassign; filter by staff, job,
  event type, status and date range; clashes (double-booking or leave) flagged everywhere; statuses pending →
  confirmed → completed; reminders via the bell (upcoming, unconfirmed, finished but not completed).
- **Resource pool**: Admin → Staff & resources (people, categories, hours per day, calendar colour, leave).
  Ten placeholder staff are generated, marked "Sample", to be replaced with the real team. Admin → Workflow events
  sets each event's rule, staff category and count, duration, lead time, start time and reminder.
- **Admin**: company details and quote terms, GST and margin floor, users and roles (owner / admin / designer),
  area templates, one-click database backups, activity log.

## Security

scrypt password hashing; random session tokens stored as SHA-256 hashes; HttpOnly SameSite=Strict cookies;
CSRF guard on every state-changing request; login throttling (5 attempts / 15 min); role checks on every API route;
no default accounts (first-run setup creates the owner); strict Content-Security-Policy; binds to localhost by default.

## Architecture

```
public/            Web app (vanilla ES modules, no build step)
  js/app.js          Shell: menu bar, command registry + shortcuts, router, unsaved-change guard
  js/views/          dashboard, jobs, job-editor, pricebooks, pricebook-editor, settings, auth
shared/pricing.js  Pricing engine: pure functions shared by browser and server
server/
  index.js           HTTP server (Node built-in), static files, CSRF, sessions
  routes.js          REST API
  services/          account, pricebook, jobs, quotes, reports, audit
  db/                SQLite wrapper (all/get/run/tx) + versioned migrations + lock triggers
  seed/              Legacy workbook import (legacy-pricebook.json → modules/options/finish groups)
tests/             node:test: engine parity with the workbook + end-to-end API tests
scripts/           dev server, demo data, backup
```

**Pricing**: unit cost = material + hardware + labour. Labour is either dollars per trade stored on the option
(the Material + Labour price book: factory, drafting, studio, install, used exactly) or Σ(module labour hours ×
trade rate) × option labour factor (older price books). Sell = cost × (1 + tier markup), applied once. Unit rates
and quantities keep every decimal; only line and job totals are rounded, to cents. Overrides need a reason.
GST is applied once on the job subtotal.

**Material + Labour import** (`server/seed/material-labour-import.js`, source spreadsheet in `server/seed/source/`):
`npm run pricebook` rebuilds the price book, re-checks every value against the spreadsheet and writes an import
file for Price Book → Import file… plus a report of duplicates and conflicts.

**Legacy import**: the workbook gave every line the same $400 of trade cost and back-solved "material" (152 of 420
lines negative). Imported options keep the exact legacy unit cost but never a negative material: material is set to 0
and the labour factor scaled instead (marked "Legacy cost"). Replace these with measured labour hours over time.
Kitchen-tab drift ($88 vs $142 White HMR base; $88 vs $450 32mm Woodmatt open wall) uses the majority value.

**Going to the cloud**: services only use the `db` interface (`all/get/run/tx`), and the SQL is portable. To host:
add a PostgreSQL adapter for `server/db/database.js`, set `HOST=0.0.0.0` and `SECURE_COOKIES=1` behind HTTPS, and run
one instance per company or use the existing `company_id` columns for multi-tenant hosting.

## Development

```
npm test              # 72 tests: 0.4.0 amendments, backups & restore, publishing control, price integrity, drill-down, precision, price book import, quotes/statuses, setup key, API, scheduling
node scripts/dev.js   # dev server on :4320 with a separate data folder (JoineryPricing-dev)
npm run demo          # load a demo company + sample jobs into the dev folder (sign-in: scripts/demo-credentials.json)
```

## Backups and restore

Settings → Backups & restore → **Back up now** writes a full, checked copy to `DATA_DIR\backups`; the program also
makes one daily and one before every database upgrade or restore. With the `OFFSITE_*` settings it uploads encrypted
copies to S3-compatible storage (Backblaze B2) every 15 minutes when data changes, plus daily and monthly copies,
locked against deletion (`docs/backup-strategy.md`). To restore: Settings → Backups & restore (a server backup, a
file or an off-site copy; checked first, owner password, safety copy), the setup screen of a new site ("Start from a
backup instead"), or `Restore From Backup.cmd` / `npm run restore <file>` on a PC with the program closed.
`npm run restore-test` runs the full restore test that GitHub Actions runs weekly.

## Known limits / next steps

- Labour hours are the legacy flat split until calibrated from timesheets (budget vs actual collects the data).
- Specific colours within a finish group (e.g. which Woodmatt decor) are not yet a field; use area notes or quote wording.
- Xero/MYOB sync, supplier CSV price import, CAD cabinet-list import and emailing quotes are planned (see blueprint).
- Reminders show inside the program (bell + toast); email/SMS reminders and calendar sync (Outlook/Google) are not built yet.
- Schedule times are local business time; the calendar's day grid shows 6am–8pm.
